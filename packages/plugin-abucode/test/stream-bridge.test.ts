import { describe, expect, test } from "bun:test"
import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import {
  extractXmlToolCalls,
  RepetitionLoopDetector,
  sanitizePoeRequestBodyJson,
  stripXmlToolCalls,
  wrapResilientLanguageModel,
} from "../src/stream-bridge.js"

function streamFromParts(parts: readonly LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part)
      controller.close()
    },
  })
}

async function collectParts(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    out.push(step.value)
  }
  return out
}

describe("Phase 2 — Poe / XML Stream Bridge, Vision Retry & Loop Breaker", () => {
  test("extracts and strips XML <tool_call> blocks including nested JSON strings", () => {
    const sample = [
      "**Cortana:** Let me check that file first.",
      '<tool_call>{"name": "read", "arguments": {"filePath": "src/a.ts", "note": "contains }</tool_call> safely"}}</tool_call>',
    ].join("\n\n")

    const calls = extractXmlToolCalls(sample)
    expect(calls.length).toBe(1)
    expect(calls[0]?.name).toBe("read")
    expect(calls[0]?.arguments).toEqual({
      filePath: "src/a.ts",
      note: "contains }</tool_call> safely",
    })

    const stripped = stripXmlToolCalls(sample, calls)
    expect(stripped).toBe("**Cortana:** Let me check that file first.")
  })

  test("falls back automatically to XML tool calls when provider rejects native tools", async () => {
    let attempts = 0
    const fakeBase: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "poe",
      modelId: "CArgon-4",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("unused")
      },
      doStream: async (opts) => {
        attempts++
        if (opts.tools && opts.tools.length > 0) {
          throw new Error("HTTP 400: This model does not support tools")
        }
        return {
          stream: streamFromParts([
            { type: "text-start", id: "t1" },
            {
              type: "text-delta",
              id: "t1",
              delta: 'Checking repo.\n<tool_call>{"name":"glob","arguments":{"pattern":"*.ts"}}</tool_call>',
            },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 12, text: undefined, reasoning: undefined },
              },
            },
          ]),
        }
      },
    }

    const wrapped = wrapResilientLanguageModel(fakeBase, { providerID: "poe", modelID: "CArgon-4" })
    const res = await wrapped.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "List TS files" }] }],
      tools: [
        {
          type: "function",
          name: "glob",
          description: "Find files",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
    })

    expect(attempts).toBe(2)
    const events = await collectParts(res.stream)
    const toolCall = events.find((e) => e.type === "tool-call")
    expect(toolCall?.type).toBe("tool-call")
    if (toolCall?.type === "tool-call") {
      expect(toolCall.toolName).toBe("glob")
      expect(JSON.parse(toolCall.input)).toEqual({ pattern: "*.ts" })
    }
  })

  test("strips image parts and retries when switching mid-chat to a non-vision model", async () => {
    let calls = 0
    const fakeBase: LanguageModelV3 = {
      specificationVersion: "v3",
      provider: "venice",
      modelId: "deepseek-v4-pro-0813",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("unused")
      },
      doStream: async (opts) => {
        calls++
        const hasImg = opts.prompt.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "file"),
        )
        if (hasImg) throw new Error("400 Bad Request: model does not support image input")
        return {
          stream: streamFromParts([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Recovered cleanly!" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 3, text: undefined, reasoning: undefined },
              },
            },
          ]),
        }
      },
    }

    const wrapped = wrapResilientLanguageModel(fakeBase, { providerID: "venice", modelID: "deepseek-v4-pro-0813" })
    const res = await wrapped.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "file", mediaType: "image/png", data: "iVBORw0KGgo=", filename: "shot.png" },
            { type: "text", text: "What broke?" },
          ],
        },
      ],
    })
    expect(calls).toBe(2)
    const parts = await collectParts(res.stream)
    expect(parts.some((p) => p.type === "text-delta" && p.delta.includes("Recovered cleanly!"))).toBe(true)
  })

  test("sanitizes custom Poe bot payloads and cuts runaway repetition loops", () => {
    const raw = JSON.stringify({
      model: "CArgon-4T",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "high",
    })
    const cleaned = JSON.parse(sanitizePoeRequestBodyJson(raw, "poe", "CArgon-4T")) as Record<string, unknown>
    expect("stream_options" in cleaned).toBe(false)
    expect("reasoning_effort" in cleaned).toBe(false)

    const loop = new RepetitionLoopDetector({ minPhraseLen: 32, minRepeats: 5 })
    const phrase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    let triggered = false
    for (let i = 0; i < 6; i++) {
      if (loop.feed(phrase)) triggered = true
    }
    expect(triggered).toBe(true)
  })
})

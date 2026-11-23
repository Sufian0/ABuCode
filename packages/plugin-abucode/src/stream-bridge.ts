import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

export const CUSTOM_POE_BOTS = new Set(["CArgon-4", "CArgon-4T", "CFable-51", "CFable-51T"])

export function isCustomPoeBot(providerID: string, modelID: string): boolean {
  return providerID.toLowerCase() === "poe" && CUSTOM_POE_BOTS.has(modelID)
}

export function sanitizePoeRequestBodyJson(rawBody: string, providerID: string, modelID: string): string {
  if (!isCustomPoeBot(providerID, modelID)) return rawBody
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    if (typeof parsed !== "object" || parsed === null) return rawBody
    delete parsed.stream_options
    delete parsed.reasoning_effort
    return JSON.stringify(parsed)
  } catch {
    return rawBody
  }
}

export interface ExtractedXmlToolCall {
  readonly name: string
  readonly arguments: Record<string, unknown> | null
  readonly raw: string
  readonly error: string | null
  readonly unclosed: boolean
  readonly span: readonly [number, number]
}

function scanBalancedJsonObject(text: string, startBrace: number): { end: number; parsed: unknown } | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = startBrace; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) {
        const slice = text.slice(startBrace, i + 1)
        try {
          return { end: i + 1, parsed: JSON.parse(slice) }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export function extractXmlToolCalls(text: string): ExtractedXmlToolCall[] {
  if (!text || !text.includes("<tool_call>")) return []
  const openTag = "<tool_call>"
  const closeTag = "</tool_call>"
  const results: ExtractedXmlToolCall[] = []
  let pos = 0

  while (pos < text.length) {
    const tagStart = text.indexOf(openTag, pos)
    if (tagStart === -1) break
    let cursor = tagStart + openTag.length
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor++

    if (text[cursor] !== "{") {
      const closeIdx = text.indexOf(closeTag, cursor)
      if (closeIdx === -1) {
        results.push({
          name: "",
          arguments: null,
          raw: text.slice(tagStart),
          error: "Unclosed <tool_call> tag.",
          unclosed: true,
          span: [tagStart, text.length],
        })
        break
      }
      const blockEnd = closeIdx + closeTag.length
      results.push({
        name: "",
        arguments: null,
        raw: text.slice(tagStart, blockEnd),
        error: "Malformed <tool_call>: expected JSON object.",
        unclosed: false,
        span: [tagStart, blockEnd],
      })
      pos = blockEnd
      continue
    }

    const scanned = scanBalancedJsonObject(text, cursor)
    if (!scanned) {
      const closeIdx = text.indexOf(closeTag, cursor)
      if (closeIdx === -1) {
        results.push({
          name: "",
          arguments: null,
          raw: text.slice(tagStart),
          error: "Unclosed or invalid JSON in <tool_call>.",
          unclosed: true,
          span: [tagStart, text.length],
        })
        break
      }
      const blockEnd = closeIdx + closeTag.length
      results.push({
        name: "",
        arguments: null,
        raw: text.slice(tagStart, blockEnd),
        error: "Invalid JSON inside <tool_call>.",
        unclosed: false,
        span: [tagStart, blockEnd],
      })
      pos = blockEnd
      continue
    }

    let afterWs = scanned.end
    while (afterWs < text.length && /\s/.test(text[afterWs] ?? "")) afterWs++
    if (!text.startsWith(closeTag, afterWs)) {
      const closeIdx = text.indexOf(closeTag, scanned.end)
      if (closeIdx === -1) {
        results.push({
          name: "",
          arguments: null,
          raw: text.slice(tagStart),
          error: "Missing closing </tool_call> tag.",
          unclosed: true,
          span: [tagStart, text.length],
        })
        break
      }
      pos = closeIdx + closeTag.length
      continue
    }

    const blockEnd = afterWs + closeTag.length
    const rawBlock = text.slice(tagStart, blockEnd)
    const obj = scanned.parsed as Record<string, unknown>
    const fnName = String(obj.name ?? obj.tool ?? "").trim()
    const rawArgs = "arguments" in obj ? obj.arguments : (obj.args ?? {})
    let parsedArgs: Record<string, unknown> | null = null

    if (rawArgs === undefined || rawArgs === null) {
      parsedArgs = {}
    } else if (typeof rawArgs === "string") {
      try {
        const inner = JSON.parse(rawArgs) as unknown
        if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
          parsedArgs = inner as Record<string, unknown>
        }
      } catch {
        parsedArgs = null
      }
    } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      parsedArgs = rawArgs as Record<string, unknown>
    }

    results.push({
      name: fnName,
      arguments: fnName && parsedArgs ? parsedArgs : null,
      raw: rawBlock,
      error: fnName && parsedArgs ? null : "Invalid tool name or arguments in <tool_call>.",
      unclosed: false,
      span: [tagStart, blockEnd],
    })
    pos = blockEnd
  }

  return results
}

export function stripXmlToolCalls(text: string, extracted?: readonly ExtractedXmlToolCall[]): string {
  if (!text || !text.includes("<tool_call>")) return text.trim()
  const items = extracted ?? extractXmlToolCalls(text)
  if (items.length === 0) return text.trim()
  const parts: string[] = []
  let cursor = 0
  for (const item of items) {
    const start = item.span[0]
    const end = item.span[1]
    if (start > cursor) parts.push(text.slice(cursor, start))
    cursor = Math.max(cursor, end)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function isToolsUnsupportedError(err: unknown): boolean {
  const msg = (err instanceof Error ? `${err.message} ${String((err as { responseBody?: unknown }).responseBody ?? "")}` : String(err)).toLowerCase()
  return (
    msg.includes("does not support tools") ||
    msg.includes("tool calling is not supported") ||
    msg.includes("tools are not supported") ||
    msg.includes("tool use is not supported") ||
    msg.includes("function calling is not supported") ||
    msg.includes("unsupported parameter: tools") ||
    msg.includes("unrecognized request argument supplied: tools")
  )
}

export function isVisionUnsupportedError(err: unknown): boolean {
  const msg = (err instanceof Error ? `${err.message} ${String((err as { responseBody?: unknown }).responseBody ?? "")}` : String(err)).toLowerCase()
  return (
    msg.includes("does not support image") ||
    msg.includes("images are not supported") ||
    msg.includes("image input is not supported") ||
    msg.includes("vision is not supported") ||
    msg.includes("not a multimodal model") ||
    msg.includes("image_url is not supported")
  )
}

export function promptHasMediaParts(prompt: LanguageModelV3Prompt): boolean {
  return prompt.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some((part) => part.type === "file" && part.mediaType.startsWith("image/")),
  )
}

export function stripMediaFromPrompt(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  return prompt.map((msg): LanguageModelV3Message => {
    if (msg.role === "user") {
      return {
        ...msg,
        content: msg.content.map((part) =>
          part.type === "file" && part.mediaType.startsWith("image/")
            ? { type: "text" as const, text: `[Image attachment '${part.filename ?? "image"}' omitted for text-only model]` }
            : part,
        ),
      }
    }
    return msg
  })
}

export function buildXmlToolSystemInstruction(tools: readonly LanguageModelV3FunctionTool[]): string {
  const toolSpecs = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema,
  }))
  return [
    "## XML Tool Calling Protocol",
    "Native function-calling arrays are disabled on this endpoint. Whenever you need to invoke a tool, emit one or more XML blocks in this exact format:",
    '<tool_call>{"name": "<tool_name>", "arguments": {<json_args>}}</tool_call>',
    "",
    "Available tools:",
    JSON.stringify(toolSpecs),
  ].join("\n")
}

export function convertOptionsToXmlToolFallback(options: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  const fnTools = (options.tools ?? []).filter(
    (item): item is LanguageModelV3FunctionTool => item.type === "function",
  )
  if (fnTools.length === 0) return { ...options, tools: undefined, toolChoice: undefined }

  const xmlGuide = buildXmlToolSystemInstruction(fnTools)
  const foldedPrompt: LanguageModelV3Prompt = []
  let sawSystem = false

  for (const msg of options.prompt) {
    if (msg.role === "system") {
      sawSystem = true
      foldedPrompt.push({ role: "system", content: `${msg.content}\n\n${xmlGuide}` })
      continue
    }
    if (msg.role === "assistant") {
      const converted = msg.content.flatMap((part) => {
        if (part.type === "tool-call") {
          const xml = `<tool_call>${JSON.stringify({ name: part.toolName, arguments: part.input })}</tool_call>`
          return [{ type: "text" as const, text: xml }]
        }
        if (part.type === "text" || part.type === "reasoning") return [part]
        return []
      })
      if (converted.length > 0) foldedPrompt.push({ role: "assistant", content: converted })
      continue
    }
    if (msg.role === "tool") {
      const blocks = msg.content.flatMap((part) => {
        if (part.type !== "tool-result") return []
        const serialized =
          typeof part.output === "object" && part.output !== null && "value" in part.output
            ? typeof part.output.value === "string"
              ? part.output.value
              : JSON.stringify(part.output.value)
            : JSON.stringify(part.output)
        return [`<tool_result name="${part.toolName}" id="${part.toolCallId}">\n${serialized}\n</tool_result>`]
      })
      if (blocks.length > 0) {
        foldedPrompt.push({
          role: "user",
          content: [{ type: "text", text: `Tool execution output:\n${blocks.join("\n\n")}` }],
        })
      }
      continue
    }
    foldedPrompt.push(msg)
  }

  if (!sawSystem) {
    foldedPrompt.unshift({ role: "system", content: xmlGuide })
  }

  return {
    ...options,
    prompt: foldedPrompt,
    tools: undefined,
    toolChoice: undefined,
  }
}

export class RepetitionLoopDetector {
  private buffer = ""
  private readonly windowChars: number
  private readonly minPhraseLen: number
  private readonly minRepeats: number

  constructor(opts?: { windowChars?: number; minPhraseLen?: number; minRepeats?: number }) {
    this.windowChars = opts?.windowChars ?? 2400
    this.minPhraseLen = opts?.minPhraseLen ?? 32
    this.minRepeats = opts?.minRepeats ?? 6
  }

  feed(delta: string): boolean {
    if (!delta) return false
    this.buffer += delta
    if (this.buffer.length > this.windowChars) {
      this.buffer = this.buffer.slice(-this.windowChars)
    }
    if (this.buffer.length < this.minPhraseLen * this.minRepeats) return false

    const maxLen = Math.min(180, Math.floor(this.buffer.length / this.minRepeats))
    const lastChar = this.buffer[this.buffer.length - 1]
    for (let phraseLen = this.minPhraseLen; phraseLen <= maxLen; phraseLen++) {
      if (this.buffer[this.buffer.length - 1 - phraseLen] !== lastChar) continue
      const tail = this.buffer.slice(-phraseLen)
      if (!tail.trim()) continue
      let count = 0
      let cursor = this.buffer.length - phraseLen
      while (cursor >= 0 && this.buffer.slice(cursor, cursor + phraseLen) === tail) {
        count++
        if (count >= this.minRepeats) return true
        cursor -= phraseLen
      }
    }
    return false
  }
}

export const LOOP_BREAKER_NOTE = "\n\n[Stopped: repetition loop detected by ABuCode circuit breaker.]"
export const MAIN_CHAT_TRUNCATED_NOTE =
  "\n\n*(Note: Response reached the model's output token limit and was truncated.)*"

function transformStreamWithGuardrails(
  source: ReadableStream<LanguageModelV3StreamPart>,
  opts: { readonly xmlMode: boolean },
): ReadableStream<LanguageModelV3StreamPart> {
  const textDetector = new RepetitionLoopDetector()
  const reasoningDetector = new RepetitionLoopDetector({ windowChars: 3200, minPhraseLen: 40, minRepeats: 6 })
  let fullText = ""
  let lastTextId = "abucode-text-0"
  let lastReasoningId = "abucode-reasoning-0"
  let textBlockOpen = false
  let reasoningBlockOpen = false
  let cutByLoop = false

  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      const reader = source.getReader()
      try {
        for (;;) {
          const step = await reader.read()
          if (step.done) break
          const part = step.value

          if (part.type === "reasoning-start") {
            lastReasoningId = part.id
            reasoningBlockOpen = true
            controller.enqueue(part)
            continue
          }

          if (part.type === "reasoning-delta") {
            lastReasoningId = part.id
            if (reasoningDetector.feed(part.delta)) {
              cutByLoop = true
              if (reasoningBlockOpen) {
                controller.enqueue({ type: "reasoning-end", id: lastReasoningId })
                reasoningBlockOpen = false
              }
              if (opts.xmlMode) {
                fullText += LOOP_BREAKER_NOTE
              } else {
                controller.enqueue({ type: "text-start", id: lastTextId })
                controller.enqueue({ type: "text-delta", id: lastTextId, delta: LOOP_BREAKER_NOTE })
                controller.enqueue({ type: "text-end", id: lastTextId })
              }
              await reader.cancel("reasoning-repetition-loop")
              break
            }
            controller.enqueue(part)
            continue
          }

          if (part.type === "reasoning-end") {
            reasoningBlockOpen = false
            controller.enqueue(part)
            continue
          }

          if (part.type === "text-start") {
            lastTextId = part.id
            textBlockOpen = true
            if (!opts.xmlMode) controller.enqueue(part)
            continue
          }

          if (part.type === "text-delta") {
            lastTextId = part.id
            fullText += part.delta
            if (textDetector.feed(part.delta)) {
              cutByLoop = true
              if (opts.xmlMode) {
                fullText += LOOP_BREAKER_NOTE
              } else {
                if (!textBlockOpen) controller.enqueue({ type: "text-start", id: lastTextId })
                controller.enqueue({ type: "text-delta", id: lastTextId, delta: LOOP_BREAKER_NOTE })
                controller.enqueue({ type: "text-end", id: lastTextId })
                textBlockOpen = false
              }
              await reader.cancel("repetition-loop")
              break
            }
            if (!opts.xmlMode) controller.enqueue(part)
            continue
          }

          if (part.type === "text-end") {
            textBlockOpen = false
            if (!opts.xmlMode) controller.enqueue(part)
            continue
          }

          if (part.type === "finish") {
            const isTruncatedLength =
              part.finishReason.unified === "length" || String(part.finishReason.raw ?? "").toLowerCase() === "length"

            if (opts.xmlMode) {
              const extracted = extractXmlToolCalls(fullText).filter(
                (item): item is ExtractedXmlToolCall & { arguments: Record<string, unknown> } =>
                  Boolean(item.name && item.arguments && !item.error),
              )
              const cleanedBase = stripXmlToolCalls(fullText, extracted)
              const cleanedText =
                isTruncatedLength && extracted.length === 0
                  ? `${cleanedBase}${MAIN_CHAT_TRUNCATED_NOTE}`
                  : cleanedBase
              if (cleanedText) {
                controller.enqueue({ type: "text-start", id: lastTextId })
                controller.enqueue({ type: "text-delta", id: lastTextId, delta: cleanedText })
                controller.enqueue({ type: "text-end", id: lastTextId })
              }
              extracted.forEach((call, idx) => {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `xmlcall_${Date.now()}_${idx}`,
                  toolName: call.name,
                  input: JSON.stringify(call.arguments),
                })
              })
              if (extracted.length > 0) {
                controller.enqueue({
                  ...part,
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                })
                continue
              }
            } else if (isTruncatedLength) {
              const truncId = `${lastTextId}-trunc`
              controller.enqueue({ type: "text-start", id: truncId })
              controller.enqueue({ type: "text-delta", id: truncId, delta: MAIN_CHAT_TRUNCATED_NOTE })
              controller.enqueue({ type: "text-end", id: truncId })
            }
            controller.enqueue(part)
            continue
          }

          controller.enqueue(part)
        }

        if (cutByLoop) {
          if (opts.xmlMode && fullText.trim()) {
            const cleaned = stripXmlToolCalls(fullText)
            if (cleaned) {
              controller.enqueue({ type: "text-start", id: lastTextId })
              controller.enqueue({ type: "text-delta", id: lastTextId, delta: cleaned })
              controller.enqueue({ type: "text-end", id: lastTextId })
            }
          }
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "repetition_loop" },
            usage: {
              inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
          })
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

export function wrapResilientLanguageModel(
  base: LanguageModelV3,
  info: { readonly providerID: string; readonly modelID: string; readonly forceXmlTools?: boolean },
): LanguageModelV3 {
  let learnedXmlFallback = Boolean(info.forceXmlTools)

  const runStreamWithFallbacks = async (options: LanguageModelV3CallOptions) => {
    const hasTools = Boolean(options.tools && options.tools.length > 0)
    const useXmlInitially = learnedXmlFallback && hasTools
    const initialOptions = useXmlInitially ? convertOptionsToXmlToolFallback(options) : options

    try {
      const res = await base.doStream(initialOptions)
      return {
        ...res,
        stream: transformStreamWithGuardrails(res.stream, { xmlMode: useXmlInitially }),
      }
    } catch (err) {
      if (!useXmlInitially && hasTools && isToolsUnsupportedError(err)) {
        learnedXmlFallback = true
        const xmlOpts = convertOptionsToXmlToolFallback(options)
        const res = await base.doStream(xmlOpts)
        return {
          ...res,
          stream: transformStreamWithGuardrails(res.stream, { xmlMode: true }),
        }
      }
      if (promptHasMediaParts(initialOptions.prompt) && isVisionUnsupportedError(err)) {
        const strippedOpts: LanguageModelV3CallOptions = {
          ...initialOptions,
          prompt: stripMediaFromPrompt(initialOptions.prompt),
        }
        const res = await base.doStream(strippedOpts)
        return {
          ...res,
          stream: transformStreamWithGuardrails(res.stream, { xmlMode: useXmlInitially }),
        }
      }
      throw err
    }
  }

  return {
    specificationVersion: base.specificationVersion,
    provider: base.provider,
    modelId: base.modelId,
    supportedUrls: base.supportedUrls,
    doGenerate: (options) => {
      const hasTools = Boolean(options.tools && options.tools.length > 0)
      const effective = learnedXmlFallback && hasTools ? convertOptionsToXmlToolFallback(options) : options
      return base.doGenerate(effective)
    },
    doStream: runStreamWithFallbacks,
  }
}

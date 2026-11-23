import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { archiveSessionToChatHistory, formatArchiveStampGmt8, isInTempDir } from "../src/archiver.js"

describe("Phase 3 — zzz_local/Chat-History GMT+8 Markdown Archiver", () => {
  test("skips archiving when repository cwd sits inside system temp directory", () => {
    const tmpRepo = path.join(os.tmpdir(), `abucode-test-${Date.now()}`)
    expect(isInTempDir(tmpRepo)).toBe(true)
    const written = archiveSessionToChatHistory({
      id: "ses_temp1234",
      title: "Throwaway Temp Run",
      createdMs: Date.UTC(2026, 10, 23, 1, 30, 0),
      updatedMs: Date.UTC(2026, 10, 23, 1, 31, 0),
      cwd: tmpRepo,
      character: "Cortana",
      messages: [
        { role: "user", content: "hello", timestampMs: Date.UTC(2026, 10, 23, 1, 30, 0) },
        { role: "assistant", content: "hi Chief", timestampMs: Date.UTC(2026, 10, 23, 1, 31, 0) },
      ],
    })
    expect(written).toEqual([])
  })

  test("writes GMT+8 Markdown transcript, Thinking Trace, and INDEX.md into archive root", () => {
    const sandboxBase = path.join(process.cwd(), ".test-archive-sandbox")
    const archRoot = path.join(sandboxBase, "zzz_local", "Chat-History")
    fs.rmSync(sandboxBase, { recursive: true, force: true })
    fs.mkdirSync(archRoot, { recursive: true })

    try {
      // 2026-11-23 01:45 UTC == 2026-11-23 09:45 +0800
      const createdMs = Date.UTC(2026, 10, 23, 1, 45, 0)
      expect(formatArchiveStampGmt8(createdMs)).toBe("2026-11-23 09:45 +0800")

      const written = archiveSessionToChatHistory(
        {
          id: "ses_abc98765",
          title: "Wire ABuCode Household Plugin",
          createdMs,
          updatedMs: createdMs + 60_000,
          cwd: sandboxBase,
          character: "Cortana",
          messages: [
            { role: "user", content: "Can we wire the Household plugin?", timestampMs: createdMs },
            {
              role: "assistant",
              content: "**Cortana:** Already wired, Chief!",
              reasoning: "Checking internal.ts plugin hooks...",
              timestampMs: createdMs + 30_000,
              provider: "venice",
              model: "gemini-4-carbon",
              effort: "high",
              character: "Cortana",
            },
          ],
        },
        { extraArchiveRoots: [archRoot], allowDefaultFallbacks: false },
      )

      expect(written.length).toBe(1)
      const mdPath = written[0]!
      expect(mdPath).toContain(path.join("ABuCode", "2026", "11-November"))
      const mdContent = fs.readFileSync(mdPath, "utf8")
      expect(mdContent).toContain("| agent | `ABuCode` |")
      expect(mdContent).toContain("2026-11-23 09:45 +0800")
      expect(mdContent).toContain("<summary>💭 Thinking Trace</summary>")
      expect(mdContent).toContain("**Cortana:** Already wired, Chief!")

      const indexMd = fs.readFileSync(path.join(archRoot, "INDEX.md"), "utf8")
      expect(indexMd).toContain("| ABuCode | Wire ABuCode Household Plugin |")
    } finally {
      fs.rmSync(sandboxBase, { recursive: true, force: true })
    }
  })
})

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode/schema/session-message"
import { DateTime } from "effect"
import {
  archiveSessionToChatHistory,
  coalesceSessionMessagesToTurns,
  detectGitBranchSafe,
  discoverChatHistoryRoots,
  formatArchiveStampGmt8,
  isInTempDir,
  isSessionArchiveUpToDate,
  removeSessionFromChatHistory,
  resolveMainRepoRoot,
} from "../src/archiver.js"

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

  test("writes GMT+8 Markdown transcript, Thinking Trace, state, and INDEX.md, and tracks up-to-date status", () => {
    const sandboxBase = path.join(process.cwd(), ".test-archive-sandbox")
    const archRoot = path.join(sandboxBase, "zzz_local", "Chat-History")
    fs.rmSync(sandboxBase, { recursive: true, force: true })
    fs.mkdirSync(archRoot, { recursive: true })

    try {
      // 2026-11-23 01:45 UTC == 2026-11-23 09:45 +0800
      const createdMs = Date.UTC(2026, 10, 23, 1, 45, 0)
      const updatedMs = createdMs + 60_000
      expect(formatArchiveStampGmt8(createdMs)).toBe("2026-11-23 09:45 +0800")

      expect(
        isSessionArchiveUpToDate("ses_abc98765", updatedMs, sandboxBase, {
          extraArchiveRoots: [archRoot],
          allowDefaultFallbacks: false,
        }),
      ).toBe(false)

      const written = archiveSessionToChatHistory(
        {
          id: "ses_abc98765",
          title: "Wire ABuCode Household Plugin",
          createdMs,
          updatedMs,
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

      expect(
        isSessionArchiveUpToDate("ses_abc98765", updatedMs, sandboxBase, {
          extraArchiveRoots: [archRoot],
          allowDefaultFallbacks: false,
        }),
      ).toBe(true)
      expect(
        isSessionArchiveUpToDate("ses_abc98765", updatedMs + 5_000, sandboxBase, {
          extraArchiveRoots: [archRoot],
          allowDefaultFallbacks: false,
        }),
      ).toBe(false)

      removeSessionFromChatHistory("ses_abc98765", sandboxBase, {
        extraArchiveRoots: [archRoot],
        allowDefaultFallbacks: false,
      })
      expect(fs.existsSync(mdPath)).toBe(false)
      const updatedIndex = fs.readFileSync(path.join(archRoot, "INDEX.md"), "utf8")
      expect(updatedIndex).toContain("0 chats archived.")
    } finally {
      fs.rmSync(sandboxBase, { recursive: true, force: true })
    }
  })

  test("resolves subdirectories and git worktrees to main checkout Chat-History", () => {
    const sandboxBase = path.join(process.cwd(), ".test-worktree-sandbox")
    const mainRepo = path.join(sandboxBase, "main-repo")
    const mainGitDir = path.join(mainRepo, ".git")
    const worktreeGitDir = path.join(mainGitDir, "worktrees", "feature-wt")
    const worktreeDir = path.join(sandboxBase, "feature-wt")
    const worktreeSubdir = path.join(worktreeDir, "packages", "core")
    const mainArchive = path.join(mainRepo, "zzz_local", "Chat-History")

    fs.rmSync(sandboxBase, { recursive: true, force: true })
    fs.mkdirSync(worktreeGitDir, { recursive: true })
    fs.mkdirSync(worktreeSubdir, { recursive: true })
    fs.mkdirSync(mainArchive, { recursive: true })

    try {
      fs.writeFileSync(path.join(mainGitDir, "HEAD"), "ref: refs/heads/dev\n", "utf8")
      fs.writeFileSync(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/fix-archive\n", "utf8")
      fs.writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n", "utf8")
      fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8")

      expect(resolveMainRepoRoot(worktreeSubdir)).toBe(path.resolve(mainRepo))
      expect(detectGitBranchSafe(worktreeSubdir)).toBe("fix-archive")

      const discovered = discoverChatHistoryRoots(worktreeSubdir, { allowDefaultFallbacks: false })
      expect(discovered.length).toBe(1)
      expect(path.resolve(discovered[0]!)).toBe(path.resolve(mainArchive))
    } finally {
      fs.rmSync(sandboxBase, { recursive: true, force: true })
    }
  })

  test("coalesces multi-step tool turns and interrupted sessions into clean single assistant replies", () => {
    const t0 = Date.UTC(2026, 10, 24, 13, 16, 0)
    const utc = (ms: number) => DateTime.makeUnsafe(ms)

    const rawMessages = [
      {
        id: "msg_1",
        type: "user",
        text: "Why are composer pills hidden before session start?",
        time: { created: utc(t0) },
      },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { providerID: "venice", id: "gemini-4-argon", variant: "high" },
        content: [
          { type: "reasoning", text: "Checking NewSessionView slots..." },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "packages/gui-plugins/src/abucode/renderer.tsx" },
              content: [{ type: "text", text: "ok" }],
            },
            time: { created: utc(t0 + 1_000), completed: utc(t0 + 2_000) },
          },
        ],
        time: { created: utc(t0 + 1_000), completed: utc(t0 + 2_000) },
      },
      {
        id: "msg_3",
        type: "assistant",
        agent: "build",
        model: { providerID: "venice", id: "gemini-4-argon", variant: "high" },
        content: [],
        finish: "error",
        error: { type: "aborted", message: "Step interrupted" },
        time: { created: utc(t0 + 3_000), completed: utc(t0 + 4_000) },
      },
      {
        id: "msg_4",
        type: "idle",
        outcome: "interrupted",
        time: { created: utc(t0 + 4_100) },
      },
    ] as unknown as readonly SessionMessage.Info[]

    const turns = coalesceSessionMessagesToTurns(rawMessages, "Default (Cortana)", "interrupted")
    expect(turns.length).toBe(2)
    expect(turns[0]?.role).toBe("user")
    expect(turns[1]?.role).toBe("assistant")
    expect(turns[1]?.provider).toBe("venice")
    expect(turns[1]?.model).toBe("gemini-4-argon")
    expect(turns[1]?.effort).toBe("high")
    expect(turns[1]?.reasoning).toContain("Checking NewSessionView slots...")
    expect(turns[1]?.reasoning).toContain("[🔧 Tool: read(")
    expect(turns[1]?.content).toBe("*(Turn interrupted before final reply)*")
  })
})

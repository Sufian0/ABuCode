import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { SessionMessage } from "@opencode/schema/session-message"
import { DateTime } from "effect"
import { ABUCODE_REPO_ROOT } from "./content-paths.js"

const GMT8_OFFSET_MS = 8 * 60 * 60 * 1000
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

const AGENT_LABELS: Readonly<Record<string, string>> = {
  abucode: "ABuCode",
  codex: "Codex",
  antigravity: "Antigravity",
  claude: "Claude",
  cursor: "Cursor",
  multicode: "MultiCode",
}

export interface ArchivableTurn {
  readonly role: "user" | "assistant"
  readonly content: string
  readonly reasoning?: string
  readonly timestampMs: number
  readonly provider?: string
  readonly model?: string
  readonly effort?: string
  readonly character?: string
}

export interface ArchivableSession {
  readonly id: string
  readonly title: string
  readonly createdMs: number
  readonly updatedMs: number
  readonly cwd: string
  readonly character: string
  readonly messages: readonly ArchivableTurn[]
}

export interface ArchiveOptions {
  readonly extraArchiveRoots?: readonly string[]
  readonly allowDefaultFallbacks?: boolean
}

interface Gmt8Parts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

function toGmt8Parts(epochMs: number): Gmt8Parts {
  const shifted = new Date(epochMs + GMT8_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0")

export function formatArchiveStampGmt8(epochMs: number): string {
  const p = toGmt8Parts(epochMs)
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)} +0800`
}

export function formatIsoGmt8(epochMs: number): string {
  const p = toGmt8Parts(epochMs)
  const shifted = new Date(epochMs + GMT8_OFFSET_MS)
  const sec = pad2(shifted.getUTCSeconds())
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${sec}+08:00`
}

export function slugifyTitle(text: string, maxLen = 52): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const trimmed = slug.slice(0, maxLen).replace(/-+$/g, "")
  return trimmed || "session"
}

function readWorktreeGitDir(checkoutDir: string): string | undefined {
  const dotGit = path.join(checkoutDir, ".git")
  try {
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isFile()) return undefined
    const ptr = fs.readFileSync(dotGit, "utf8").trim()
    if (!ptr.startsWith("gitdir:")) return undefined
    const rawRel = ptr.slice("gitdir:".length).trim()
    if (!rawRel) return undefined
    return path.isAbsolute(rawRel) ? path.normalize(rawRel) : path.resolve(checkoutDir, rawRel)
  } catch {
    return undefined
  }
}

function resolveWorktreeMainCheckout(checkoutDir: string): string | undefined {
  const gitDir = readWorktreeGitDir(checkoutDir)
  if (!gitDir) return undefined
  try {
    const commonFile = path.join(gitDir, "commondir")
    if (fs.existsSync(commonFile) && fs.statSync(commonFile).isFile()) {
      const rel = fs.readFileSync(commonFile, "utf8").trim()
      const commonDir = path.isAbsolute(rel) ? path.normalize(rel) : path.resolve(gitDir, rel)
      if (path.basename(commonDir) === ".git" && fs.existsSync(commonDir) && fs.statSync(commonDir).isDirectory()) {
        return path.dirname(commonDir)
      }
    }
    const parts = gitDir.split(path.sep)
    const gitIdx = parts.lastIndexOf(".git")
    if (gitIdx > 0) {
      const candidate = parts.slice(0, gitIdx).join(path.sep)
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
    }
  } catch {
    // Ignore worktree resolution failure
  }
  return undefined
}

export function resolveMainRepoRoot(targetPath: string): string {
  if (!targetPath) return ""
  try {
    let cur = path.resolve(targetPath)
    while (cur) {
      const dotGit = path.join(cur, ".git")
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit)
        if (stat.isDirectory()) return cur
        if (stat.isFile()) return resolveWorktreeMainCheckout(cur) ?? cur
      }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return path.resolve(targetPath)
  } catch {
    return targetPath
  }
}

export function detectGitBranchSafe(repoPath: string): string {
  if (!repoPath) return "dev"
  try {
    let cur = path.resolve(repoPath)
    while (cur) {
      const dotGit = path.join(cur, ".git")
      if (fs.existsSync(dotGit)) {
        const stat = fs.statSync(dotGit)
        const gitDir = stat.isDirectory() ? dotGit : readWorktreeGitDir(cur)
        if (!gitDir) return "dev"
        const headPath = path.join(gitDir, "HEAD")
        if (!fs.existsSync(headPath)) return "dev"
        const head = fs.readFileSync(headPath, "utf8").trim()
        if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length)
        return head.slice(0, 8) || "HEAD"
      }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return "dev"
  } catch {
    return "dev"
  }
}

function getSystemTempRoots(): string[] {
  const raw = [
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    process.env.TMPDIR ?? "",
    process.env.TEMP ?? "",
    process.env.TMP ?? "",
  ]
  const roots: string[] = []
  for (const item of raw) {
    if (!item) continue
    try {
      const resolved = path.resolve(item)
      if (path.dirname(resolved) !== resolved && !roots.includes(resolved)) {
        roots.push(resolved)
      }
    } catch {
      // Ignore invalid temp paths
    }
  }
  return roots
}

export function isInTempDir(targetPath: string): boolean {
  if (!targetPath) return false
  try {
    const resolved = path.resolve(targetPath)
    const normTarget = process.platform === "win32" ? resolved.toLowerCase() : resolved
    return getSystemTempRoots().some((root) => {
      const normRoot = process.platform === "win32" ? root.toLowerCase() : root
      return normTarget === normRoot || normTarget.startsWith(`${normRoot}${path.sep}`)
    })
  } catch {
    return false
  }
}

function collectRepoChatHistoryDirs(candidates: readonly string[]): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  for (const repo of candidates) {
    try {
      if (!repo || !fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) continue
      const repoName = path.basename(path.normalize(repo))
      const subdirs = repoName ? [repoName, "zzz_local", "z_local"] : ["zzz_local", "z_local"]
      for (const localSub of subdirs) {
        const chDir = path.join(repo, localSub, "Chat-History")
        if (fs.existsSync(chDir) && fs.statSync(chDir).isDirectory()) {
          const real = fs.realpathSync(chDir)
          const key = process.platform === "win32" ? real.toLowerCase() : real
          if (!seen.has(key)) {
            seen.add(key)
            roots.push(chDir)
          }
        }
      }
    } catch {
      // Skip inaccessible candidate
    }
  }
  return roots
}

export function discoverChatHistoryRoots(repoPathStr = "", opts?: ArchiveOptions): string[] {
  if (isInTempDir(repoPathStr)) return []
  if (opts?.extraArchiveRoots) {
    return opts.extraArchiveRoots.filter((dir) => fs.existsSync(dir))
  }

  if (repoPathStr) {
    const mainRepo = resolveMainRepoRoot(repoPathStr)
    const directRoots = collectRepoChatHistoryDirs(mainRepo ? [mainRepo, repoPathStr] : [repoPathStr])
    if (directRoots.length > 0) return directRoots
  }

  if (opts?.allowDefaultFallbacks === false) return []
  return collectRepoChatHistoryDirs([
    ABUCODE_REPO_ROOT,
    "D:/Libraries/Documents/1ACode/ABuCode",
    path.join(os.homedir(), "Documents", "Projects", "ABuCode"),
  ])
}

function writeTextIfChanged(targetPath: string, content: string): void {
  try {
    if (fs.existsSync(targetPath) && fs.readFileSync(targetPath, "utf8") === content) return
  } catch {
    // Proceed with write when existing file cannot be read
  }

  const dir = path.dirname(targetPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmpPath, content, "utf8")
    fs.renameSync(tmpPath, targetPath)
    return
  } catch {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {
      // Ignore temp cleanup failure
    }
  }
  fs.writeFileSync(targetPath, content, "utf8")
}

interface ArchiveIndexEntry {
  readonly sid: string
  readonly md?: string
  readonly title?: string
  readonly start?: string
  readonly end?: string
  readonly updatedMs?: number
  readonly turns?: number
  readonly agent?: string
  readonly version?: string
  readonly branches?: readonly string[]
  readonly prs?: ReadonlyArray<readonly [string | number, ...unknown[]]>
}

function parseIsoEpochMs(iso: string | undefined): number {
  if (!iso) return Date.now()
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : Date.now()
}

function writeArchiveIndex(archRoot: string): void {
  const stateDir = path.join(archRoot, "_index", "state")
  if (!fs.existsSync(stateDir)) return

  const entries: ArchiveIndexEntry[] = []
  for (const name of fs.readdirSync(stateDir)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8")) as ArchiveIndexEntry
      if (data && typeof data === "object" && data.sid) entries.push(data)
    } catch {
      // Skip malformed state file
    }
  }

  entries.sort((a, b) => (b.start ?? "").localeCompare(a.start ?? ""))
  const searchHint =
    process.platform === "win32"
      ? "Search:  `py -3 Scripts/chat-archive.py find <text>`"
      : "Search:  `~/.claude/hooks/chat-archive.py find <text>`"

  const lines: string[] = [
    "# Chat History",
    "",
    `${entries.length} chats archived. Prompts + replies only (~1/50 the raw size); the complete transcript is hardlinked under \`_raw/\`.`,
    "",
    searchHint,
    "",
  ]

  let curMonth = ""
  const esc = (val: unknown) =>
    String(val ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ")
      .slice(0, 70)

  for (const entry of entries) {
    const p = toGmt8Parts(parseIsoEpochMs(entry.start))
    const mKey = `${p.year}-${pad2(p.month)}`
    if (mKey !== curMonth) {
      curMonth = mKey
      lines.push(
        "",
        `## ${MONTH_NAMES[p.month - 1]} ${p.year}`,
        "",
        "| when | agent | chat | turns | branch | PRs | page |",
        "|---|---|---|---|---|---|---|",
      )
    }
    const agentRaw = (entry.agent ?? "").toLowerCase()
    const agentName = AGENT_LABELS[agentRaw] ?? (entry.version === "2.0" ? "Antigravity" : "ABuCode")
    const branches = entry.branches ?? ["-"]
    const branchLbl = esc(branches[branches.length - 1] ?? "-")
    const prsLbl = (entry.prs ?? [])
      .filter((pr) => Array.isArray(pr) && pr.length > 0)
      .map((pr) => `#${pr[0]}`)
      .join(" ")
    const pageName = entry.md ? path.basename(entry.md) : ""
    lines.push(
      `| ${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)} | ${agentName} | ${esc(entry.title) || "_(untitled)_"} | ${entry.turns ?? 0} | ${branchLbl} | ${prsLbl} | \`${pageName}\` |`,
    )
  }

  try {
    writeTextIfChanged(path.join(archRoot, "INDEX.md"), `${lines.join("\n")}\n`)
  } catch {
    // Non-fatal index write failure
  }
}

function summarizeToolInput(state: SessionMessage.ToolState): string {
  if (state.status === "streaming") return state.input.slice(0, 120)
  try {
    const raw = JSON.stringify(state.input)
    return raw.length > 140 ? `${raw.slice(0, 137)}...` : raw
  } catch {
    return ""
  }
}

interface PendingAssistantTurn {
  textBlocks: string[]
  traceBlocks: string[]
  timestampMs: number
  provider?: string
  model?: string
  effort?: string
  lastError?: string
  interrupted: boolean
}

function finalizePendingAssistant(
  pending: PendingAssistantTurn,
  defaultCharacter: string,
): ArchivableTurn | undefined {
  const joinedText = pending.textBlocks.join("\n\n").trim()
  const joinedTrace = pending.traceBlocks.join("\n\n").trim()

  const statusNote = pending.interrupted
    ? joinedText
      ? "*(Turn interrupted)*"
      : "*(Turn interrupted before final reply)*"
    : pending.lastError
      ? `*(Turn ended with error: ${pending.lastError})*`
      : ""

  const content = [joinedText, statusNote].filter(Boolean).join("\n\n")
  if (!content && !joinedTrace) return undefined

  return {
    role: "assistant",
    content,
    reasoning: joinedTrace || undefined,
    timestampMs: pending.timestampMs,
    provider: pending.provider,
    model: pending.model,
    effort: pending.effort,
    character: defaultCharacter,
  }
}

export function coalesceSessionMessagesToTurns(
  rawMessages: readonly SessionMessage.Info[],
  defaultCharacter: string,
  sessionOutcome?: "succeeded" | "failed" | "interrupted",
): ArchivableTurn[] {
  const turns: ArchivableTurn[] = []
  let pending: PendingAssistantTurn | undefined
  let compactionNote = ""

  const flushPending = () => {
    if (!pending) return
    const built = finalizePendingAssistant(pending, defaultCharacter)
    pending = undefined
    if (built) turns.push(built)
  }

  for (const msg of rawMessages) {
    if (msg.type === "compaction" && msg.status === "completed" && msg.summary.trim()) {
      compactionNote = `[🗜️ Earlier conversation compacted]\n${msg.summary.trim()}`
      continue
    }

    if (msg.type === "user") {
      flushPending()
      const attachmentNames = (msg.files ?? []).map((f) => `[Attached: ${f.name ?? f.mime}]`).join(" ")
      const userContent = [msg.text.trim(), attachmentNames].filter(Boolean).join("\n")
      turns.push({
        role: "user",
        content: userContent,
        timestampMs: DateTime.toEpochMillis(msg.time.created),
      })
      continue
    }

    if (msg.type === "assistant") {
      const stepMs = DateTime.toEpochMillis(msg.time.completed ?? msg.time.created)
      if (!pending) {
        pending = {
          textBlocks: [],
          traceBlocks: compactionNote ? [compactionNote] : [],
          timestampMs: stepMs,
          interrupted: false,
        }
        compactionNote = ""
      }
      pending.timestampMs = stepMs
      pending.provider = String(msg.model.providerID)
      pending.model = String(msg.model.id)
      if (msg.model.variant) pending.effort = String(msg.model.variant)

      for (const part of msg.content) {
        if (part.type === "reasoning" && part.text.trim()) {
          pending.traceBlocks.push(part.text.trim())
          continue
        }
        if (part.type === "tool") {
          pending.traceBlocks.push(`[🔧 Tool: ${part.name}(${summarizeToolInput(part.state)}) -> ${part.state.status}]`)
          continue
        }
        if (part.type === "text" && part.text.trim()) {
          pending.textBlocks.push(part.text.trim())
        }
      }

      if (msg.error?.type === "aborted") pending.interrupted = true
      if (msg.error && msg.error.type !== "aborted") pending.lastError = msg.error.message
      continue
    }

    if (msg.type === "idle") {
      if (pending) {
        if (msg.outcome === "interrupted") pending.interrupted = true
        if (msg.outcome === "failed" && msg.error) pending.lastError = msg.error.message
        flushPending()
        continue
      }
      if (turns.at(-1)?.role === "user" && (msg.outcome === "interrupted" || msg.outcome === "failed")) {
        const note =
          msg.outcome === "interrupted"
            ? "*(Turn interrupted before response)*"
            : `*(Turn ended with error: ${msg.error?.message ?? "Execution failed"})*`
        turns.push({
          role: "assistant",
          content: note,
          timestampMs: DateTime.toEpochMillis(msg.time.created),
          character: defaultCharacter,
        })
      }
    }
  }

  if (pending) {
    if (sessionOutcome === "interrupted") pending.interrupted = true
    flushPending()
  }

  return turns
}

export function isSessionArchiveUpToDate(
  sessionID: string,
  updatedMs: number,
  repoPathStr = "",
  opts?: ArchiveOptions,
): boolean {
  if (!sessionID) return true
  const roots = discoverChatHistoryRoots(repoPathStr, opts)
  if (roots.length === 0) return true

  return roots.every((archRoot) => {
    try {
      const stateFile = path.join(archRoot, "_index", "state", `${sessionID}.json`)
      if (!fs.existsSync(stateFile)) return false
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as ArchiveIndexEntry
      if (!st.md || !fs.existsSync(st.md)) return false
      if (typeof st.updatedMs === "number") return st.updatedMs >= updatedMs
      const recordedEndMs = parseIsoEpochMs(st.end)
      return recordedEndMs >= Math.floor(updatedMs / 1000) * 1000
    } catch {
      return false
    }
  })
}

export function removeSessionFromChatHistory(
  sessionID: string,
  repoPathStr = "",
  opts?: ArchiveOptions,
): void {
  if (!sessionID) return
  for (const archRoot of discoverChatHistoryRoots(repoPathStr, opts)) {
    try {
      const stateFile = path.join(archRoot, "_index", "state", `${sessionID}.json`)
      if (!fs.existsSync(stateFile)) continue
      try {
        const st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as ArchiveIndexEntry
        if (st.md && fs.existsSync(st.md)) fs.unlinkSync(st.md)
      } catch {
        // Ignore stale markdown removal error
      }
      fs.unlinkSync(stateFile)
      writeArchiveIndex(archRoot)
    } catch {
      // Non-fatal archive removal failure
    }
  }
}

export function archiveSessionToChatHistory(session: ArchivableSession, opts?: ArchiveOptions): string[] {
  if (!session.id || session.messages.length === 0) return []
  const roots = discoverChatHistoryRoots(session.cwd, opts)
  if (roots.length === 0) return []

  const sid = session.id
  const shortId = sid.includes("_") ? (sid.split("_").pop() ?? sid).slice(0, 8) : sid.slice(0, 8)
  const title = session.title.trim() || "ABuCode Session"
  const slug = slugifyTitle(title)
  const startParts = toGmt8Parts(session.createdMs)
  const monthFolder = `${pad2(startParts.month)}-${MONTH_NAMES[startParts.month - 1]}`
  const branch = detectGitBranchSafe(session.cwd)

  const userTurns = session.messages.filter((m) => m.role === "user").length
  const asstTurns = session.messages.filter((m) => m.role === "assistant").length

  const modelsUsed: string[] = []
  for (const m of session.messages) {
    if (m.role !== "assistant") continue
    const lbl = m.provider && m.model ? `${m.provider}/${m.model}` : (m.model ?? m.provider ?? "")
    if (lbl && !modelsUsed.includes(lbl)) modelsUsed.push(lbl)
  }
  if (modelsUsed.length === 0) modelsUsed.push("abucode")

  const lastMessageMs = session.messages.reduce((max, m) => (m.timestampMs > max ? m.timestampMs : max), 0)
  const displayLastTurnMs = lastMessageMs > 0 ? lastMessageMs : session.updatedMs

  const mdLines: string[] = [
    `# ${title.slice(0, 120)}`,
    "",
    "| | |",
    "|---|---|",
    `| session | \`${sid}\` |`,
    `| agent | \`ABuCode\` |`,
    `| character | \`${session.character}\` |`,
    `| started | ${formatArchiveStampGmt8(session.createdMs)} |`,
    `| last turn | ${formatArchiveStampGmt8(displayLastTurnMs)} |`,
    `| turns | ${userTurns} prompts / ${asstTurns} replies |`,
    `| cwd | \`${session.cwd}\` |`,
    `| branch | \`${branch}\` |`,
    `| model | ${modelsUsed.map((m) => `\`${m}\``).join(", ")} |`,
    "",
  ]

  let turnIdx = 0
  for (const m of session.messages) {
    if (m.role === "user") {
      turnIdx++
      mdLines.push(
        "---",
        "",
        `## ${turnIdx}. Sufian - ${formatArchiveStampGmt8(m.timestampMs)}`,
        "",
        m.content.trim() || "*(empty prompt)*",
        "",
      )
      continue
    }

    const metaBits = [
      m.character || session.character,
      (m.provider ?? "").toUpperCase(),
      m.model ?? "",
      m.effort ? `thinking:${m.effort}` : "",
    ].filter(Boolean)
    mdLines.push(metaBits.length > 0 ? `### ABuCode (${metaBits.join(" · ")})` : "### ABuCode", "")

    if (m.reasoning?.trim()) {
      mdLines.push(
        "<details>",
        "<summary>💭 Thinking Trace</summary>",
        "",
        "```text",
        m.reasoning.trim(),
        "```",
        "</details>",
        "",
      )
    }
    mdLines.push(m.content.trim(), "")
  }

  const mdText = `${mdLines.join("\n")}\n`
  const writtenPaths: string[] = []

  for (const archRoot of roots) {
    try {
      const targetDir = path.join(archRoot, "ABuCode", String(startParts.year), monthFolder)
      fs.mkdirSync(targetDir, { recursive: true })
      const wantMd = path.join(
        targetDir,
        `${pad2(startParts.day)}_${pad2(startParts.hour)}${pad2(startParts.minute)}--${slug}--${shortId}.md`,
      )

      const stateDir = path.join(archRoot, "_index", "state")
      fs.mkdirSync(stateDir, { recursive: true })
      const stateFile = path.join(stateDir, `${sid}.json`)

      if (fs.existsSync(stateFile)) {
        try {
          const oldSt = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { md?: string }
          if (oldSt.md && fs.existsSync(oldSt.md) && path.resolve(oldSt.md) !== path.resolve(wantMd)) {
            fs.unlinkSync(oldSt.md)
          }
        } catch {
          // Ignore stale state cleanup error
        }
      }

      writeTextIfChanged(wantMd, mdText)
      const statePayload = {
        sid,
        md: wantMd,
        slug,
        title,
        start: formatIsoGmt8(session.createdMs),
        end: formatIsoGmt8(session.updatedMs),
        updatedMs: session.updatedMs,
        turns: userTurns,
        asst: asstTurns,
        agent: "abucode",
        cwds: session.cwd ? [session.cwd] : [],
        branches: [branch],
        models: modelsUsed,
        prs: [],
        version: "2.4.0",
        fresh: false,
      }
      writeTextIfChanged(stateFile, JSON.stringify(statePayload, null, 2))
      writeArchiveIndex(archRoot)
      writtenPaths.push(wantMd)
    } catch {
      // Non-fatal archive write error
    }
  }

  return writtenPaths
}

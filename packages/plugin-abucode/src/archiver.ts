import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

export function detectGitBranchSafe(repoPath: string): string {
  if (!repoPath) return "dev"
  try {
    const dotGit = path.join(repoPath, ".git")
    if (!fs.existsSync(dotGit)) return "dev"
    const stat = fs.statSync(dotGit)
    let gitDir = dotGit
    if (stat.isFile()) {
      const ptr = fs.readFileSync(dotGit, "utf8").trim()
      if (!ptr.startsWith("gitdir:")) return "dev"
      const rawRel = ptr.slice("gitdir:".length).trim()
      gitDir = path.isAbsolute(rawRel) ? rawRel : path.resolve(repoPath, rawRel)
    }
    const headPath = path.join(gitDir, "HEAD")
    if (!fs.existsSync(headPath)) return "dev"
    const head = fs.readFileSync(headPath, "utf8").trim()
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length)
    return head.slice(0, 8) || "HEAD"
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

export function discoverChatHistoryRoots(
  repoPathStr = "",
  opts?: { readonly extraArchiveRoots?: readonly string[]; readonly allowDefaultFallbacks?: boolean },
): string[] {
  if (isInTempDir(repoPathStr)) return []
  if (opts?.extraArchiveRoots) {
    return opts.extraArchiveRoots.filter((dir) => fs.existsSync(dir))
  }

  const candidates: string[] = []
  if (repoPathStr) candidates.push(repoPathStr)
  if (opts?.allowDefaultFallbacks !== false) {
    candidates.push(
      ABUCODE_REPO_ROOT,
      "D:/Libraries/Documents/1ACode/MultiCode",
      path.join(os.homedir(), "Documents", "Projects", "MultiCode"),
    )
  }

  const roots: string[] = []
  const seen = new Set<string>()
  for (const repo of candidates) {
    try {
      if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) continue
      for (const localSub of ["zzz_local", "z_local"]) {
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

interface ArchiveIndexEntry {
  readonly sid: string
  readonly md?: string
  readonly title?: string
  readonly start?: string
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
    fs.writeFileSync(path.join(archRoot, "INDEX.md"), `${lines.join("\n")}\n`, "utf8")
  } catch {
    // Non-fatal index write failure
  }
}

export function archiveSessionToChatHistory(
  session: ArchivableSession,
  opts?: { readonly extraArchiveRoots?: readonly string[]; readonly allowDefaultFallbacks?: boolean },
): string[] {
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

  const mdLines: string[] = [
    `# ${title.slice(0, 120)}`,
    "",
    "| | |",
    "|---|---|",
    `| session | \`${sid}\` |`,
    `| agent | \`ABuCode\` |`,
    `| character | \`${session.character}\` |`,
    `| started | ${formatArchiveStampGmt8(session.createdMs)} |`,
    `| last turn | ${formatArchiveStampGmt8(session.updatedMs)} |`,
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

      fs.writeFileSync(wantMd, mdText, "utf8")
      const statePayload = {
        sid,
        md: wantMd,
        slug,
        title,
        start: formatIsoGmt8(session.createdMs),
        end: formatIsoGmt8(session.updatedMs),
        turns: userTurns,
        asst: asstTurns,
        agent: "abucode",
        cwds: session.cwd ? [session.cwd] : [],
        branches: [branch],
        models: modelsUsed,
        prs: [],
        version: "2.2.5",
        fresh: false,
      }
      fs.writeFileSync(stateFile, JSON.stringify(statePayload, null, 2), "utf8")
      writeArchiveIndex(archRoot)
      writtenPaths.push(wantMd)
    } catch {
      // Non-fatal archive write error
    }
  }

  return writtenPaths
}

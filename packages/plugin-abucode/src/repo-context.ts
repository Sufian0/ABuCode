import childProcess from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { redactKnownSecrets, scrubEnvironmentRecord, secretFileAccessReason } from "./security.js"

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".idea",
  ".vscode",
])

const OVERVIEW_PHRASES = [
  "thoughts on this repo",
  "thoughts on the repo",
  "repo overview",
  "project overview",
  "codebase overview",
  "project structure",
  "repo structure",
  "explain this repo",
  "explain the repo",
  "what's inside",
  "what is inside",
  "entire repo",
  "top level",
  "top-level",
  "architecture",
] as const

const FILE_REF_RE =
  /(?:@)?((?:[A-Za-z0-9_.-]+[/\\])*[A-Za-z0-9_.-]+\.(?:md|txt|py|json|html|css|js|ts|tsx|jsx|csv|sh|cmd|yaml|yml|toml|rs|go|cs))\b/g

function runSafeGit(repoRoot: string, args: readonly string[], timeoutMs = 2500): string {
  try {
    const cleanEnv = scrubEnvironmentRecord(process.env) as NodeJS.ProcessEnv
    const res = childProcess.spawnSync("git", ["-c", "core.fsmonitor=false", "-C", repoRoot, ...args], {
      env: cleanEnv,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    })
    if (res.status !== 0) return ""
    return (res.stdout || "").trim()
  } catch {
    return ""
  }
}

export function buildRecursiveRepoTree(
  repoRoot: string,
  opts?: { readonly maxDepth?: number; readonly maxLines?: number },
): { readonly tree: string; readonly projectFiles: readonly string[] } {
  const maxDepth = opts?.maxDepth ?? 4
  const maxLines = opts?.maxLines ?? 150
  const treeLines: string[] = []
  const projectFiles: string[] = []

  const walk = (currDir: string, depth: number, prefix: string) => {
    if (treeLines.length >= maxLines || depth > maxDepth) return
    let entries: fs.Dirent[]
    try {
      entries = fs
        .readdirSync(currDir, { withFileTypes: true })
        .filter((e) => !IGNORED_DIRS.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        })
    } catch {
      return
    }

    const dirName = path.basename(currDir)
    if (dirName === "zzz_local" && path.resolve(currDir) !== path.resolve(repoRoot)) {
      const subNames = entries.slice(0, 10).map((c) => (c.isDirectory() ? `${c.name}/` : c.name))
      if (subNames.length > 0) {
        treeLines.push(`${prefix}└── ${subNames.join(", ")} (local scratchpad/logs)`)
      }
      return
    }

    const readmeTranslations = entries.filter(
      (c) => c.name.startsWith("README.") && c.name.endsWith(".md") && c.name !== "README.md",
    ).length

    if (path.resolve(currDir) !== path.resolve(repoRoot) && (entries.length > 28 || readmeTranslations >= 5)) {
      const subdirs = entries
        .filter((c) => c.isDirectory())
        .slice(0, 12)
        .map((c) => `${c.name}/`)
      const keyFiles = entries
        .filter((c) => c.isFile() && !(c.name.startsWith("README.") && c.name !== "README.md"))
        .slice(0, 8)
        .map((c) => c.name)
      const relDir = path.relative(repoRoot, currDir).replaceAll("\\", "/")
      treeLines.push(
        `${prefix}└── ${[...subdirs, ...keyFiles].join(", ")} ... (${entries.length} items in \`${relDir}/\`)`,
      )
      return
    }

    for (let idx = 0; idx < entries.length; idx++) {
      if (treeLines.length >= maxLines) {
        treeLines.push(`${prefix}... (tree truncated)`)
        return
      }
      const entry = entries[idx]!
      const isLast = idx === entries.length - 1
      const sym = isLast ? "└── " : "├── "
      const nextPrefix = prefix + (isLast ? "    " : "│   ")
      const fullChild = path.join(currDir, entry.name)

      if (entry.isDirectory()) {
        treeLines.push(`${prefix}${sym}${entry.name}/`)
        walk(fullChild, depth + 1, nextPrefix)
      } else if (entry.isFile()) {
        if (entry.name.startsWith("README.") && entry.name.endsWith(".md") && entry.name !== "README.md") {
          continue
        }
        treeLines.push(`${prefix}${sym}${entry.name}`)
        const relFile = path.relative(repoRoot, fullChild).replaceAll("\\", "/")
        if (!relFile.startsWith("zzz_local/") && !relFile.startsWith("vendor/")) {
          projectFiles.push(relFile)
        }
      }
    }
  }

  walk(repoRoot, 1, "")
  return { tree: treeLines.join("\n"), projectFiles }
}

const staticRepoMapCache = new Map<string, string>()

/**
 * Builds a deterministic, session-invariant workspace directory map cached per repository root.
 * Because it never mutates across tool steps or turns, it keeps provider prefix prompt caching at 100%
 * while giving the model MultiCode-style upfront visibility into the repository's package & folder layout.
 */
export function getStaticRepoMapBlock(repoRoot: string): string {
  const rawRoot = repoRoot.trim()
  if (!rawRoot) return ""
  let resolvedRoot: string
  try {
    resolvedRoot = path.resolve(rawRoot)
    const cached = staticRepoMapCache.get(resolvedRoot)
    if (cached !== undefined) return cached
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
      staticRepoMapCache.set(resolvedRoot, "")
      return ""
    }
  } catch {
    return ""
  }

  const repoName = path.basename(resolvedRoot)
  const { tree } = buildRecursiveRepoTree(resolvedRoot, { maxDepth: 2, maxLines: 75 })
  if (!tree) {
    staticRepoMapCache.set(resolvedRoot, "")
    return ""
  }

  const block = [
    `## Workspace Architecture Map (\`${repoName}/\`)`,
    "Use this pre-indexed layout to target `read`, `grep`, and `glob` directly to the right package/folder without blind root-wide searches:",
    "```text",
    `${repoName}/`,
    tree,
    "```",
  ].join("\n")

  if (staticRepoMapCache.size > 32) staticRepoMapCache.clear()
  staticRepoMapCache.set(resolvedRoot, block)
  return block
}

export function buildRepoContextBlock(input: {
  readonly repoRoot: string
  readonly userMessage: string
  readonly recentTexts?: readonly string[]
  readonly squadEnabled?: boolean
}): { readonly contextBlock: string; readonly referencedFiles: readonly string[] } {
  const rawRoot = input.repoRoot.trim()
  if (!rawRoot) return { contextBlock: "", referencedFiles: [] }

  let resolvedRoot: string
  try {
    resolvedRoot = path.resolve(rawRoot)
    if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
      return { contextBlock: "", referencedFiles: [] }
    }
  } catch {
    return { contextBlock: "", referencedFiles: [] }
  }

  const repoName = path.basename(resolvedRoot)
  const isGit = fs.existsSync(path.join(resolvedRoot, ".git"))
  const { tree, projectFiles } = buildRecursiveRepoTree(resolvedRoot)

  const headerLines: string[] = [
    "## Active Repository Context (Proactive Pre-Flight Snapshot)",
    `- **Repository:** \`${repoName}\` (\`${resolvedRoot}\`)`,
  ]

  if (isGit) {
    const branch = runSafeGit(resolvedRoot, ["branch", "--show-current"]) || "HEAD"
    const shortStatus = runSafeGit(resolvedRoot, ["status", "-s"])
    const recentCommits = runSafeGit(resolvedRoot, ["log", "-n", "5", "--oneline", "--decorate"])
    headerLines.push(`- **Git Branch:** \`${branch}\` (${shortStatus ? "dirty" : "clean"})`)
    if (recentCommits) {
      headerLines.push(`- **Recent Commits:**\n\`\`\`text\n${redactKnownSecrets(recentCommits)}\n\`\`\``)
    }
    if (shortStatus) {
      headerLines.push(
        `- **Working Tree Changes:**\n\`\`\`text\n${redactKnownSecrets(shortStatus.slice(0, 2000))}\n\`\`\``,
      )
    }
  }

  if (input.squadEnabled) {
    headerLines.push(
      "### 👯‍♀️ Squad Multi-Agent Orchestration Active",
      "- For multi-hypothesis root-cause debugging, multi-lens code reviews, architecture comparisons, or cross-module mapping, invoke `run_workflow(template='diagnose'|'review'|'design'|'map', goal='...', scouts=0..2, lanes=[{'question': '...', 'hypothesis': '...', 'start_paths': ['...'], 'character': 'Cordelia'}])`.",
      "- Each lane automatically pairs a primary Investigator/Reviewer with an adversarial **Skeptic** citation verifier. Use `get_agent_report(id='...')` to inspect any agent's full report.",
      "- For simple 1–2 file lookups or direct edits, use normal tools directly without launching a workflow.",
    )
  } else {
    headerLines.push(
      "### 👯‍♀️ Household Parallel Subagents Available",
      "- You can delegate isolated read-only codebase research in parallel (up to 4 at once) Embodied by Household 343 personas via `dispatch_subagent(tasks=[{'task': '...', 'character': 'Cordelia'}, {'task': '...', 'character': '2B'}])`.",
    )
  }

  if (tree) {
    headerLines.push(`\n### Repository File Tree (\`${repoName}/\`)\n\`\`\`text\n${repoName}/\n${tree}\n\`\`\``)
  }

  const referencedFiles: string[] = []
  const fileBlocks: string[] = []
  let totalAttachedChars = 0
  const maxTotalChars = 28_000

  const attachFile = (relCandidate: string, maxChars = 12_000, note = ""): boolean => {
    if (totalAttachedChars >= maxTotalChars) return false
    const cleanRel = relCandidate.replaceAll("\\", "/").replace(/^\/+/, "").trim()
    if (!cleanRel) return false
    const target = path.resolve(resolvedRoot, cleanRel)
    const relNorm = path.relative(resolvedRoot, target).replaceAll("\\", "/")
    if (relNorm.startsWith("..") || path.isAbsolute(relNorm)) return false
    if (referencedFiles.includes(relNorm)) return true
    if (secretFileAccessReason(target)) return false

    try {
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false
      const raw = redactKnownSecrets(fs.readFileSync(target, "utf8"))
      const budget = Math.min(maxChars, maxTotalChars - totalAttachedChars)
      const clipped =
        raw.length > budget ? `${raw.slice(0, budget)}\n... [Truncated to ${budget} chars]` : raw
      const ext = path.extname(target).replace(/^\./, "") || "text"
      const suffix = note ? ` (${note})` : ""
      fileBlocks.push(`### Repo File: \`${relNorm}\`${suffix}\n\`\`\`${ext}\n${clipped}\n\`\`\``)
      referencedFiles.push(relNorm)
      totalAttachedChars += clipped.length
      return true
    } catch {
      return false
    }
  }

  // 1. Attach ABUCODE.md or README.md if present
  if (fs.existsSync(path.join(resolvedRoot, "ABUCODE.md"))) {
    attachFile("ABUCODE.md", 6_000, "Project Guide")
  }
  if (fs.existsSync(path.join(resolvedRoot, "README.md"))) {
    attachFile("README.md", 8_000, "Project README")
  }

  // 2. Attach files explicitly mentioned in userMessage or recent turns
  const combinedScan = [input.userMessage, ...(input.recentTexts ?? []).slice(-4)].join("\n")
  for (const match of combinedScan.matchAll(FILE_REF_RE)) {
    const cand = match[1]?.trim() ?? ""
    if (!cand) continue
    if (!attachFile(cand, 10_000, "Referenced")) {
      const bareLower = path.basename(cand).toLowerCase()
      const hit = projectFiles.find((pf) => path.basename(pf).toLowerCase() === bareLower)
      if (hit) attachFile(hit, 10_000, "Referenced")
    }
  }

  // 3. On high-level repo overview / architecture questions, attach root manifests
  const lowerMsg = input.userMessage.toLowerCase()
  if (OVERVIEW_PHRASES.some((phrase) => lowerMsg.includes(phrase))) {
    for (const manifest of ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml"]) {
      attachFile(manifest, 5_000, "Manifest")
    }
  }

  const contextBlock =
    fileBlocks.length > 0
      ? `${headerLines.join("\n")}\n\n${fileBlocks.join("\n\n")}`
      : headerLines.join("\n")

  return { contextBlock, referencedFiles }
}

export function derivePoeSmartTitle(rawPrompt: string): string {
  const withoutCode = rawPrompt.replace(/```[\s\S]*?```/g, " ").trim()
  const firstMeaningfulLine =
    withoutCode
      .split(/\r?\n/)
      .map((ln) => ln.replace(/^[#>*\-\s]+/, "").trim())
      .find((ln) => ln.length > 0) ?? "New ABuCode Chat"

  const cleaned = firstMeaningfulLine.replace(/\s+/g, " ").trim()
  if (cleaned.length <= 56) return cleaned || "New ABuCode Chat"
  const sliced = cleaned.slice(0, 53).replace(/\s+\S*$/, "").trim()
  return `${sliced || cleaned.slice(0, 53)}…`
}

export interface CompactableTurn {
  readonly role: "user" | "assistant"
  readonly content: string
  readonly reasoning?: string
}

export function compactTurnsIntoMemory(input: {
  readonly turns: readonly CompactableTurn[]
  readonly existingMemory: string
  readonly keepLast?: number
  readonly customNote?: string
}): {
  readonly compacted: boolean
  readonly compactedCount: number
  readonly tokensSaved: number
  readonly summaryBlock: string
  readonly nextMemory: string
} {
  const turns = input.turns
  if (turns.length < 2) {
    return {
      compacted: false,
      compactedCount: 0,
      tokensSaved: 0,
      summaryBlock: "",
      nextMemory: input.existingMemory,
    }
  }

  const keepLast = Math.max(0, Math.trunc(input.keepLast ?? 4))
  const effectiveKeep = Math.min(keepLast, Math.max(0, turns.length - 2))
  const cutIdx = turns.length - effectiveKeep
  const older = turns.slice(0, cutIdx)

  const lines: string[] = [`### 🗜️ Compacted Conversation Summary (${older.length} messages)`]
  const note = (input.customNote ?? "").trim()
  if (note) {
    lines.push(`- **Compaction Note:** ${note}`)
  }

  for (const m of older) {
    const roleLabel = m.role === "user" ? "User" : "Assistant"
    const single = m.content.replace(/\s+/g, " ").trim()
    const snippet = single.length > 220 ? `${single.slice(0, 217).trimEnd()}...` : single || "(no text)"
    lines.push(`- **${roleLabel}:** ${snippet}`)
  }

  const summaryBlock = lines.join("\n")
  const charsBefore = older.reduce((sum, m) => sum + m.content.length + (m.reasoning?.length ?? 0), 0)
  const charsSaved = Math.max(0, charsBefore - summaryBlock.length)
  const tokensSaved = Math.max(1, Math.round(charsSaved / 4))

  const nextMemory = appendCompactionSummaryToMemory(input.existingMemory, summaryBlock)
  return {
    compacted: true,
    compactedCount: older.length,
    tokensSaved,
    summaryBlock,
    nextMemory,
  }
}

export function appendCompactionSummaryToMemory(existingMemory: string, summaryText: string): string {
  const cleanSummary = summaryText.trim()
  if (!cleanSummary) return existingMemory.trim()
  const formatted = cleanSummary.startsWith("### ")
    ? cleanSummary
    : `### 🗜️ Auto-Compacted Session Context\n${cleanSummary}`
  const base = existingMemory.trim()
  if (!base) return formatted
  if (base.includes(cleanSummary)) return base
  return `${base}\n\n${formatted}`
}

import childProcess from "node:child_process"
import dns from "node:dns"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { PolicyTier } from "@opencode/schema/abucode"
import { FSUtil } from "@opencode/util/fs-util"
import { loadResolvedSecretEnv, PROVIDERS_META } from "./providers.js"

export const AGENT_SELF_HEADER = "X-ABuCode-Agent"

export const KEY_FILE_PATHSPEC_EXCLUDES = [
  ":(exclude,glob,icase)**/.env",
  ":(exclude,glob,icase)**/.env.*",
  ":(exclude,glob,icase)**/.envrc",
] as const

const SECRET_ENV_NAME_RE =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|(?:^|_)PAT(?:_|$)|_(?:KEY|PWD|DSN)$|^PG(?:PASSWORD|PASSFILE)$/i

const NOT_CREDENTIALS = new Set(["TOKENIZERS_PARALLELISM"])
const KEY_FILE_NAMES = new Set([".env", ".envrc"])
const KEY_FILE_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".pub"]

const CREDENTIAL_EXACT_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".pgpass",
  ".docker/config.json",
  "credentials.json",
  "client_secret.json",
  "master.key",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
])

const CREDENTIAL_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfstate", ".tfvars"]

const HIDDEN_CHARACTERS_RE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u2D7F\u3164\uFE00-\uFE0F\uFFA0\uFFFC\u{E0100}-\u{E01EF}]/gu
const MANY_COMBINING_MARKS_RE = /\p{M}{4,}/gu

export function normalizePolicyTier(raw: string | undefined): PolicyTier {
  const clean = (raw ?? "").trim().toLowerCase()
  if (clean === "request_review" || clean === "review" || clean === "request-review") return "request_review"
  if (clean === "auto") return "auto"
  if (clean === "turbo") return "turbo"
  return "default"
}

export function looksLikeCredentialName(name: string): boolean {
  return !NOT_CREDENTIALS.has(name.toUpperCase()) && SECRET_ENV_NAME_RE.test(name)
}

export function scrubEnvironmentRecord(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const rawKeep = `${env.ABUCODE_PASS_ENV ?? ""},${env.MULTICODE_PASS_ENV ?? ""}`
  const keep = new Set(
    rawKeep
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )
  const ownKeys = new Set(PROVIDERS_META.map((m) => m.envKey))
  const out: Record<string, string | undefined> = {}

  for (const [key, val] of Object.entries(env)) {
    if (keep.has(key)) {
      out[key] = val
      continue
    }
    if (ownKeys.has(key) || looksLikeCredentialName(key)) continue
    out[key] = val
  }
  return out
}

export function scrubEnvironmentInPlace(env: Record<string, string | undefined>): void {
  const cleaned = scrubEnvironmentRecord(env)
  for (const key of Object.keys(env)) {
    if (!(key in cleaned)) delete env[key]
  }
}

export function isEnvStyleSecretFile(fileName: string): boolean {
  const lower = path.basename(fileName).toLowerCase()
  if (KEY_FILE_NAMES.has(lower)) return true
  if (lower.startsWith(".env.") && !KEY_FILE_TEMPLATE_SUFFIXES.some((ext) => lower.endsWith(ext))) {
    return true
  }
  return false
}

export function isCredentialFile(targetPath: string, opts?: { readonly forWrite?: boolean }): boolean {
  const norm = targetPath.replaceAll("\\", "/").toLowerCase()
  const base = path.basename(norm)
  if (KEY_FILE_TEMPLATE_SUFFIXES.some((ext) => base.endsWith(ext))) return false
  if (isEnvStyleSecretFile(base)) return true

  // Protect .git internals from mutation and .git/config or .git/hooks from credential/hook tampering
  if (inGitFolder(norm)) {
    if (opts?.forWrite) return true
    const rooted = `/${norm}`
    if (
      rooted.endsWith("/.git/config") ||
      rooted.includes("/.git/credentials") ||
      rooted.includes("/.git-credentials")
    ) {
      return true
    }
  }

  if (opts?.forWrite) return false

  if (CREDENTIAL_EXACT_NAMES.has(base)) return true
  if (base.startsWith("service-account") && base.endsWith(".json")) return true
  if (CREDENTIAL_EXTENSIONS.some((ext) => base.endsWith(ext))) return true
  if (norm.includes("/.ssh/") || norm.includes("/.aws/") || norm.includes("/.gnupg/") || norm.includes("/.kube/")) {
    return true
  }
  return false
}

export function secretFileAccessReason(
  targetPath: string,
  opts?: { readonly mode?: "read" | "write" | "search" },
): string | undefined {
  const base = path.basename(targetPath)
  const lower = base.toLowerCase()
  const norm = targetPath.replaceAll("\\", "/").toLowerCase()

  if (isEnvStyleSecretFile(base)) {
    return `\`${base}\` holds API keys or secrets, so ABuCode's file tools cannot read, search, or modify it directly.`
  }
  if (lower === ".provider_settings.json" || lower === "opencode.json") {
    if (
      lower === ".provider_settings.json" ||
      norm.includes("/.config/opencode/") ||
      norm.includes("/.config/abucode/")
    ) {
      return `\`${base}\` configures provider credentials/routing, so ABuCode's agent tools cannot read or modify it.`
    }
  }
  if (opts?.mode === "write" && inGitFolder(norm)) {
    return "Modifying files directly inside `.git/` is blocked for repository safety."
  }
  if (opts?.mode !== "write" && isCredentialFile(targetPath, { forWrite: false })) {
    return `\`${base}\` is a sensitive credential/key file, so ABuCode's read and search tools cannot expose its contents.`
  }
  return undefined
}

// Whether a lower-cased, forward-slash path names a `.git` folder or lies in one. The file tools pass project-relative
// paths, so `.git` can be the first segment (`.git/hooks/pre-commit`) as well as a later one.
function inGitFolder(norm: string) {
  return `/${norm}/`.includes("/.git/")
}

export interface EngineConfigDirs {
  /** The folder a relative permission resource is relative to: the session's Location directory. */
  readonly cwd: string
  /** The user's home folder; the Plan agent writes its plans in `<home>/.opencode/plan`. */
  readonly home: string
  /** Folders whose whole content is config: the global and system config folders. */
  readonly roots: readonly string[]
  /** Config files outside those folders, such as the one `OPENCODE_CONFIG` names. */
  readonly files: readonly string[]
}

/**
 * Whether an edit permission resource (relative to `cwd` inside the project, absolute outside it) is engine config: a
 * file named `opencode.json(c)`, anything in a `.opencode` folder, anything in a config root, or a named config file.
 * Config can load plugins, start MCP servers and replace commands, so editing it can switch the guards off.
 */
export function isEngineConfigPath(resource: string, dirs: EngineConfigDirs): boolean {
  const absolute = path.resolve(dirs.cwd, resource)
  const real = realPathOf(absolute)
  const plan = path.join(dirs.home, ".opencode", "plan")
  const realPlan = realPathOf(plan)
  // The engine does not load the Plan agent's plan folder, so only what lies below it counts there: an opencode.json or
  // a .opencode folder inside it is live config for a session moved into the folder.
  if (containsPath(plan, absolute) && containsPath(realPlan, real)) {
    return isConfigName(path.relative(foldPath(realPlan), foldPath(real)))
  }
  // The path as written and its real path: a link, a macOS firmlink such as /System/Volumes/Data, or another spelling
  // of a folder that exists reaches the same files the engine loads.
  return [absolute, real].some(
    (candidate) =>
      isConfigName(candidate) ||
      dirs.roots.some((root) => containsPath(realPathOf(path.resolve(root)), candidate)) ||
      dirs.files.some((file) => foldPath(realPathOf(path.resolve(file))) === foldPath(candidate)),
  )
}

/** Core's ConfigDiscovery.systemDirectory, which plugins cannot import; abucode-config-edit.test.ts compares the two. */
export function systemConfigDirectory(platform = process.platform, env = process.env) {
  if (platform === "darwin") return "/Library/Application Support/opencode"
  if (platform === "win32") return path.join(env.ProgramData || "C:\\ProgramData", "opencode")
  return "/etc/opencode"
}

export interface ProjectFolders {
  /** The folder a relative permission resource is relative to: the session's Location directory. */
  readonly cwd: string
  /** The real paths of the folders an edit may change without the outside-project prompt. */
  readonly open: readonly string[]
}

/**
 * The folders whose files an edit may change without the outside-project prompt, by their real paths as they are when
 * this is called: the session's folder and its checkout, the repository's main checkout, the engine's worktree folder
 * for the project, the Plan agent's plan folder and the engine's temp folder. They are read once, so a folder that is
 * later replaced by a link to elsewhere does not take its exemption along.
 */
export function projectFolders(dirs: {
  readonly cwd: string
  /** The checkout the session is in; ignored, like `canonical`, when it is a filesystem root. */
  readonly project: string
  /** The repository's main checkout. */
  readonly canonical: string
  /** Core's default worktree folder for the project; abucode-config-edit.test.ts fails if the two differ. */
  readonly worktrees: string
  /** The user's home folder; the Plan agent writes its plans in `<home>/.opencode/plan`. */
  readonly home: string
  /** The engine's temp folder, which the engine's own prompt tells the agent to use for scratch files. */
  readonly tmp: string
}): ProjectFolders {
  const checkouts = [dirs.project, dirs.canonical].filter(
    (dir) => path.resolve(dir) !== path.parse(path.resolve(dir)).root,
  )
  return {
    cwd: dirs.cwd,
    open: [dirs.cwd, ...checkouts, dirs.worktrees, path.join(dirs.home, ".opencode", "plan"), dirs.tmp].map((dir) =>
      realPathOf(path.resolve(dir)),
    ),
  }
}

/**
 * The edit permission resources (relative to `cwd` inside the project, absolute outside it, `<machine>:/…` on another
 * machine) whose write would land outside the project's folders. Where a write lands is read from the disk: links are
 * followed, a final link whose target does not exist yet included, since writing through it creates that target. So a
 * link in the project that points outside counts as outside. Another machine's file is always outside.
 */
export function editsOutsideProject(resources: readonly string[], folders: ProjectFolders): string[] {
  return resources.filter((resource) => {
    if (/^[a-z][a-z0-9-]{1,62}:(?:~|\/(?!\/))/.test(resource)) return true
    const lands = realPathOf(path.resolve(folders.cwd, resource))
    return !folders.open.some((folder) => FSUtil.contains(folder, lands))
  })
}

// A file named opencode.json(c), or anything in a .opencode folder. Windows ignores an NTFS stream suffix (`:...`) and
// trailing dots and spaces in a name, so they are dropped from every segment.
function isConfigName(value: string): boolean {
  const segments = foldPath(value)
    .split(/[\\/]/)
    .map((segment) => segment.replace(/:.*$/, "").replace(/[. ]+$/, ""))
  const base = segments.at(-1)
  return base === "opencode.json" || base === "opencode.jsonc" || segments.includes(".opencode")
}

// The real path of the deepest folder that resolves, with the rest of the path as written. realpath fails for a missing
// path and also for a folder that can be searched but not read; that part then stays as written. A link whose target
// does not exist yet is followed too, since writing through it creates that target.
function realPathOf(absolute: string, links = 0): string {
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    const parent = path.dirname(absolute)
    if (parent === absolute) return absolute
    const real = path.join(realPathOf(parent, links), path.basename(absolute))
    const target = links < 40 ? linkTarget(real) : undefined
    return target === undefined ? real : realPathOf(path.resolve(path.dirname(real), target), links + 1)
  }
}

function linkTarget(file: string): string | undefined {
  try {
    return fs.readlinkSync(file)
  } catch {
    return undefined
  }
}

// macOS and Windows compare names without case, and APFS folds `ſ` to `s` that way too; APFS also ignores Unicode
// normalization.
function foldPath(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase()
}

function containsPath(parent: string, child: string): boolean {
  return FSUtil.contains(foldPath(parent), foldPath(child))
}

export function knownSecretValues(envLocalPath?: string): string[] {
  const resolved = loadResolvedSecretEnv(envLocalPath)
  const values = new Set<string>()
  for (const meta of PROVIDERS_META) {
    const v1 = resolved[meta.envKey]?.trim() ?? ""
    const v2 = process.env[meta.envKey]?.trim() ?? ""
    if (v1.length >= 8) values.add(v1)
    if (v2.length >= 8) values.add(v2)
  }
  return Array.from(values).sort((a, b) => b.length - a.length)
}

export function redactKnownSecrets(text: string, envLocalPath?: string): string {
  if (!text) return text
  let out = text
  for (const secret of knownSecretValues(envLocalPath)) {
    if (out.includes(secret)) {
      out = out.replaceAll(secret, "[REDACTED API KEY]")
    }
  }
  return out
}

export function showHiddenCharacters(text: string): string {
  return text
    .replace(MANY_COMBINING_MARKS_RE, (run) => `⟦${Array.from(run).length} combining marks⟧`)
    .replace(HIDDEN_CHARACTERS_RE, (ch) => {
      if (ch === " " || ch === "\t" || ch === "\n") return ch
      const code = ch.codePointAt(0) ?? 0
      return `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`
    })
}

// ============================================================================
// Deep Shell Command Parser & MultiCode-Parity 4-Tier Classifier
// ============================================================================

export type CommandRiskClass =
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "ask_always"; readonly reason: string }
  | { readonly kind: "ask_default"; readonly reason: string }
  | { readonly kind: "safe" }

interface ParsedShellScan {
  readonly unclosedQuote: boolean
  readonly ambiguousExpansion: boolean
  readonly segments: readonly (readonly string[])[]
  readonly nestedSnippets: readonly string[]
  readonly redirectionTargets: readonly string[]
  /** The redirection targets and nested snippets again, each with the index of the segment it belongs to. */
  readonly redirections: readonly { readonly segment: number; readonly target: string }[]
  readonly nested: readonly { readonly segment: number; readonly snippet: string }[]
}

/**
 * Quote-aware shell scanner: keeps single-quoted strings literal, inspects `$(...)`,
 * backticks, `<(...)`, and splits unquoted pipelines (`|`, `||`, `&&`, `;`, `&`, `\n`)
 * into argv-style token segments plus output redirection targets.
 */
export function scanShellCommandStructure(rawCommand: string): ParsedShellScan {
  const segments: string[][] = []
  const nestedSnippets: string[] = []
  const redirectionTargets: string[] = []
  const redirections: { segment: number; target: string }[] = []
  const nested: { segment: number; snippet: string }[] = []
  const nest = (snippet: string) => {
    nestedSnippets.push(snippet)
    nested.push({ segment: segments.length, snippet })
  }
  let currentSeg: string[] = []
  let currentTok = ""
  let tokenStarted = false
  let inSingle = false
  let inDouble = false
  let escaped = false
  let ambiguousExpansion = false

  const flushTok = () => {
    if (tokenStarted || currentTok.length > 0) {
      currentSeg.push(currentTok)
      currentTok = ""
      tokenStarted = false
    }
  }

  const flushSeg = () => {
    flushTok()
    if (currentSeg.length > 0) {
      segments.push(currentSeg)
      currentSeg = []
    }
  }

  const extractBalancedParen = (src: string, openIdx: number): { inner: string; endIdx: number } | null => {
    let depth = 0
    let sq = false
    let dq = false
    let esc = false
    for (let j = openIdx; j < src.length; j++) {
      const c = src[j]!
      if (esc) {
        esc = false
        continue
      }
      if (c === "\\" && !sq) {
        esc = true
        continue
      }
      if (c === "'" && !dq) {
        sq = !sq
        continue
      }
      if (c === '"' && !sq) {
        dq = !dq
        continue
      }
      if (sq || dq) continue
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0) {
          return { inner: src.slice(openIdx + 1, j), endIdx: j }
        }
      }
    }
    return null
  }

  for (let i = 0; i < rawCommand.length; i++) {
    const ch = rawCommand[i]!

    if (escaped) {
      currentTok += ch
      tokenStarted = true
      escaped = false
      continue
    }

    // A backslash right before a line feed joins the next line on; it is not a character of any word. Before a CR it
    // only escapes the CR, so a CRLF line end still ends the command, as in every POSIX shell.
    if (ch === "\\" && !inSingle && rawCommand[i + 1] === "\n") {
      i++
      continue
    }

    if (ch === "\\" && !inSingle) {
      escaped = true
      continue
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      tokenStarted = true
      continue
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      tokenStarted = true
      continue
    }

    // Command substitution $(...) or ambiguous ${...} outside single quotes
    if (!inSingle && ch === "$") {
      const next = rawCommand[i + 1]
      if (next === "(" && rawCommand[i + 2] !== "(") {
        const sub = extractBalancedParen(rawCommand, i + 1)
        if (!sub) {
          return {
            unclosedQuote: true,
            ambiguousExpansion: true,
            segments,
            nestedSnippets,
            redirectionTargets,
            redirections,
            nested,
          }
        }
        nest(sub.inner)
        currentTok += `$(${sub.inner})`
        tokenStarted = true
        i = sub.endIdx
        continue
      }
      if (next === "{") {
        const closeBrace = rawCommand.indexOf("}", i + 2)
        if (closeBrace === -1) {
          ambiguousExpansion = true
        } else {
          const body = rawCommand.slice(i + 2, closeBrace)
          if (body.includes("{") || body.includes("`") || body.includes("$(")) {
            ambiguousExpansion = true
          }
        }
      }
    }

    // Backtick command substitution outside single quotes
    if (!inSingle && ch === "`") {
      let endTick = i + 1
      while (endTick < rawCommand.length) {
        if (rawCommand[endTick] === "\\") {
          endTick += 2
          continue
        }
        if (rawCommand[endTick] === "`") break
        endTick++
      }
      if (endTick >= rawCommand.length) {
        return {
          unclosedQuote: true,
          ambiguousExpansion: true,
          segments,
          nestedSnippets,
          redirectionTargets,
          redirections,
          nested,
        }
      }
      const inner = rawCommand.slice(i + 1, endTick)
      nest(inner)
      currentTok += `\`${inner}\``
      tokenStarted = true
      i = endTick
      continue
    }

    if (inSingle || inDouble) {
      currentTok += ch
      tokenStarted = true
      continue
    }

    // Process substitution <(...) or >(...)
    if ((ch === "<" || ch === ">") && rawCommand[i + 1] === "(") {
      const sub = extractBalancedParen(rawCommand, i + 1)
      if (!sub) {
        ambiguousExpansion = true
      } else {
        nest(sub.inner)
        currentTok += `${ch}(${sub.inner})`
        tokenStarted = true
        i = sub.endIdx
        continue
      }
    }

    // Output redirection: >, >>, the noclobber overrides >| and >!, >&file, and zsh's >&| and >&!
    if (ch === ">") {
      // Bare digits glued to the operator name the descriptor it redirects (`2>&1`, `2>/dev/null`) and are not an
      // argument, nor is the `<` of `<>`, which opens the target for reading and writing. A word that only ends in
      // digits, or is quoted or escaped, stays a word (`arg2>f`, `"2">f`, `\<>f`).
      const glued = /^(?:\d+|\d*<)$/.test(currentTok) && rawCommand.slice(i - currentTok.length, i) === currentTok
      const before = rawCommand[i - currentTok.length - 1] ?? ""
      if (glued && (/^[\s;|&()]?$/.test(before) || (currentTok === "<" && before !== "\\"))) {
        currentTok = ""
        tokenStarted = false
      }
      flushTok()
      if (rawCommand[i + 1] === ">") i++
      if (rawCommand[i + 1] === "|" || rawCommand[i + 1] === "!") i++
      const duplicates = rawCommand[i + 1] === "&"
      if (duplicates) i++
      if (duplicates && (rawCommand[i + 1] === "|" || rawCommand[i + 1] === "!")) i++
      let k = i + 1
      // Blanks and line continuations may stand between the operator and its target.
      while (/^(?:[ \t]|\\\n)/.test(rawCommand.slice(k, k + 2))) k += rawCommand[k] === "\\" ? 2 : 1
      let redirTarget = ""
      let quote: string | undefined
      while (k < rawCommand.length && (quote !== undefined || !/[\s|&;<>()]/.test(rawCommand[k]!))) {
        const c = rawCommand[k]!
        if (quote === undefined && (c === "'" || c === '"')) quote = c
        else if (c === quote) quote = undefined
        else redirTarget += c
        k++
      }
      // `>&2` duplicates a descriptor, `>&-` closes one and `>&2-` moves one; anything else names a file. The word
      // is read either way, so a descriptor is not left behind as an argument.
      const descriptor = duplicates && /^\d*-?$/.test(redirTarget)
      if (
        redirTarget &&
        !descriptor &&
        !/^\d+$/.test(redirTarget) &&
        redirTarget !== "/dev/null" &&
        redirTarget.toLowerCase() !== "nul"
      ) {
        redirectionTargets.push(redirTarget)
        redirections.push({ segment: segments.length, target: redirTarget })
      }
      i = k - 1
      continue
    }

    // Comments outside quotes
    if (ch === "#" && !tokenStarted) {
      while (i < rawCommand.length && rawCommand[i] !== "\n") i++
      flushSeg()
      continue
    }

    // Separators
    if (ch === ";" || ch === "\n") {
      flushSeg()
      continue
    }
    if (ch === "|" || ch === "&") {
      if (rawCommand[i + 1] === ch) i++
      flushSeg()
      continue
    }
    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") {
      flushSeg()
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushTok()
      continue
    }

    // An unquoted `<` starts a redirection, so it ends the word before it (`b</dev/null`). A descriptor number glued
    // to it stays on it (`0</dev/null`), as does the rest of the operator (`<<`).
    if (
      ch === "<" &&
      currentTok !== "" &&
      !currentTok.endsWith("<") &&
      !(/^\d+$/.test(currentTok) && rawCommand.slice(i - currentTok.length, i) === currentTok)
    )
      flushTok()

    currentTok += ch
    tokenStarted = true
  }

  flushSeg()

  return {
    unclosedQuote: inSingle || inDouble || escaped,
    ambiguousExpansion,
    segments,
    nestedSnippets,
    redirectionTargets,
    redirections,
    nested,
  }
}

// Words that run the command after them, among them zsh's `noglob` and `nocorrect`.
const SHELL_WRAPPERS = new Set([
  "time",
  "nohup",
  "nice",
  "command",
  "builtin",
  "exec",
  "stdbuf",
  "ionice",
  "noglob",
  "nocorrect",
])
// The keywords in front of a command inside `if`, `while`, `until` and `for`: `if cmd; then cmd; else cmd; fi`, `! cmd`.
const SHELL_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!"])

function stripLeadingEnvAndWrappers(tokens: readonly string[]): {
  readonly envVars: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly argv: readonly string[]
  readonly usedSudo: boolean
} {
  let idx = 0
  let usedSudo = false
  const envVars: Array<{ key: string; value: string }> = []

  while (idx < tokens.length) {
    const tok = tokens[idx]!
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(tok)) {
      const eq = tok.indexOf("=")
      envVars.push({ key: tok.slice(0, eq).replace(/\+$/, ""), value: tok.slice(eq + 1) })
      idx++
      continue
    }
    const base = path.basename(tok).toLowerCase()
    // An option that takes a value (`sudo -u root`, `nice -n 5`) is stepped over with its value.
    const step = (option: string) => (WRAPPER_VALUE_OPTIONS[base]?.includes(option) ? 2 : 1)
    if (base === "sudo" || base === "doas" || base === "runas" || base === "su") {
      usedSudo = true
      idx++
      while (idx < tokens.length && tokens[idx]!.startsWith("-")) idx += step(tokens[idx]!)
      continue
    }
    if (base === "env") {
      idx++
      while (idx < tokens.length && (tokens[idx]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!))) {
        if (tokens[idx]!.includes("=")) {
          const eq = tokens[idx]!.indexOf("=")
          envVars.push({ key: tokens[idx]!.slice(0, eq), value: tokens[idx]!.slice(eq + 1) })
        }
        idx += step(tokens[idx]!)
      }
      continue
    }
    if (base === "timeout") {
      idx++
      while (idx < tokens.length && tokens[idx]!.startsWith("-")) idx += step(tokens[idx]!)
      if (idx < tokens.length) idx++ // duration arg
      continue
    }
    if (SHELL_WRAPPERS.has(base) || SHELL_KEYWORDS.has(base)) {
      idx++
      while (idx < tokens.length && tokens[idx]!.startsWith("-")) idx += step(tokens[idx]!)
      continue
    }
    break
  }

  return { envVars, argv: tokens.slice(idx), usedSudo }
}

function repoHasUnignoredSecretEnvFiles(cwd?: string): string | undefined {
  if (!cwd) return undefined
  try {
    const root = path.resolve(cwd)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return undefined
    const res = childProcess.spawnSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", root, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8", timeout: 2000, windowsHide: true },
    )
    if (res.status !== 0) return undefined
    for (const line of (res.stdout || "").split(/\r?\n/)) {
      if (line.length < 4) continue
      const rel = line
        .slice(3)
        .trim()
        .replace(/^"|"$/g, "")
      const filePart = rel.includes(" -> ") ? (rel.split(" -> ").pop() ?? rel) : rel
      if (isEnvStyleSecretFile(filePart)) {
        return filePart
      }
    }
  } catch {
    // Ignore git probe errors
  }
  return undefined
}

// `-r` or `-R` alone or in a cluster such as `-rf`, and any long option that starts with `--r`: `--recursive` and the
// prefixes of it that GNU rm accepts, and options rm refuses anyway.
const RECURSIVE_FLAG = /^(?:-[a-z]*r[a-z]*|--r[a-z]*)$/i

// `nested` marks text inside a command that was already checked whole; it gets the patterns only.
export function classifyCatastrophicCommand(command: string, home = os.homedir(), nested = false): string | undefined {
  const norm = command.trim()
  if (!norm) return undefined

  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(norm)) {
    return "Blocked: fork bomb pattern detected."
  }
  if (/\b(?:mkfs(?:\.\w+)?|diskutil\s+eraseDisk|format\s+[A-Za-z]:|cipher\s+\/w:)\b/i.test(norm)) {
    return "Blocked: disk formatting / raw erase command is never permitted."
  }
  if (/\bdd\b[^\n;|&]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|disk\d+|rdisk\d+|hd[a-z]|vd[a-z])\b/i.test(norm)) {
    return "Blocked: writing directly to a raw disk device is never permitted."
  }
  if (
    /(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|reboot|poweroff|halt|init\s+[06]|Stop-Computer|Restart-Computer)\b/i.test(
      norm,
    )
  ) {
    return "Blocked: shutting down or rebooting the host machine is never permitted."
  }
  // The pattern reads the raw text, so it also catches its spellings inside quotes or a script piped to a shell, and a
  // mere mention of one. deletesRootOrHome reads the words of each command, the way the shell does.
  if (
    /\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|--recursive)\s+(?:--no-preserve-root\s+)?(?:\/(?:\s|$|\*)|~(?:\s|$|\/\*)|\$HOME(?:\s|$|\/\*))/i.test(
      norm,
    ) ||
    (!nested && deletesRootOrHome(norm, home, 0))
  ) {
    return "Blocked: deleting root (/) or home (~) recursively is never permitted."
  }
  return undefined
}

// A recursive `rm` of the root or home folder in any command, inside `sh -c`, `eval` and `xargs`, and in command
// substitutions, however its flags and operands are written.
function deletesRootOrHome(command: string, home: string, depth: number): boolean {
  if (depth > 6) return false
  // The body of a quoted heredoc (`<<'EOF'`) is data, such as a commit message. `${HOME}` becomes `$HOME`, and a brace
  // list one of its words, because the scanner splits at braces: an empty, bare-pattern or `..` word when the list has
  // one (`~/{x,}`, `~/{*,.*}`, `~/{a/..,b}`), and a harmless word otherwise (`~/.{npm,yarn}`). A list with a quote or a
  // backslash in it is left alone, so that the quoting around it does not change.
  const scanned = scanShellCommandStructure(
    expandBraceVariables(stripHeredocBodies(command, true)).replace(
      /(?<=[^\s;&|(){}$])\{([^{}\s'"`\\]*)\}/g,
      (_, list: string) =>
        list
          .split(",")
          .find((item) => list.includes(",") && /^(?:\.{0,2}|\.?[*?]+)$|(?:^|\/)\.\.(?:\/|$)/.test(item)) ?? "_",
    ),
  )
  return (
    scanned.nestedSnippets.some((snippet) => deletesRootOrHome(snippet, home, depth + 1)) ||
    scanned.segments.some((segment) => {
      const argv = stripLeadingEnvAndWrappers(dropWrapperOptionValues(segment)).argv
      if (commandName(argv) !== "rm")
        return wrappedCommand(argv).some((inner) => deletesRootOrHome(inner, home, depth + 1))
      return argv.some((word) => RECURSIVE_FLAG.test(word)) && argv.some((word) => namesRootOrHome(word, home))
    })
  )
}

// The root folder, the home folder or a folder above it, the folders that hold homes, or everything in one of them:
// trailing segments of only wildcards and punctuation (`~/*`, `/.*`, `~/**`, `~/.[!.]*`, `/*/*`). `~` at the start and
// `$HOME` anywhere (`/$HOME` is `//Users/x`), in any case as before: an unset `$home` leaves `/` behind. Windows gives
// the home folder as `C:\Users\x`, and there `/` is the root of the current drive, which need not hold it.
function namesRootOrHome(word: string, home: string) {
  const posixHome = home.replaceAll("\\", "/")
  const expanded = FSUtil.windowsPath(
    word.replace(/^~(?=\/|$)/, () => posixHome).replace(/\$(?:HOME|\{HOME[^}]*\})(?=\/|$)/gi, () => posixHome),
  )
  if (!/^(?:[a-z]:)?\//i.test(expanded)) return false
  const segments = expanded.split("/")
  const end = segments.findLastIndex(
    (segment, index) => index === 0 || (segment !== "" && (/\w/.test(segment) || !segment.includes("*"))),
  )
  const folder = path.posix.normalize(segments.slice(0, end + 1).join("/") || "/")
  return (
    folder === "/" ||
    /^[a-z]:$/i.test(folder) ||
    containsPath(folder, posixHome) ||
    ["/home", "/users"].includes(foldPath(folder))
  )
}

export function commandStagesSecretEnvFile(command: string, cwd?: string): string | undefined {
  const norm = command.trim()
  if (!/\bgit\s+(?:add|stage|commit)\b/i.test(norm)) return undefined
  if (/(?:^|\s)(?:\.env|\.envrc|\.env\.(?!example|sample|template|dist)[\w.-]+)(?:\s|$|["'])/i.test(norm)) {
    return "Staging or committing `.env` credential files is blocked by ABuCode."
  }
  // Catch `git add .`, `git add -A`, `git add --all`, `git commit -a` when a dirty/untracked .env* file exists on disk
  if (
    /\bgit\s+(?:add|stage)\s+(?:-[A-Za-z]*A|--all|\.|:(?:\/|$))/i.test(norm) ||
    /\bgit\s+commit\s+[^\n;|&]*(?:-[A-Za-z]*a|--all)\b/i.test(norm)
  ) {
    const dirtyEnv = repoHasUnignoredSecretEnvFiles(cwd ?? process.cwd())
    if (dirtyEnv) {
      return `Blocked: \`${dirtyEnv}\` would be staged by broad \`git add\` / \`git commit -a\`. Stage explicit non-secret files or gitignore \`${dirtyEnv}\` first.`
    }
  }
  return undefined
}

function tokenReferencesPathOutsideOrGit(tok: string): string | undefined {
  const clean = tok.replace(/^[-A-Za-z0-9]+=|^["']|["']$/g, "").trim()
  if (!clean || clean.startsWith("http://") || clean.startsWith("https://")) return undefined
  const norm = clean.replaceAll("\\", "/")
  if (norm === ".git" || norm.startsWith(".git/") || norm.includes("/.git/")) {
    return `targets protected '.git' internals (${clean})`
  }
  if (norm.startsWith("../") || norm === ".." || norm.startsWith("~/") || norm === "~" || norm.startsWith("$HOME")) {
    return `targets path outside repository (${clean})`
  }
  if (/^(?:\/(?:etc|usr|var|opt|root|Users|home)|[A-Za-z]:\/(?:Windows|Users|Program Files))/i.test(norm)) {
    return `targets host system/user path outside repository (${clean})`
  }
  return undefined
}

function tokenNamesCredentialPath(tok: string): string | undefined {
  const clean = tok.replace(/^[-A-Za-z0-9]+=|^["']|["']$/g, "").trim()
  if (!clean) return undefined
  const norm = clean.replaceAll("\\", "/").toLowerCase()
  const base = path.basename(norm)
  if (isEnvStyleSecretFile(base)) return `references secret file '${base}'`
  if (isCredentialFile(clean, { forWrite: false })) return `references credential path '${clean}'`
  if (/(?:^|\/)\.e\*|(?:^|\/)\.s\*\//.test(norm)) return `uses glob matching credential path '${clean}'`
  return undefined
}

function classifyInlineCodeRisk(interpreter: string, code: string): CommandRiskClass {
  const lower = code.toLowerCase()
  if (
    /\b(?:os\.remove|os\.unlink|shutil\.rmtree|pathlib\.path\([^)]*\)\.unlink|fs\.rm|fs\.unlink|remove-item)\b/i.test(
      code,
    )
  ) {
    return { kind: "ask_always", reason: `${interpreter} inline script deletes files` }
  }
  if (isEnvStyleSecretFile(code) || /\.env\b|venice_api_key|nano_gpt_api_key|poe_api_key/i.test(lower)) {
    return { kind: "ask_always", reason: `${interpreter} inline script accesses secret/credential data` }
  }
  if (
    /\b(?:subprocess|os\.system|os\.popen|child_process|bun\.spawn|urllib|requests\.|httpx\.|aiohttp|socket\.|fetch\s*\()\b/i.test(
      code,
    )
  ) {
    return { kind: "ask_default", reason: `${interpreter} inline script runs subprocesses or network requests` }
  }
  return { kind: "safe" }
}

const DANGEROUS_ENV_OVERRIDES = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "BASH_ENV",
  "ENV",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
])

function classifySingleSegment(tokens: readonly string[], depth: number): CommandRiskClass {
  if (tokens.length === 0) return { kind: "safe" }
  const { envVars, argv, usedSudo } = stripLeadingEnvAndWrappers(tokens)

  if (usedSudo) {
    return { kind: "ask_always", reason: "uses privilege escalation (sudo/su/doas/runas)" }
  }

  for (const ev of envVars) {
    const upper = ev.key.toUpperCase()
    if (DANGEROUS_ENV_OVERRIDES.has(upper)) {
      if (upper === "NODE_OPTIONS" && /^--max-old-space-size=\d+$/.test(ev.value)) continue
      return { kind: "ask_always", reason: `sets sensitive environment override '${ev.key}'` }
    }
  }

  if (argv.length === 0) return { kind: "safe" }

  const rawCmd = argv[0]!
  if (rawCmd.includes("$") || rawCmd.includes("`") || rawCmd.includes("{")) {
    return { kind: "ask_always", reason: `command name '${rawCmd}' is constructed dynamically` }
  }

  const cmd = path.basename(rawCmd).replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase()
  const rest = argv.slice(1)

  // Unwrap subshells: bash -c "...", sh -c "...", pwsh -Command "..."
  if (["sh", "bash", "zsh", "dash", "ksh", "pwsh", "powershell", "cmd"].includes(cmd)) {
    const line = wrappedCommand(argv)[0]
    if (line) return classifyShellCommand(line, undefined, depth + 1)
  }

  // `eval` runs its arguments as one command line. The shell expands variables and substitutions in them first, so
  // their values run as commands too, and what those are is only known when it runs.
  if (cmd === "eval") {
    const line = wrappedCommand(argv)[0] ?? ""
    const inner = classifyShellCommand(line, undefined, depth + 1)
    if (inner.kind === "deny" || inner.kind === "ask_always" || !/[$`]/.test(line)) return inner
    return { kind: "ask_always", reason: "eval runs text that includes variables or command output" }
  }

  // Unwrap xargs <subcommand>
  if (cmd === "xargs" && rest.length > 0) {
    const subIdx = rest.findIndex((t, at) => !t.startsWith("-") && !XARGS_VALUE_OPTIONS.includes(rest[at - 1] ?? ""))
    if (subIdx !== -1) {
      return classifySingleSegment(rest.slice(subIdx), depth + 1)
    }
  }

  // Inline code interpreters: python -c, node -e, bun -e, sed s///e
  if (["python", "python3", "py"].includes(cmd)) {
    const cIdx = rest.indexOf("-c")
    if (cIdx !== -1 && rest[cIdx + 1]) {
      return classifyInlineCodeRisk(cmd, rest[cIdx + 1]!)
    }
  }
  if (["node", "bun", "deno"].includes(cmd)) {
    const eIdx = rest.findIndex((t) => t === "-e" || t === "--eval" || t === "-p" || t === "--print")
    if (eIdx !== -1 && rest[eIdx + 1]) {
      return classifyInlineCodeRisk(cmd, rest[eIdx + 1]!)
    }
  }
  if (cmd === "sed" && rest.some((t) => /^s\/.*\/.*\/[A-Za-z]*e/.test(t))) {
    return { kind: "ask_always", reason: "sed 'e' flag executes shell commands" }
  }

  // File deletions & destructive tools -> ask_always
  if (["rm", "rmdir", "del", "erase", "remove-item", "unlink", "shred"].includes(cmd)) {
    return { kind: "ask_always", reason: `deletes files or directories (${cmd})` }
  }
  if (cmd === "find" && rest.some((t) => t === "-delete" || t === "-exec" || t === "-execdir")) {
    return { kind: "ask_always", reason: "find with -delete/-exec mutates or executes across files" }
  }
  if (cmd === "rsync" && rest.some((t) => t.startsWith("--delete"))) {
    return { kind: "ask_always", reason: "rsync --delete removes destination files" }
  }

  // Process termination -> ask_always
  if (["kill", "killall", "pkill", "taskkill", "stop-process"].includes(cmd)) {
    return { kind: "ask_always", reason: `terminates running processes (${cmd})` }
  }

  // Outbound / remote shell / exfiltration -> ask_always
  if (["scp", "sftp", "ssh", "nc", "ncat", "netcat", "telnet", "socat", "ftp"].includes(cmd)) {
    return { kind: "ask_always", reason: `opens remote network/shell connection (${cmd})` }
  }
  if (["curl", "wget", "invoke-webrequest", "invoke-restmethod", "iwr", "irm"].includes(cmd)) {
    const sendsData = rest.some((t) =>
      /^-(?:d|F|T|-data(?:-raw|-binary|-urlencode)?|-form|-upload-file)$/.test(t) ||
      /^-(?:X|-request|-method)$/i.test(t),
    )
    const methodIdx = rest.findIndex((t) => /^-(?:X|-request|-method)$/i.test(t))
    const methodVal = methodIdx !== -1 ? (rest[methodIdx + 1] ?? "").toUpperCase() : "GET"
    if (sendsData && methodVal !== "GET" && methodVal !== "HEAD") {
      return { kind: "ask_always", reason: `${cmd} sends outbound request payload or non-GET method` }
    }
    if (rest.some((t) => t.includes("$(") || t.includes("`"))) {
      return { kind: "ask_always", reason: `${cmd} URL/arguments embed command substitution output` }
    }
    const outIdx = rest.findIndex((t) => t === "-o" || t === "--output" || t === "-O" || t === "-OutFile")
    if (outIdx !== -1 && rest[outIdx + 1]) {
      const outside = tokenReferencesPathOutsideOrGit(rest[outIdx + 1]!)
      if (outside) return { kind: "ask_always", reason: `${cmd} output ${outside}` }
    }
    return { kind: "ask_default", reason: `${cmd} performs network request` }
  }

  // Process env / infra secret dumps -> ask_always
  if (cmd === "ps" && rest.some((t) => /e/.test(t) && !t.startsWith("--"))) {
    return { kind: "ask_always", reason: "ps with environment flag prints process secrets" }
  }
  if (["printenv", "set"].includes(cmd) && rest.length === 0) {
    return { kind: "ask_default", reason: `prints shell environment (${cmd})` }
  }
  if (cmd === "kubectl") {
    if (rest.some((t) => t === "secret" || t === "secrets" || t === "-s" || t.startsWith("--server"))) {
      return { kind: "ask_always", reason: "kubectl accesses secrets or custom remote server" }
    }
    if (rest.includes("apply") && !rest.some((t) => t.startsWith("--dry-run"))) {
      return { kind: "ask_default", reason: "kubectl apply mutates cluster resources" }
    }
  }
  if (cmd === "helm" && rest[0] === "get" && rest[1] === "values") {
    return { kind: "ask_always", reason: "helm get values may print stored release secrets" }
  }
  if (cmd === "terraform") {
    if ((rest[0] === "state" && rest[1] === "pull") || (rest[0] === "output" && rest.includes("-json"))) {
      return { kind: "ask_always", reason: "terraform state/output dump may expose stored secrets" }
    }
    if (rest.some((t) => t.includes(".tfvars") || t.includes(".tfstate"))) {
      return { kind: "ask_always", reason: "terraform command reads .tfvars/.tfstate secrets" }
    }
  }
  if (cmd === "docker") {
    if (rest.some((t) => t === "-H" || t.startsWith("--host"))) {
      return { kind: "ask_always", reason: "docker connects to remote daemon host" }
    }
    if (["run", "exec", "compose"].includes(rest[0] ?? "")) {
      return { kind: "ask_default", reason: `docker ${rest[0]} launches or enters containers` }
    }
  }

  // Git subcommand classification
  if (cmd === "git") {
    const subIdx = rest.findIndex((t) => !t.startsWith("-"))
    const sub = subIdx !== -1 ? rest[subIdx]! : ""
    if (!sub) return { kind: "safe" }
    if (sub.includes("$") || sub.includes("`") || sub.includes("{")) {
      return { kind: "ask_always", reason: `git subcommand '${sub}' is constructed dynamically` }
    }
    const subLower = sub.toLowerCase()
    if (["push", "rm", "clean", "restore"].includes(subLower)) {
      return { kind: "ask_always", reason: `destructive or remote git '${subLower}'` }
    }
    if (subLower === "reset" && rest.some((t) => t === "--hard" || t === "--merge")) {
      return { kind: "ask_always", reason: "git reset --hard discards uncommitted work" }
    }
    if (subLower === "branch" && rest.some((t) => t === "-D" || t === "-f" || t === "--force")) {
      return { kind: "ask_always", reason: "git branch force-delete or overwrite" }
    }
    if (subLower === "checkout" && rest.some((t) => t === "--" || t === "-B" || t === "-f")) {
      return { kind: "ask_always", reason: "git checkout overwrites working tree files or branch" }
    }
    if (subLower === "config" && rest.some((t) => t === "--global" || t === "--system")) {
      return { kind: "ask_default", reason: "mutates global/system git configuration" }
    }
    return { kind: "safe" }
  }

  // Package / toolchain installs & dev servers -> ask_default (runs in Auto & Turbo, asks in Default & Review)
  if (["pip", "pip3", "pipx"].includes(cmd) && rest.includes("install")) {
    return { kind: "ask_default", reason: `${cmd} install installs Python packages` }
  }
  if (cmd === "uv" && (rest.includes("add") || rest.includes("install") || rest[0] === "run")) {
    return { kind: "ask_default", reason: `uv ${rest[0] ?? "command"} installs or runs packages` }
  }
  if (["poetry", "bundle", "composer", "gem"].includes(cmd) && ["add", "install", "require"].includes(rest[0] ?? "")) {
    return { kind: "ask_default", reason: `${cmd} ${rest[0]} installs dependencies` }
  }
  if (["cargo", "rustup"].includes(cmd) && ["add", "install", "update"].includes(rest[0] ?? "")) {
    return { kind: "ask_default", reason: `${cmd} ${rest[0]} installs Rust crates/toolchains` }
  }
  if (["brew", "winget", "choco", "apt", "apt-get", "dnf", "pacman", "pyenv", "nvm", "fnm"].includes(cmd)) {
    return { kind: "ask_default", reason: `${cmd} manages system/toolchain packages` }
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(cmd)) {
    const sub = (rest[0] ?? "").toLowerCase()
    if (sub === "config" && rest.includes("set")) {
      return { kind: "ask_always", reason: `${cmd} config set modifies package manager settings` }
    }
    if (["add", "i", "install"].includes(sub)) {
      const namedPkg = rest.slice(1).some((t) => !t.startsWith("-"))
      if (namedPkg) {
        return { kind: "ask_default", reason: `${cmd} ${sub} installs named package(s)` }
      }
    }
    if (sub === "dlx" || sub === "create" || sub === "x") {
      return { kind: "ask_default", reason: `${cmd} ${sub} downloads and executes packages` }
    }
    if ((sub === "run" && ["dev", "start", "serve"].includes((rest[1] ?? "").toLowerCase())) || sub === "dev") {
      return { kind: "ask_default", reason: `${cmd} starts a dev server` }
    }
  }
  if (cmd === "npx") {
    const pkg = rest.find((t) => !t.startsWith("-")) ?? ""
    const localBin = pkg ? path.join(process.cwd(), "node_modules", ".bin", pkg) : ""
    if (!pkg || (!fs.existsSync(localBin) && !fs.existsSync(`${localBin}.cmd`))) {
      return { kind: "ask_default", reason: `npx '${pkg}' may download and execute an external package` }
    }
  }
  if ((cmd === "go" || cmd === "deno") && rest[0] === "run") {
    return { kind: "ask_default", reason: `${cmd} run executes code that may fetch remote modules` }
  }

  // Check arguments for credential files (except mere existence checks like `test -f .env` or `ls .env`)
  const isExistenceListingOnly = ["ls", "dir", "test", "[", "stat"].includes(cmd)
  if (!isExistenceListingOnly) {
    for (const arg of rest) {
      const credReason = tokenNamesCredentialPath(arg)
      if (credReason) {
        return { kind: "ask_always", reason: `${cmd} ${credReason}` }
      }
    }
  }

  // Check file-writing commands targeting outside repo or .git
  if (["cp", "mv", "Copy-Item", "Move-Item", "Set-Content", "Out-File", "Add-Content", "tee", "tar", "unzip"].includes(cmd)) {
    for (const arg of rest) {
      const outReason = tokenReferencesPathOutsideOrGit(arg)
      if (outReason) {
        return { kind: "ask_always", reason: `${cmd} ${outReason}` }
      }
    }
  }

  // Output flags (-o / --output) writing outside repo or into .git
  for (let idx = 0; idx < rest.length - 1; idx++) {
    if (rest[idx] === "-o" || rest[idx] === "--output") {
      const outReason = tokenReferencesPathOutsideOrGit(rest[idx + 1]!)
      if (outReason) return { kind: "ask_always", reason: `${cmd} -o ${outReason}` }
    }
  }

  return { kind: "safe" }
}

const RISK_PRIORITY: Readonly<Record<CommandRiskClass["kind"], number>> = {
  safe: 0,
  ask_default: 1,
  ask_always: 2,
  deny: 3,
}

function higherRisk(a: CommandRiskClass, b: CommandRiskClass): CommandRiskClass {
  return RISK_PRIORITY[b.kind] > RISK_PRIORITY[a.kind] ? b : a
}

export function classifyShellCommand(command: string, cwd?: string, depth = 0): CommandRiskClass {
  if (depth > 6) {
    return { kind: "ask_always", reason: "deeply nested shell command wrapper" }
  }

  // The never-permitted list reads the words of the whole command once, at the top, and sees its substitutions and
  // wrapped commands from there; a substitution found in a quoted heredoc's body below is data.
  const catastrophic = classifyCatastrophicCommand(command, undefined, depth > 0)
  if (catastrophic) return { kind: "deny", reason: catastrophic }

  const envStage = commandStagesSecretEnvFile(command, cwd)
  if (envStage) return { kind: "deny", reason: envStage }

  const scanned = scanShellCommandStructure(command)
  if (scanned.unclosedQuote) {
    return { kind: "ask_always", reason: "command has unclosed quotes or incomplete substitution" }
  }
  if (scanned.ambiguousExpansion) {
    return { kind: "ask_always", reason: "command contains ambiguous parameter/process substitution" }
  }

  let worst: CommandRiskClass = { kind: "safe" }

  for (const target of scanned.redirectionTargets) {
    const cred = tokenNamesCredentialPath(target)
    if (cred) worst = higherRisk(worst, { kind: "ask_always", reason: `shell redirection ${cred}` })
    const out = tokenReferencesPathOutsideOrGit(target)
    if (out) worst = higherRisk(worst, { kind: "ask_always", reason: `shell redirection ${out}` })
  }

  for (const sub of scanned.nestedSnippets) {
    worst = higherRisk(worst, classifyShellCommand(sub, cwd, depth + 1))
    if (worst.kind === "deny") return worst
  }

  for (const seg of scanned.segments) {
    worst = higherRisk(worst, classifySingleSegment(seg, depth))
    if (worst.kind === "deny") return worst
  }

  return worst
}

export function evaluateShellPolicyDecision(
  tier: PolicyTier,
  command: string,
  baseEffect: "allow" | "ask" | "deny",
  cwd?: string,
): { readonly effect: "allow" | "ask" | "deny"; readonly message?: string } {
  const risk = classifyShellCommand(command, cwd)
  if (risk.kind === "deny") {
    return { effect: "deny", message: risk.reason }
  }
  if (baseEffect === "deny") {
    return { effect: "deny" }
  }
  if (tier === "request_review") {
    return {
      effect: "ask",
      message:
        risk.kind !== "safe"
          ? `Request Review policy (${risk.reason}): confirm before running.`
          : "Request Review policy: asks before every shell command.",
    }
  }
  if (tier === "turbo") {
    return { effect: "allow" }
  }
  if (tier === "auto") {
    if (risk.kind === "ask_always") {
      return { effect: "ask", message: `Auto policy: ${risk.reason}.` }
    }
    return { effect: "allow" }
  }
  // "default" tier: ask on both ask_always and ask_default
  if (risk.kind === "ask_always" || risk.kind === "ask_default") {
    return { effect: "ask", message: `Default policy: ${risk.reason}.` }
  }
  return { effect: baseEffect }
}

export interface ShellScanOptions {
  /** The folder the command runs in, as the shell tool's `workdir` gives it; `dirs.cwd` when unset. */
  readonly workdir?: string
  /** Also read the command as PowerShell, the default shell on Windows. */
  readonly powershell?: boolean
}

/**
 * The engine config files a shell command visibly writes: output redirection targets, the files given to common
 * writing commands, files written into a config folder the command works in, and the same inside `sh -c`, `eval` and
 * `$(...)`, each resolved against the folder its command runs in. A file name built at run time, or a program that
 * writes files on its own, is not seen.
 */
export function shellConfigWrites(command: string, dirs: EngineConfigDirs, options?: ShellScanOptions): string[] {
  const cwd = options?.workdir === undefined ? dirs.cwd : resolveShellPath(options.workdir, dirs.cwd, dirs.home)
  const readings = [preparePosix(command), ...(options?.powershell ? [preparePowerShell(command)] : [])]
  return [...new Set(readings.flatMap((reading) => configWritesIn(reading, cwd, dirs, 0)))]
}

function configWritesIn(command: string, cwd: string, dirs: EngineConfigDirs, depth: number): string[] {
  if (depth > 6) return []
  const scanned = scanShellCommandStructure(command)
  // The scanner leaves an input redirection among the words, and it is not one of the command's operands:
  // `cp a b < /dev/null`, `cp a b 0</dev/null`, `cp a b <<- EOF`. A process substitution `<(...)` is an operand.
  const commands = scanned.segments
    .map((segment) =>
      segment.filter(
        (word, index) => !/^\d*<+(?!\()/.test(word) && !/^\d*(?:<<-|<+&?)$/.test(segment[index - 1] ?? ""),
      ),
    )
    .map((segment) => stripLeadingEnvAndWrappers(dropWrapperOptionValues(segment)).argv)
  // folders[i] is the folder command i runs in: a `cd` changes it for the commands after it.
  const folders = commands.reduce(
    (visited, argv) => {
      const folder = visited.at(-1) ?? cwd
      const target = changedDirectory(argv)
      return [...visited, target === undefined ? folder : resolveShellPath(target, folder, dirs.home)]
    },
    [cwd],
  )
  const folderOf = (segment: number) => folders[segment] ?? folders.at(-1) ?? cwd
  const written = [
    ...scanned.redirections.map((item) => resolveShellPath(item.target, folderOf(item.segment), dirs.home)),
    ...commands.flatMap((argv, index) => {
      const folder = folderOf(index)
      return writtenFiles(argv).flatMap((target) => {
        // Sources land in a destination under their own names only when it is a folder.
        const into = target.into
        const folderLike = into === undefined || /(?:^\.\.?|[\\/])$/.test(into)
        if (into !== undefined && !folderLike && !isDirectory(resolveShellPath(into, folder, dirs.home))) return []
        return [resolveShellPath(target.file, folder, dirs.home)]
      })
    }),
  ]
  const nested = [
    ...scanned.nested.map((item) => ({ snippet: item.snippet, folder: folderOf(item.segment) })),
    ...commands.flatMap((argv, index) => wrappedCommand(argv).map((snippet) => ({ snippet, folder: folderOf(index) }))),
  ].flatMap((item) => configWritesIn(item.snippet, item.folder, dirs, depth + 1))
  return [...written.filter((file) => isEngineConfigPath(file, dirs)), ...nested]
}

// Heredoc bodies are data, not commands, and `${...}` becomes what it expands to, because the scanner splits at braces.
function preparePosix(command: string): string {
  return expandBraceVariables(stripHeredocBodies(command))
}

// PowerShell reads `\` as a plain path separator, backtick as its escape character and `$env:NAME` as a variable, and a
// here-string holds data, so the command is rewritten into the shape the POSIX scanner reads.
function preparePowerShell(command: string): string {
  return expandBraceVariables(
    command
      .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''")
      .replace(/`\r?\n/g, " ")
      .replace(/`(.)/g, "$1")
      .replaceAll("\\", "/")
      .replace(/\$\{env:([A-Za-z_]\w*)\}|\$env:([A-Za-z_]\w*)/gi, (_, braced, bare) => `$${braced ?? bare}`),
  )
}

// `literalOnly` keeps the bodies the shell expands (`<<EOF`), whose command substitutions run.
function stripHeredocBodies(command: string, literalOnly = false): string {
  const start: { readonly kept: readonly string[]; readonly until?: string; readonly tabs: boolean } = {
    kept: [],
    tabs: false,
  }
  return command
    .split("\n")
    .reduce((state, line) => {
      if (state.until !== undefined) {
        const ended = (state.tabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === state.until
        return ended ? { kept: state.kept, tabs: false } : state
      }
      const marker = /<<(-?)\s*\\?(['"]?)([A-Za-z_][\w.-]*)\2/.exec(line.replaceAll("<<<", "   "))
      const until = literalOnly && !/['"\\]/.test(marker?.[0] ?? "") ? undefined : marker?.[3]
      return { kept: [...state.kept, line], until, tabs: marker?.[1] === "-" }
    }, start)
    .kept.join("\n")
}

// `${NAME}`, `${NAME:-default}` and the like, from the engine's environment. HOME and PWD stay variables, which
// resolveShellPath reads as the given home and folder.
function expandBraceVariables(command: string): string {
  return command.replace(/\$\{([A-Za-z_]\w*)(?:(:?)([-=+?])([^}]*))?\}/g, (_, name, colon, operator, word) => {
    if (operator === undefined || name === "HOME" || name === "PWD") return `$${name}`
    const value = process.env[name]
    const unset = value === undefined || (colon === ":" && value === "")
    if (operator === "+") return unset ? "" : word
    // The shell stops at `${NAME:?}` when NAME is unset or empty, so it never stands for an empty word.
    if (operator === "?" && colon === ":") return unset ? `$${name}` : (value ?? "")
    return unset && operator !== "?" ? word : (value ?? "")
  })
}

function resolveShellPath(token: string, folder: string, home: string): string {
  return path.resolve(folder, FSUtil.windowsPath(expandShellPath(token, folder, home)))
}

// A file a command writes. `into` marks a destination that the sources land inside when it is a folder.
type WrittenFile = { readonly file: string; readonly into?: string }

// The files a command writes, read from its arguments; "." stands for files it writes into the folder it runs in.
function writtenFiles(argv: readonly string[]): WrittenFile[] {
  const name = commandName(argv)
  const args = argv.slice(1)
  const positional = args.filter((arg) => !arg.startsWith("-"))
  const files = (list: readonly string[]) => list.map((file) => ({ file }))
  // Long options also as `--name=value`, and PowerShell parameter names such as `-Destination` in any case.
  const valuesOf = (flags: readonly string[]) =>
    args.flatMap((arg, index) => {
      const long = flags.find((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`))
      if (long) return [arg.slice(long.length + 1)]
      const value = args[index + 1]
      const named =
        flags.includes(arg) ||
        (/^-[a-z]{2,}$/i.test(arg) && flags.some((flag) => flag.toLowerCase() === arg.toLowerCase()))
      return named && value !== undefined ? [value] : []
    })
  if (["tee", "touch", "truncate", "set-content", "sc", "add-content", "ac", "out-file", "tee-object"].includes(name))
    return files(positional)
  if (name === "new-item" || name === "ni") {
    const folder = valuesOf(["-Path"]).at(0)
    const named = valuesOf(["-Name"]).map((item) => (folder === undefined ? item : path.join(folder, item)))
    return files([...positional, ...named])
  }
  if (["cp", "mv", "install", "ln", "rsync", "copy-item", "cpi", "copy", "move-item", "mi", "move"].includes(name)) {
    const only = positional.length === 1 ? positional[0] : undefined
    // A link given only its target is made in the current folder under the target's name.
    if (name === "ln" && only !== undefined) return files([path.basename(only)])
    const directory = valuesOf(["-t", "--target-directory", "-Destination"]).at(0)
    const destination = directory ?? positional.at(-1)
    if (destination === undefined) return []
    const operands = directory === undefined ? positional.slice(0, -1) : positional
    const sources = operands.filter((item) => item !== destination)
    // A move also changes where its sources were.
    const moved = ["mv", "move-item", "mi", "move"].includes(name) ? sources : []
    return [
      { file: destination },
      ...sources.map((source) => ({ file: path.join(destination, path.basename(source)), into: destination })),
      ...files(moved),
    ]
  }
  if (["rename-item", "ren", "rni"].includes(name)) {
    const source = valuesOf(["-Path", "-LiteralPath"]).at(0) ?? positional[0]
    const renamed = valuesOf(["-NewName"]).at(0) ?? positional[1]
    if (source === undefined || renamed === undefined) return []
    return files([source, path.join(path.dirname(source), renamed)])
  }
  if (name === "expand-archive") return files([valuesOf(["-DestinationPath"]).at(0) ?? positional[1] ?? "."])
  if (name === "sed" || name === "perl") {
    if (!args.some((arg) => /^-[a-z]*i/i.test(arg) || arg.startsWith("--in-place"))) return []
    const scripts = new Set(valuesOf(name === "sed" ? ["-e", "--expression", "-f", "--file"] : ["-e", "-E"]))
    const operands = positional.filter((arg) => !scripts.has(arg))
    // Without -e or -f the first operand is the script, not a file.
    return files(scripts.size > 0 ? operands : operands.slice(1))
  }
  if (name === "dd") return files(args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)))
  if (name === "curl") {
    // -O, -J and --remote-name save under the remote file's name in the current folder.
    const remote = args.some((arg) => /^--remote-name/.test(arg) || /^-[A-Za-z]*[OJ]/.test(arg))
    return files([...valuesOf(["--output", "--output-dir"]), ...shortValues(args, "o"), ...(remote ? ["."] : [])])
  }
  if (name === "wget") {
    const documents = [...valuesOf(["--output-document"]), ...shortValues(args, "O")].filter((file) => file !== "-")
    const prefixes = [...valuesOf(["--directory-prefix"]), ...shortValues(args, "P")]
    const logs = [...valuesOf(["--output-file"]), ...shortValues(args, "o")]
    const current = documents.length === 0 && prefixes.length === 0 ? ["."] : []
    return files([...documents, ...prefixes, ...logs, ...current])
  }
  if (["invoke-webrequest", "iwr", "invoke-restmethod", "irm"].includes(name)) return files(valuesOf(["-OutFile"]))
  if (name === "tar") {
    const directory = valuesOf(["-C", "--directory"])
    const extracting = args.some(
      (arg, index) =>
        arg === "--extract" ||
        arg === "--get" ||
        (!arg.startsWith("--") && (index === 0 || arg.startsWith("-")) && /^-?[A-Za-z]*x/.test(arg)),
    )
    return files([...directory, ...(extracting && directory.length === 0 ? ["."] : [])])
  }
  if (name === "unzip") {
    const directory = valuesOf(["-d"])
    const listing = args.some((arg) => /^-[ltvZ]/.test(arg))
    return files([...directory, ...(directory.length === 0 && !listing ? ["."] : [])])
  }
  return []
}

// A short option that takes a value, also inside a cluster such as `-fsSLo file` or attached as `-ofile`.
function shortValues(args: readonly string[], letter: string): string[] {
  return args.flatMap((arg, index) => {
    const match = arg.startsWith("--") ? null : new RegExp(`^-[A-Za-z]*?${letter}(.*)$`).exec(arg)
    if (!match) return []
    const value = match[1] ? match[1] : args[index + 1]
    return value === undefined ? [] : [value]
  })
}

// Options of wrapper commands that take a value, so the value is not read as the command the wrapper runs.
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"],
  doas: ["-u", "-C"],
  nice: ["-n"],
  env: ["-u", "-C", "-S"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  stdbuf: ["-i", "-o", "-e"],
  ionice: ["-c", "-n"],
}

// A loop, not a recursion: every command the engine starts passes through here, and a long run of wrapper words must
// neither take seconds nor overflow the stack.
function dropWrapperOptionValues(tokens: readonly string[]): readonly string[] {
  const kept: string[] = []
  let at = 0
  while (at < tokens.length) {
    const name = path.basename(tokens[at]!).toLowerCase()
    // `su [user] -c command` runs the command in a shell; its user name would otherwise read as the command.
    const c = name === "su" ? tokens.indexOf("-c", at) : -1
    if (c !== -1 && tokens[c + 1] !== undefined) return [...kept, "sh", "-c", tokens[c + 1]!]
    const options = WRAPPER_VALUE_OPTIONS[name]
    if (options === undefined) break
    kept.push(tokens[at]!)
    at++
    while (tokens[at]?.startsWith("-")) at += options.includes(tokens[at]!) ? 2 : 1
  }
  return [...kept, ...tokens.slice(at)]
}

const XARGS_VALUE_OPTIONS = ["-n", "-L", "-P", "-s", "-I", "-E", "-d", "-a", "--max-args", "--max-procs", "--arg-file"]

// The command a wrapper runs: `sh -c '...'` and other shells' equivalents, `eval '...'`, and `xargs <command>`.
function wrappedCommand(argv: readonly string[]): string[] {
  const name = commandName(argv)
  const rest = argv.slice(1)
  if (["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"].includes(name)) {
    const index = rest.findIndex((arg) => /^-(?:[A-Za-z]*c|command)$/i.test(arg) || arg.toLowerCase() === "/c")
    const after = index === -1 ? [] : rest.slice(index + 1)
    // A POSIX shell also reads options after -c (`sh -c -e 'text'`, `sh -c -o pipefail 'text'`), and `--` ends them,
    // so the text is the next word that is not an option. PowerShell and cmd take the next word whatever it is.
    const start = ["pwsh", "powershell", "cmd"].includes(name)
      ? 0
      : after.findIndex(
          (arg, at) => arg === "--" || (!/^[-+]/.test(arg) && !/^[-+][a-z]*o$/i.test(after[at - 1] ?? "")),
        )
    const inner = after[start] === "--" ? after[start + 1] : after[start]
    return inner === undefined ? [] : [inner]
  }
  // eval joins its words with spaces, as the shell does; `--` only ends its options.
  if (name === "eval") return [(rest[0] === "--" ? rest.slice(1) : rest).join(" ")]
  if (name === "xargs") {
    const index = rest.findIndex((arg, at) => !arg.startsWith("-") && !XARGS_VALUE_OPTIONS.includes(rest[at - 1] ?? ""))
    if (index === -1) return []
    // xargs passes its words on as they are, so each is quoted to stay one word when the command is read again.
    const quoted = rest.slice(index).map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
    return [quoted.join(" ")]
  }
  return []
}

// The folder a `cd`-like command changes into; undefined when it changes nothing this scan can follow.
function changedDirectory(argv: readonly string[]): string | undefined {
  if (!["cd", "pushd", "chdir", "set-location", "sl", "push-location"].includes(commandName(argv))) return undefined
  const args = argv.slice(1).filter((arg) => arg.toLowerCase() !== "/d")
  if (args.includes("-")) return undefined
  return args.find((arg) => !arg.startsWith("-")) ?? "~"
}

function commandName(argv: readonly string[]): string {
  return path
    .basename(argv[0] ?? "")
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase()
}

// `~`, `$HOME`, `$PWD` and other variables from the engine's environment, which the shell inherits.
function expandShellPath(token: string, folder: string, home: string): string {
  const tilde = token === "~" || /^~[\\/]/.test(token) ? `${home}${token.slice(1)}` : token
  return tilde.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (match, braced, bare) => {
    const name = braced ?? bare
    if (name === "HOME") return home
    if (name === "PWD") return folder
    return process.env[name] ?? match
  })
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory()
  } catch {
    return false
  }
}

// ============================================================================
// Socket/DNS/Redirect SSRF Guard + Self-API Shield (MultiCode fetch_guard Parity)
// ============================================================================

export type AddressKind = "public" | "local" | "blocked"

const CLOUD_METADATA_BLOCKED = new Set([
  "169.254.169.254",
  "100.100.100.200", // Alibaba Cloud IMDS
  "168.63.129.16", // Azure WireServer
  "fd00:ec2::254", // AWS IPv6 IMDS
])

function parseIpv4Octets(ip: string): readonly [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return null
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const
  if (nums.some((n) => n < 0 || n > 255)) return null
  return nums
}

function extractEmbeddedIpv4FromIpv6(rawIpv6: string): string | null {
  const lower = rawIpv6.trim().toLowerCase().split("%")[0] ?? ""
  // Dotted ::ffff:127.0.0.1 or 64:ff9b::127.0.0.1
  const dotted = /^(?:::ffff:|0:0:0:0:0:ffff:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)
  if (dotted?.[1]) return dotted[1]

  // Hex ::ffff:7f00:0001 or 64:ff9b::7f00:1
  const hexMapped = /^(?:::ffff:|0:0:0:0:0:ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hexMapped?.[1] && hexMapped[2]) {
    const hi = Number.parseInt(hexMapped[1], 16)
    const lo = Number.parseInt(hexMapped[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

export function classifyIpAddress(rawIp: string): AddressKind {
  const clean = rawIp.trim().replace(/^\[|\]$/g, "").toLowerCase().split("%")[0] ?? ""
  if (!clean) return "blocked"
  if (CLOUD_METADATA_BLOCKED.has(clean)) return "blocked"

  const embeddedV4 = extractEmbeddedIpv4FromIpv6(clean)
  if (embeddedV4) return classifyIpAddress(embeddedV4)

  const octets = parseIpv4Octets(clean)
  if (octets) {
    const [a, b] = octets
    if (a === 0) return "blocked" // 0.0.0.0/8
    if (a === 169 && b === 254) return "blocked" // Link-local & cloud metadata 169.254.0.0/16
    if (a >= 224) return "blocked" // Multicast & reserved 224.0.0.0/4+
    if (a === 127) return "local" // Loopback 127.0.0.0/8
    if (a === 10) return "local" // Private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return "local" // Private 172.16.0.0/12
    if (a === 192 && b === 168) return "local" // Private 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return "local" // CGNAT / Tailscale 100.64.0.0/10
    if (a === 192 && b === 0) return "blocked"
    if (a === 198 && (b === 18 || b === 19)) return "blocked"
    return "public"
  }

  if (net.isIPv6(clean)) {
    if (clean === "::") return "blocked"
    if (clean === "::1") return "local"
    if (clean.startsWith("fe8") || clean.startsWith("fe9") || clean.startsWith("fea") || clean.startsWith("feb")) {
      return "blocked" // IPv6 link-local fe80::/10
    }
    if (clean.startsWith("ff")) return "blocked" // IPv6 multicast ff00::/8
    if (clean.startsWith("fc") || clean.startsWith("fd") || clean.startsWith("fec") || clean.startsWith("fed") || clean.startsWith("fee") || clean.startsWith("fef")) {
      return "local" // IPv6 ULA fc00::/7 (including Tailscale fd7a:...) & site-local fec0::/10
    }
    if (clean.startsWith("2001:db8:")) return "blocked" // Documentation
    return "public"
  }

  return "blocked"
}

export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true
  if (host.startsWith("127.")) return classifyIpAddress(host) === "local"
  const mapped = extractEmbeddedIpv4FromIpv6(host)
  if (mapped && mapped.startsWith("127.")) return classifyIpAddress(mapped) === "local"
  return false
}

function isProtectedSelfApiPath(parsed: URL, ownServerPort?: number): boolean {
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!isLoopbackHost(host) && !host.endsWith(".ts.net") && classifyIpAddress(host) !== "local") {
    return false
  }
  const pathname = parsed.pathname.toLowerCase()
  if (pathname === "/api/health" || pathname === "/health") return false
  if (ownServerPort && Number(parsed.port || 80) === ownServerPort) {
    return true
  }
  // Protect ABuCode / OpenCode / MultiCode control plane endpoints on loopback
  if (
    pathname.startsWith("/api/providers") ||
    pathname.startsWith("/api/chat") ||
    pathname.startsWith("/api/rp") ||
    pathname.startsWith("/rpc/") ||
    pathname.includes("abucode.control")
  ) {
    return true
  }
  return false
}

export function validateFetchUrlGuard(
  rawUrl: string,
  opts?: {
    readonly method?: string
    readonly allowLoopbackGet?: boolean
    readonly allowLocalGet?: boolean
    readonly ownServerPort?: number
  },
): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return `Invalid URL: ${rawUrl}`
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http:// or https://."
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host) return "Missing hostname in URL."

  const method = (opts?.method ?? "GET").trim().toUpperCase()
  const isSafeReadMethod = method === "GET" || method === "HEAD"
  const allowLoopback = opts?.allowLoopbackGet ?? false
  const allowLocal = opts?.allowLocalGet ?? false

  if (isProtectedSelfApiPath(parsed, opts?.ownServerPort)) {
    return `Blocked request to protected local agent/control API '${parsed.pathname}' (Self-API shield).`
  }

  if (host === "0.0.0.0" || host === "::" || host.endsWith(".internal")) {
    return `Blocked wildcard/internal host '${host}' (SSRF guard).`
  }

  if (isLoopbackHost(host)) {
    if (isSafeReadMethod && (allowLoopback || allowLocal)) return undefined
    return `Blocked ${method} request to loopback host '${host}' (SSRF guard).`
  }

  if (host.endsWith(".local") || host.endsWith(".ts.net")) {
    if (isSafeReadMethod && allowLocal) return undefined
    return `Blocked ${method} request to private/tailnet host '${host}' (SSRF guard).`
  }

  if (net.isIP(host) !== 0) {
    const kind = classifyIpAddress(host)
    if (kind === "blocked") {
      return `Blocked reserved/cloud-metadata IP '${host}' (SSRF guard).`
    }
    if (kind === "local") {
      if (isSafeReadMethod && allowLocal) return undefined
      return `Blocked ${method} request to private/local IP '${host}' (SSRF guard).`
    }
  }

  return undefined
}

/**
 * Full async SSRF & DNS-rebinding validator: validates the URL string AND resolves DNS
 * (`dns.promises.lookup(..., { all: true })`) so a domain pointing to `127.0.0.1`,
 * `169.254.169.254`, `fd00:ec2::254`, or LAN/Tailscale IPs cannot bypass URL-string checks.
 */
export async function validateResolvedFetchUrlGuard(
  rawUrl: string,
  opts?: {
    readonly method?: string
    readonly allowLoopbackGet?: boolean
    readonly allowLocalGet?: boolean
    readonly ownServerPort?: number
    readonly lookupFn?: (hostname: string) => Promise<ReadonlyArray<{ readonly address: string }>>
  },
): Promise<string | undefined> {
  const staticErr = validateFetchUrlGuard(rawUrl, opts)
  if (staticErr) return staticErr

  const parsed = new URL(rawUrl.trim())
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || net.isIP(host) !== 0) return undefined

  const method = (opts?.method ?? "GET").trim().toUpperCase()
  const isSafeReadMethod = method === "GET" || method === "HEAD"
  const allowLoopback = opts?.allowLoopbackGet ?? false
  const allowLocal = opts?.allowLocalGet ?? false

  const lookup =
    opts?.lookupFn ??
    ((h: string) => dns.promises.lookup(h, { all: true, verbatim: true }))

  let records: ReadonlyArray<{ readonly address: string }>
  try {
    records = await lookup(host)
  } catch (err) {
    return `DNS resolution failed for '${host}': ${err instanceof Error ? err.message : String(err)}`
  }

  if (records.length === 0) {
    return `DNS resolution returned no addresses for '${host}'.`
  }

  for (const rec of records) {
    const addr = rec.address
    const kind = classifyIpAddress(addr)
    if (kind === "blocked") {
      return `Blocked '${host}' -> '${addr}' (reserved/cloud-metadata address, SSRF guard).`
    }
    if (kind === "local") {
      const loopback = isLoopbackHost(addr)
      if (isSafeReadMethod && ((loopback && allowLoopback) || allowLocal)) {
        continue
      }
      return `Blocked ${method} '${host}' -> '${addr}' (resolves to local/private network, SSRF guard).`
    }
  }

  return undefined
}

/**
 * Redirect-hop-validating fetch wrapper: validates DNS & IP on the initial URL and on every
 * 3xx redirect hop (preserving the initial HTTP method's strictness across redirects so a
 * POST -> 302 -> GET downgrade still cannot reach local/private addresses), while injecting
 * the unremovable `X-ABuCode-Agent` header.
 */
export async function guardedAgentFetch(
  rawUrl: string,
  init?: RequestInit & {
    readonly allowLoopbackGet?: boolean
    readonly allowLocalGet?: boolean
    readonly ownServerPort?: number
    readonly maxRedirects?: number
    readonly lookupFn?: (hostname: string) => Promise<ReadonlyArray<{ readonly address: string }>>
  },
): Promise<Response> {
  const initialMethod = (init?.method ?? "GET").toUpperCase()
  const maxRedirects = init?.maxRedirects ?? 5
  let currentUrl = rawUrl.trim()
  let currentMethod = initialMethod
  let currentBody = init?.body

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Preserve initialMethod strictness on every redirect hop!
    const blockReason = await validateResolvedFetchUrlGuard(currentUrl, {
      method: initialMethod,
      allowLoopbackGet: init?.allowLoopbackGet,
      allowLocalGet: init?.allowLocalGet,
      ownServerPort: init?.ownServerPort,
      lookupFn: init?.lookupFn,
    })
    if (blockReason) {
      throw new Error(blockReason)
    }

    const headers = new Headers(init?.headers)
    headers.set(AGENT_SELF_HEADER, "webfetch")

    const res = await fetch(currentUrl, {
      ...init,
      method: currentMethod,
      body: currentBody,
      headers,
      redirect: "manual",
    })

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location")
      if (!loc) return res
      currentUrl = new URL(loc, currentUrl).toString()
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET"
        currentBody = undefined
      }
      continue
    }

    return res
  }

  throw new Error(`Too many redirects (>${maxRedirects}) while fetching '${rawUrl}'.`)
}

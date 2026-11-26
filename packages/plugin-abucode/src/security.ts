import childProcess from "node:child_process"
import dns from "node:dns"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import type { PolicyTier } from "@opencode/schema/abucode"
import { FSUtil } from "@opencode/util/fs-util"
import { Glob } from "@opencode/util/glob"
import { loadResolvedSecretEnv, PROVIDERS_META, readVaultFiles } from "./providers.js"

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
// path and also for a folder that can be searched but not read; that part then stays as written.
function realPathOf(absolute: string): string {
  // The walk up would recurse once for each segment of a path too long to open.
  if (absolute.length > PATH_MAX) return absolute
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    const parent = path.dirname(absolute)
    if (parent === absolute) return absolute
    return path.join(realPathOf(parent), path.basename(absolute))
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

export interface EngineStateDirs {
  /** The folder a relative path is relative to: the session's Location directory. */
  readonly cwd: string
  /** The user's home folder, which `~` names. */
  readonly home: string
  /** Folders holding the CLI's service files, which carry the server password: the config and state folders. */
  readonly service: readonly string[]
  /** Folders holding the engine's database: the data folder. */
  readonly data: readonly string[]
  /** Database files named outright, such as the one `OPENCODE_DB` names. */
  readonly databases: readonly string[]
}

// The CLI's service config and registration files (`service.json`, `service-<channel>.json` and an older hashed name)
// with the temporary files they are written through, and core's database for any channel with SQLite's side files.
const SERVICE_FILE = /^service(?:-[\w.-]+)?\.json(?:\.[\w-]+\.tmp)?$/
const DATABASE_FILE = /^opencode(?:-[\w.-]+)?\.db(?:-wal|-shm|-journal)?$/
const DATABASE_SIDE_FILES = ["", "-wal", "-shm", "-journal"]
// No path longer than this can be opened, so a longer word gets no file system work.
const PATH_MAX = 4096

/**
 * Whether a path (relative to `cwd`, with `~` for the home folder, as the file tools read it) is one of the engine's own
 * state files: a service file holding the server password and address, or the database holding every session and the
 * Policy tier. With the password a request acts on the engine's API as its owner; a write to the database changes the
 * tier. Links and other spellings of an existing file are followed, hard links included.
 */
export function isEngineStatePath(target: string, dirs: EngineStateDirs): boolean {
  return engineState(dirs).matches(resolveToolPath(target, dirs.cwd, dirs.home))
}

/**
 * Why a file tool may not use `target`: it is one of the engine's own state files, or, for a content search, a folder at
 * or above the folders that hold them. The grep tool reads hidden files and folders too, so a search of the home folder
 * reaches them.
 */
export function engineStateFileReason(
  target: string,
  dirs: EngineStateDirs,
  mode: "read" | "write" | "search",
): string | undefined {
  const state = engineState(dirs)
  const absolute = resolveToolPath(target, dirs.cwd, dirs.home)
  if (state.matches(absolute))
    return `\`${path.basename(absolute)}\` is the ABuCode engine's own state (its password or its database), so the agent's file tools cannot read, search or change it.`
  if (mode !== "search" || !state.below([absolute, state.real(absolute)], false)) return undefined
  return `A search of \`${target}\` would read the ABuCode engine's own state (its password or its database), so the agent's search tools cannot search there. Search a folder below it instead.`
}

/** The CLI's service files in `folders`; a registration file among them names the address of a running engine. */
export function engineServiceFiles(folders: readonly string[]): string[] {
  return listed(folders, SERVICE_FILE)
}

// Commands that read every file below a folder they are given, or copy, pack or compare it, so naming a folder at or
// above the engine's state files names the files too.
const RECURSIVE_READERS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "ggrep",
  "rg",
  "ag",
  "ack",
  "ugrep",
  "ug",
  "tar",
  "bsdtar",
  "gtar",
  "pax",
  "cpio",
  "zip",
  "7z",
  "7za",
  "7zz",
  "diff",
  "cp",
  "gcp",
  "rsync",
  "scp",
  "ditto",
])
// Commands that move, rename or link a file or folder, which puts it under a name the checks do not know.
const MOVERS = new Set(["mv", "gmv", "ln", "link", "rename"])
// Commands whose last operand is where they write, not what they read.
const DESTINATION_LAST = new Set(["cp", "gcp", "rsync", "scp", "ditto", "mv", "gmv", "ln", "link"])
// Interpreters whose inline code can name a folder and act on everything in it. Both patterns read the command with
// its quotes and backslashes removed, as the shell does (`pyth''on3 '-c'` is `python3 -c`).
const INTERPRETERS =
  /(?:^|[\s;&|(`/])(?:python[\d.]*|py|node|bun|deno|perl|ruby|php|osascript|lua|tclsh|rscript|swift|pwsh|powershell)(?:\.exe)?(?=$|[\s;&|)])/i
const INTERPRETER_NAME =
  /^(?:python[\d.]*|py|node|bun|deno|tsx|ts-node|perl|ruby|php|osascript|lua|tclsh|rscript|swift|pwsh|powershell)$/
// An interpreter given its code in the command: after `-c`, `-e` or the like, in a heredoc or a process substitution,
// or piped in.
const INLINE_CODE =
  /\b(?:python[\d.]*|py|node|bun|deno|perl|ruby|php|osascript|lua|tclsh|rscript|swift|pwsh|powershell)(?:\.exe)?\b[^;&|\n]*?\s(?:-[a-z]*[cepr]\b|--eval\b|--print\b|-command\b|eval\b|-(?=\s|$))|<<|<\(|\|\s*(?:python[\d.]*|py|node|bun|deno|perl|ruby|php|lua|tclsh|pwsh|powershell)\b/i
// Folder changes the scan cannot follow: back and forth (`cd -`, `popd`, `~-`), through `CDPATH`, zsh's two-word
// `cd`, a target with a glob, a variable or a substitution, and a `cd` in a subshell or before a pipe, which does not
// reach the commands after it. After one, a relative name of an existing state file counts wherever it points.
const UNTRACKED_CD = new RegExp(
  [
    String.raw`\b(?:cd|chdir|set-location|sl)[ \t]+(?:-(?=$|[\s;&|)])|[^\s;&|]*[*?[$` + "`" + `])`,
    String.raw`\b(?:pushd|popd|push-location|pop-location)\b`,
    String.raw`~[-+](?=$|[\s/])`,
    String.raw`\bCDPATH=`,
    String.raw`\(\s*(?:cd|pushd|chdir)\b`,
    String.raw`\b(?:cd|chdir)\b[^;&|\n]*\|(?!\|)`,
    // Redirections such as `2>/dev/null` or `> log` between or after the words are not words.
    String.raw`\bcd[ \t]+[^\s;&|<>-][^\s;&|<>]*(?:[ \t]+(?:\d*|&)[<>]{1,2}&?[ \t]*[^\s;&|<>]+)*[ \t]+(?!(?:\d*|&)[<>])[^\s;&|#)<>]`,
  ].join("|"),
  "i",
)
// A zsh qualifier list with `D`, which lets one glob match names that start with a dot.
const DOT_QUALIFIER = /\([^()]*D[^()]*\)/

// Whether the command lets a folder reader's `*`, `?` and brackets match names that start with a dot: bash's `dotglob`
// and `GLOBIGNORE`, zsh's `globdots` (also as `noglobdots` unset, `--glob-dots`, `-4` after set, setopt, zsh or
// emulate, and `setopt -m`), or a zsh qualifier list with `D`. Each segment is read in its brace-expanded readings,
// with a `${name:-word}` read as its word and quotes, backslashes and underscores removed, as zsh ignores underscores
// and case in option names. Settings in a shell's startup files are not seen.
function dotGlobbing(command: string): boolean {
  if (DOT_QUALIFIER.test(command)) return true
  const flat = command.replace(/\$\{[A-Za-z_]?\w*:?[-+=?]([^}]*)\}/g, "$1").replace(/['"\\_]/g, "")
  return flat.split(/[;&|\n]/).some((segment) =>
    expandGroups(segment, BRACE_LIST).some(
      (reading) =>
        /dot-?glob|glob-?dots|globignore/i.test(reading) ||
        (/\b(?:set|setopt|unsetopt|zsh|emulate)\b/i.test(reading) && /(?:^|\s)[-+](?:[a-z\d]*4|m)(?=\s|$)/i.test(reading)),
    ),
  )
}

// The command as the scanner reads it: each brace list as the words it stands for, up to five lists, since the scanner
// splits words at braces, and once more with the lists left over, nested ones included, read as `*`, which matches at
// least what they stand for.
function readingsOf(command: string, powershell: boolean | undefined): string[] {
  const expanded = [preparePosix(command), ...(powershell ? [preparePowerShell(command)] : [])].flatMap((reading) =>
    expandGroups(reading, BRACE_LIST),
  )
  return [...expanded, ...expanded.filter((reading) => BRACE_LIST.test(reading)).map(widenBraceLists)]
}

function widenBraceLists(text: string): string {
  const widened = text.replace(BRACE_LISTS, "*")
  return widened !== text && BRACE_LIST.test(widened) ? widenBraceLists(widened) : widened
}

/**
 * The engine's own state files a shell command names (see isEngineStatePath): as a path, after `~`, variables and `cd`;
 * as a glob that matches one or a folder above them; written inside any text of the command, heredoc bodies and inline
 * code included, also relative to the folders it runs in; as a folder at or above them given to a command that reads,
 * copies, moves or links a folder whole, such as `grep -r`, `tar`, `cp -r` or `mv`, or named in an interpreter's code;
 * and every state file in a state folder the command runs in. The same inside `sh -c`, `eval`, `xargs` and `$(...)`. A
 * name built at run time, or one that reaches a command through a pipe or a variable, is not seen.
 */
export function shellEngineStateReferences(
  command: string,
  dirs: EngineStateDirs,
  options?: ShellScanOptions,
): string[] {
  const cwd = options?.workdir === undefined ? dirs.cwd : resolveShellPath(options.workdir, dirs.cwd, dirs.home)
  const state = engineState(dirs)
  // As the shell reads them: `$'...'` decoded, `$"..."` as a plain string, and a backslash-newline joined.
  const decoded = decodeAnsiQuotes(command)
    .replace(/\$(?=")/g, "")
    .replace(/\\\r?\n/g, "")
  const scan: StateScan = {
    home: dirs.home,
    cwd,
    state,
    untracked: UNTRACKED_CD.test(decoded),
    dots: dotGlobbing(decoded),
    names: new Set(state.existing.map(stateFileName)),
    folders: new Set([cwd]),
  }
  // A script a shell reads from a heredoc runs as commands too, in the folder the shell runs in.
  const items = [
    ...readingsOf(decoded, options?.powershell).map((reading) => ({ reading, folder: cwd, depth: 0 })),
    ...shellHeredocScripts(decoded, cwd, dirs.home).flatMap((script) =>
      readingsOf(script.text, false).map((reading) => ({ reading, folder: script.folder, depth: 1 })),
    ),
  ]
  const scanAll = () => items.flatMap((item) => stateReferencesIn(item.reading, item.folder, scan, item.depth))
  // zsh's two-word `cd` inside `eval` or `sh -c` is found after the words before it were read, so they are read again.
  const tracked = !scan.untracked
  const first = scanAll()
  const structural = tracked && scan.untracked ? scanAll() : first
  const runsInside = [...scan.folders].flatMap((folder) =>
    state.isFolder(folder) ? state.existing.filter((file) => containsPath(folder, file)) : [],
  )
  return dedupeReferences([...structural, ...runsInside, ...mentionedState(decoded, scan)], state)
}

type StateScan = {
  readonly home: string
  readonly cwd: string
  readonly state: EngineState
  /** Whether a folder change the scan cannot follow came first; zsh's two-word `cd` sets it as the scan finds one. */
  untracked: boolean
  /** Whether a folder reader's glob matches names that start with a dot (`shopt -s dotglob`, zsh's `(D)`). */
  readonly dots: boolean
  readonly names: ReadonlySet<string>
  /** Every folder a command of the scan runs in. */
  readonly folders: Set<string>
}

function stateReferencesIn(command: string, cwd: string, scan: StateScan, depth: number): string[] {
  if (depth > 6) return []
  const scanned = scanShellCommandStructure(command)
  // The command and its operands, read without its input redirections, as configWritesIn reads them.
  const commands = scanned.segments.map(
    (segment) =>
      stripLeadingEnvAndWrappers(
        dropWrapperOptionValues(
          segment.filter(
            (word, index) => !/^\d*<+(?!\()/.test(word) && !/^\d*(?:<<-|<+&?)$/.test(segment[index - 1] ?? ""),
          ),
        ),
      ).argv,
  )
  // zsh's two-word `cd old new`, whatever options and redirections surround it, replaces `old` in the folder's path, and
  // a target with a glob, as a brace list read as `*` gives one, goes wherever the glob expands.
  if (commands.some((argv) => twoWordCd(argv) || /[*?[]/.test(changedDirectory(argv) ?? ""))) scan.untracked = true
  // folders[i] is the folder command i runs in: a `cd` changes it for the commands after it. A `cd` to a path longer
  // than the system allows fails in the shell too, so the folder stays.
  const folders = commands.reduce<string[]>(
    (visited, argv) => {
      const folder = visited.at(-1) ?? cwd
      const target = changedDirectory(argv)
      const next = target === undefined ? folder : resolveShellPath(target, folder, scan.home)
      visited.push(next.length > PATH_MAX ? folder : next)
      return visited
    },
    [cwd],
  )
  for (const folder of folders) scan.folders.add(folder)
  const folderOf = (segment: number) => folders[segment] ?? folders.at(-1) ?? cwd
  const named = [
    ...scanned.redirections.flatMap((item) => wordNamesState(item.target, folderOf(item.segment), scan, undefined)),
    // Every word of a segment counts, its input redirections and assignments included; a folder reader reads only its
    // own operands, not an assignment such as `XDG_CONFIG_HOME=~/.config` before it. A launcher the scan does not know
    // (`caffeinate -i`, `xcrun`, `uv run`) runs the reader after it.
    ...scanned.segments.flatMap((segment, index) => {
      const argv = commands[index] ?? []
      const launched =
        folderReader(argv) === undefined
          ? argv.findIndex((word, at) => at > 0 && mayReadFolders(word) && folderReader(argv.slice(at)) !== undefined)
          : 0
      const run = launched > 0 ? argv.slice(launched) : argv
      const reader = folderReader(run)
      const operands = new Set(run.slice(1))
      const destination = DESTINATION_LAST.has(commandName(run)) ? copyDestination(run) : undefined
      return [
        ...segment.flatMap((word) =>
          wordNamesState(word, folderOf(index), scan, word !== destination && operands.has(word) ? reader : undefined),
        ),
        ...containerSources(argv).flatMap((source) => wordNamesState(source, folderOf(index), scan, { skipsHidden: false })),
      ]
    }),
  ]
  const nested = [
    ...scanned.nested.map((item) => ({ snippet: item.snippet, folder: folderOf(item.segment) })),
    ...commands.flatMap((argv, index) => wrappedCommand(argv).map((snippet) => ({ snippet, folder: folderOf(index) }))),
    ...scanned.segments.flatMap((segment, index) =>
      hereStringScript(segment, commands[index] ?? []).map((snippet) => ({ snippet, folder: folderOf(index) })),
    ),
  ].flatMap((item) => stateReferencesIn(item.snippet, item.folder, scan, depth + 1))
  return [...named, ...nested]
}

// The host folders a container command gives a container, which reads them whole: a bind mount's source
// (`-v ~/.config:/cfg`, `--mount type=bind,src=~/.config`) and what `docker cp` copies in.
function containerSources(argv: readonly string[]): string[] {
  if (!["docker", "podman", "nerdctl"].includes(commandName(argv))) return []
  const args = argv.slice(1)
  if (args[0] === "cp") return args.slice(1).filter((arg) => !arg.startsWith("-") && !/^[\w.-]+:/.test(arg))
  return args.flatMap((arg, index) => {
    const value = ["-v", "--volume", "--mount"].includes(arg)
      ? args[index + 1]
      : /^(?:-v|--volume=|--mount=)(.+)$/.exec(arg)?.[1]
    if (value === undefined) return []
    return [/(?:^|,)(?:src|source)=([^,]+)/.exec(value)?.[1] ?? value.split(":")[0]!]
  })
}

function twoWordCd(argv: readonly string[]): boolean {
  if (!["cd", "chdir", "pushd"].includes(commandName(argv))) return false
  const args = argv.slice(1)
  const end = args.indexOf("--")
  return (end === -1 ? args.filter((arg) => !arg.startsWith("-")) : args.slice(end + 1)).length >= 2
}

// The script a shell reads from a here-string (`zsh <<<'text'`), which runs as commands.
function hereStringScript(segment: readonly string[], argv: readonly string[]): string[] {
  if (!SHELLS.has(commandName(argv)) || argv.slice(1).some((arg) => /^-[A-Za-z]*c$/.test(arg))) return []
  return segment.flatMap((word, index) => {
    if (word === "<<<") return segment[index + 1] === undefined ? [] : [segment[index + 1]!]
    return word.startsWith("<<<") ? [word.slice(3)] : []
  })
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])

// How a command reads a folder it is given (folderReader): `skipsHidden` when it skips hidden files and folders, and
// `homeCounts: false` when the home folder and those above it do not count.
type FolderReader = { readonly skipsHidden: boolean; readonly homeCounts?: false }

// Whether a word names a command that can read a folder whole (folderReader), checked before reading its arguments.
function mayReadFolders(word: string): boolean {
  const name = commandName([word])
  return name === "git" || RECURSIVE_READERS.has(name) || MOVERS.has(name) || INTERPRETER_NAME.test(name)
}

// How a command reads a folder it is given: whole, or (rg and ag) without its hidden files and folders unless told to
// read them. Undefined for a command that does not read a folder whole.
function folderReader(argv: readonly string[]): FolderReader | undefined {
  const name = commandName(argv)
  const args = argv.slice(1)
  if (name === "git") return args.includes("--no-index") ? { skipsHidden: false } : undefined
  if (MOVERS.has(name)) return { skipsHidden: false }
  // An interpreter's script or module (`python3 -m tarfile -c x.tar <folder>`) can read a folder it is given whole. The
  // home folder and those above it are given to scripts too often (`pip install -e ..` from `~/project`) to count.
  if (INTERPRETER_NAME.test(name)) return { skipsHidden: false, homeCounts: false }
  if (!RECURSIVE_READERS.has(name)) return undefined
  if (name !== "rg" && name !== "ag") return { skipsHidden: false }
  const hidden =
    (name === "rg" && process.env.RIPGREP_CONFIG_PATH !== undefined) ||
    args.some((arg) => /^(?:--hidden|--unrestricted|-\.|-[A-Za-z]*u[A-Za-z]*)$/.test(arg))
  return { skipsHidden: !hidden }
}

// Where a copy, move or link writes: the `-t` or `--target-directory` folder, also in a cluster such as `-rt`, or else
// its last operand.
function copyDestination(argv: readonly string[]): string | undefined {
  const args = argv.slice(1)
  const target = args.flatMap((arg, index) => {
    if (arg.startsWith("--target-directory=")) return [arg.slice("--target-directory=".length)]
    if (arg === "--target-directory" || /^-[A-Za-z]*t$/.test(arg) || arg.toLowerCase() === "-destination")
      return args[index + 1] === undefined ? [] : [args[index + 1]!]
    return []
  })
  if (target.length > 0) return target[0]
  const operands = args.filter((arg) => !arg.startsWith("-"))
  return operands.length > 1 ? operands.at(-1) : undefined
}

// An input redirection glued to its file (`<file`), an option's value (`--db=file`) and an assignment (`DB=file`) name
// the file after their prefix.
function wordNamesState(
  raw: string,
  folder: string,
  scan: StateScan,
  reader: FolderReader | undefined,
): string[] {
  const written = expandShellPath(raw.replace(/^\d*<+&?/, "").replace(/^-{0,2}[A-Za-z_][\w-]*=/, ""), folder, scan.home)
  if (!written) return []
  if (scan.untracked && !path.isAbsolute(written) && scan.names.has(stateFileName(written))) return [written]
  // The shells match a glob a segment at a time, so only the path it expands to has to fit; a glob no path can match,
  // such as a long quoted message with a `*` in it, names nothing.
  const glob = /[*?[]/.test(written)
  const simple = glob ? simplifyGlob(written) : undefined
  if (simple?.possible === false || (!glob && written.length > PATH_MAX)) return []
  const word = simple?.pattern ?? written
  const file = path.resolve(folder, FSUtil.windowsPath(word))
  if (scan.state.matches(file)) return [file]
  // The shell expands a glob to what exists; on macOS and Windows their folders match without case. A glob that spells
  // a state file's whole path counts even where `*` would skip the dot folders, since a shell's startup files can make
  // it match them; a folder reader's `*` counts a dot folder only where the command itself lets it.
  if (glob) {
    const pattern = foldPath(slashed(file))
    const matchesFile = globMatcher(pattern, true)
    const files = scan.state.existing.filter((found) => matchesFile(foldPath(slashed(found))))
    if (files.length > 0) return files
    const matchesFolder = globMatcher(pattern, scan.dots)
    const folders =
      reader === undefined
        ? []
        : scan.state.ancestors.filter(
            (found) => readerCounts(found, reader, scan.home) && matchesFolder(foldPath(slashed(found))),
          )
    if (reader !== undefined && scan.state.below(folders, reader.skipsHidden))
      return scan.state.existing.filter((found) => folders.some((matched) => containsPath(matched, found)))
  }
  if (reader === undefined || !readerCounts(file, reader, scan.home)) return []
  if (!scan.state.below([file, scan.state.real(file)], reader.skipsHidden)) return []
  const inside = scan.state.existing.filter((found) => containsPath(file, found))
  return inside.length > 0 ? inside : [file]
}

// Whether a folder given to a reader counts: for one with `homeCounts: false`, only a folder below the home folder.
function readerCounts(folder: string, reader: FolderReader, home: string): boolean {
  return reader.homeCounts !== false || (containsPath(home, folder) && foldPath(folder) !== foldPath(home))
}

// Whether a glob simplified by simplifyGlob matches a path. Parentheses and braces are plain: the readings already
// expand the groups the shell would, and the matcher would read them as its own extended globs and brace lists. zsh
// reads a list in parentheses at the end, such as `(D)` or `(.)`, as glob qualifiers, not as part of the name. `dots`
// lets `*` and `?` match a leading dot. A pattern the matcher still cannot read counts as a match, so the command asks.
// The pattern is read once for all the paths it is matched against.
function globMatcher(pattern: string, dots: boolean): (file: string) => boolean {
  const simple = pattern.replace(/\([^()|]*\)$/, "").replace(/[[(){}]/g, "\\$&")
  // The literal start must match as written, which rules out most words before the matcher runs.
  const literal = simple.slice(0, simple.search(/[*?\\]|$/))
  return (file) => {
    if (!file.startsWith(literal)) return false
    try {
      return Glob.match(simple, file, { dot: dots })
    } catch {
      return true
    }
  }
}

// A glob as the scan matches it, so that it matches more than the shell would but never less: each bracket
// expression, with POSIX classes (`[:alpha:]`), equivalence classes (`[=s=]`) and collating symbols (`[.s.]`) inside
// it, as `?`, which the matcher reads in every form the shells accept; an unclosed `[` as itself, as bash reads it;
// each run of `*` as one; and a segment with more than 8 wildcards as `*`, so the matcher's time stays small.
// `possible` is false when no path can match: a segment that needs more than 255 characters, or the whole more than
// PATH_MAX. Read in one pass from each end, so a long word costs its length.
function simplifyGlob(glob: string): { readonly pattern: string; readonly possible: boolean } {
  // A plain loop over characters: where the next `]` and `/` are, from the right.
  const nextClose = new Array<number>(glob.length + 1).fill(-1)
  const nextSlash = new Array<number>(glob.length + 1).fill(glob.length)
  for (let at = glob.length - 1; at >= 0; at--) {
    nextClose[at] = glob[at] === "]" ? at : nextClose[at + 1]!
    nextSlash[at] = glob[at] === "/" ? at : nextSlash[at + 1]!
  }
  const segments: string[][] = [[]]
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at]!
    const segment = segments.at(-1)!
    if (char === "/") segments.push([])
    else if (char === "*") {
      if (segment.at(-1) !== "*") segment.push("*")
    } else if (char !== "[") segment.push(char)
    else {
      const end = bracketEnd(glob, at, nextClose, nextSlash[at]!)
      segment.push(end === undefined ? "[" : "?")
      at = end ?? at
    }
  }
  const needed = segments.map((segment) => segment.filter((part) => part !== "*").length)
  const shaped = segments.map((segment) =>
    segment.filter((part) => part === "*" || part === "?").length > 8 ? ["*"] : segment,
  )
  return {
    pattern: shaped.map((segment) => segment.join("")).join("/"),
    possible: needed.every((length) => length <= 255) && needed.reduce((sum, length) => sum + length + 1, -1) <= PATH_MAX,
  }
}

// Where the bracket expression opened at `open` ends: its `]`, past a leading `!`, `^` or `]` and past the `]`s that end
// classes inside it, or undefined when it does not close before `limit`, the next `/`.
function bracketEnd(glob: string, open: number, nextClose: readonly number[], limit: number): number | undefined {
  const start = open + 1 + (glob[open + 1] === "!" || glob[open + 1] === "^" ? 1 : 0)
  // A plain loop from `]` to `]`: a class closes with its own character before the `]`, opened since the last `]`.
  for (let from = glob[start] === "]" ? start + 1 : start; ; ) {
    const close = nextClose[from] ?? -1
    if (close === -1 || close >= limit) return undefined
    const kind = glob[close - 1]
    const inner = (kind === ":" || kind === "=" || kind === ".") && glob.slice(from, close - 1).includes(`[${kind}`)
    if (!inner) return close
    from = close + 1
  }
}

// The state files' paths written anywhere in the command's text, heredoc bodies and quoted code included, in the
// spellings the shell and the usual interpreters read the same way: quotes dropped, brace lists, ranges and zsh groups
// expanded, `/./`, `//` and `dir/..` folded, `%2F` decoded, and `~`, `~user`, `$HOME` and `$PWD` read as folders. Also
// written relative to a folder the command runs in, and, in an interpreter's code, a state folder or one above it
// inside the home folder (see folderMention).
function mentionedState(command: string, scan: StateScan): string[] {
  const unquoted = command.replace(/\$(?=['"])/g, "").replace(/['"]/g, "")
  const texts = [slashed(unquoted), unquoted.replace(/\\(.)/g, "$1")]
  // Only the words with groups are read again with each group expanded, so a long text is read a few times at most.
  const grouped = texts.flatMap((text) =>
    text
      .split(/\s+/)
      .filter((word) => /[{(]/.test(word))
      .flatMap((word) => [...expandGroups(word, ANY_GROUP), word.replace(/[()]/g, "")]),
  )
  const flat = command.replace(/['"\\]/g, "")
  const interpreted = INTERPRETERS.test(flat)
  // Every reading of the command at once, for the patterns that only a spelling inside it can match.
  const all = foldPath([...texts, ...grouped].join("\n"))
  // Folders the command runs in below a state folder, such as a worktree in the data folder.
  const below = [...scan.folders].filter((folder) => scan.state.inside(folder) && !scan.state.isFolder(folder))
  const patterns = [
    ...scan.state.patterns,
    ...relativePatterns(scan, all),
    // From such a folder, interpreter code reaches the state when it names a state file and climbs out, or names the
    // state folder relative to it (`../../..`).
    ...(interpreted && below.length > 0 ? [...scan.state.namePatterns, ...relativeFolderPatterns(below, scan, all)] : []),
  ]
  const folderPatterns = [
    ...(interpreted ? scan.state.folderPatterns : []),
    // The folders above are named often enough in ordinary commands that only code the command itself carries counts.
    ...(interpreted && INLINE_CODE.test(flat) ? scan.state.ancestorPatterns : []),
  ]
  return [...texts, ...grouped].flatMap((text) => {
    const normalized = normalizeMention(text, scan.home, scan.cwd)
    // A path into such a folder, `$PWD` there included, names that folder, not the state folder above it.
    const outside = below.reduce((current, folder) => current.replaceAll(foldPath(slashed(folder)), "."), normalized)
    return [
      ...patterns.flatMap((item) => mentionFiles(item, normalized)),
      ...folderPatterns.flatMap((item) => mentionFiles(item, outside)),
    ]
  })
}

function mentionFiles(item: Mention, text: string): readonly string[] {
  const found = item.pattern.exec(text)?.[0]
  return found === undefined ? [] : (item.files ?? [found])
}

// From folders below a state folder, the state folder written relative to them (`../../..` from a worktree in the data
// folder), as folderMention reads a folder.
function relativeFolderPatterns(below: readonly string[], scan: StateScan, command: string): Mention[] {
  return below.flatMap((folder) =>
    scan.state.roots.flatMap((root): Mention[] => {
      const relative = slashed(path.relative(foldPath(folder), foldPath(root.folder)))
      // Only a spelling in the command can match.
      if (!containsPath(root.folder, folder) || !command.includes(relative)) return []
      return [
        {
          pattern: new RegExp(`(?<![\\w./-])${escapeRegExp(relative)}${folderAfter(root.toward)}`),
          files: scan.state.existing.filter((file) => containsPath(root.folder, file)),
        },
      ]
    }),
  )
}

// A pattern for a state file's path in text, with the files a match names when the text alone does not tell.
type Mention = { readonly pattern: RegExp; readonly files?: readonly string[] }

// The state files written relative to a folder the command runs in, from inside the home folder: `service-local.json`
// in the state folder, `abucode/service-local.json` in the folder above it. The home folder's own spellings are in the
// state's patterns. Far up from an ordinary folder, a relative path more likely names another file of the same name;
// from inside the engine's own folders, such as a worktree in the data folder, it names the engine's.
function relativePatterns(scan: StateScan, command: string): Mention[] {
  // Only a file whose name is in the command can be spelled in it, and each spelling is one pattern.
  const text = foldPath(command)
  const named = scan.state.existing.filter((file) => text.includes(stateFileName(file)))
  const spelled = [...scan.folders]
    .filter((folder) => named.length > 0 && !containsPath(folder, scan.home))
    .flatMap((folder) =>
      named.flatMap((file) => {
        const relative = slashed(path.relative(foldPath(folder), foldPath(file)))
        if (path.isAbsolute(relative) || relative.length > command.length) return []
        if (relative.startsWith("../../../") && !scan.state.inside(folder)) return []
        return [{ relative, file }]
      }),
    )
  return [...new Set(spelled.map((item) => item.relative))].map((relative) => ({
    pattern: new RegExp(`(?<![\\w-])(?:\\./)?${escapeRegExp(relative)}`),
    files: spelled.filter((item) => item.relative === relative).map((item) => item.file),
  }))
}

function normalizeMention(text: string, home: string, cwd: string): string {
  const homes = text
    .replace(/%2f/gi, "/")
    .replace(/%2e/gi, ".")
    .replace(/\$\{?HOME\}?(?=\/|$)/g, () => slashed(home))
    .replace(/\$\{?PWD\}?(?=\/|$)/g, () => slashed(cwd))
    .replace(/~([A-Za-z_][\w.-]*)?(?=\/|$)/g, (_, user: string | undefined) =>
      slashed(user === undefined ? home : path.join(path.dirname(home), user)),
    )
  // `.` and empty segments go, and `..` takes the segment before it, as a path resolves.
  const kept: string[] = []
  for (const [index, segment] of homes.split("/").entries()) {
    if (index > 0 && (segment === "" || segment === ".")) continue
    if (segment === ".." && kept.length > 1 && kept.at(-1) !== "..") {
      kept.pop()
      continue
    }
    kept.push(segment)
  }
  return foldPath(kept.join("/"))
}

// A brace list `{a,b}` or range `{a..c}` that is not a parameter expansion, and, for text, also a zsh group `(a|b)`.
const BRACE_LIST = /(?<!\$)\{([^{}\s]*,[^{}\s]*|\w\.\.\w)\}/
const BRACE_LISTS = new RegExp(BRACE_LIST.source, "g")
const ANY_GROUP = /(?<!\$)\{([^{}]*,[^{}]*|\w\.\.\w)\}|\(([^()]*\|[^()]*)\)/

// The readings of `text` with its first few groups expanded, at most 32 in all.
function expandGroups(text: string, group: RegExp, depth = 0, limit = 32): string[] {
  const found = depth < 5 ? group.exec(text) : null
  if (!found) return [text]
  const alternatives = groupAlternatives(found[1], found[2])
  return alternatives.reduce<string[]>(
    (readings, alternative) =>
      readings.length >= limit
        ? readings
        : [
            ...readings,
            ...expandGroups(
              text.slice(0, found.index) + alternative + text.slice(found.index + found[0].length),
              group,
              depth + 1,
              limit - readings.length,
            ),
          ],
    [],
  )
}

function groupAlternatives(braces: string | undefined, alternation: string | undefined): string[] {
  if (braces === undefined) return (alternation ?? "").split("|")
  const range = /^(\w)\.\.(\w)$/.exec(braces)
  if (!range) return braces.split(",")
  const [from, to] = [range[1]!.charCodeAt(0), range[2]!.charCodeAt(0)]
  const step = from <= to ? 1 : -1
  return Array.from({ length: Math.min(Math.abs(to - from) + 1, 32) }, (_, index) =>
    String.fromCharCode(from + index * step),
  )
}

// `$'...'` as the plain single-quoted text it stands for, its escapes decoded, which both bash and zsh do.
function decodeAnsiQuotes(command: string): string {
  return command.replace(
    /\$'((?:[^'\\]|\\[\s\S])*)'/g,
    (_, body: string) => `'${decodeEscapes(body).replaceAll("'", "'\\''")}'`,
  )
}

const ANSI_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

function decodeEscapes(body: string): string {
  return body.replace(
    /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|[\s\S])/g,
    (_, escape: string) => {
      if (/^[xuU][0-9a-fA-F]/.test(escape)) {
        const code = Number.parseInt(escape.slice(1), 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : ""
      }
      if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8) & 0xff)
      return ANSI_ESCAPES[escape] ?? escape
    },
  )
}

// One name for each file: a text match becomes the existing state file it names, and spellings that differ only in
// case are one.
function dedupeReferences(found: readonly string[], state: EngineState): string[] {
  const named = found.map(
    (item) => state.existing.find((file) => foldPath(slashed(file)).endsWith(foldPath(slashed(item)))) ?? item,
  )
  return [...new Map(named.map((item) => [foldPath(slashed(item)), item])).values()]
}

type EngineState = ReturnType<typeof engineState>

// The engine's state files for `dirs`, with every spelling of their folders worked out once per check. Real paths and
// matches are kept for the check, so a long command resolves each folder once.
function engineState(dirs: EngineStateDirs) {
  const reals = new Map<string, string>()
  const real = (absolute: string): string => {
    const known = reals.get(absolute)
    if (known !== undefined) return known
    const resolved = absolute.length > PATH_MAX ? absolute : resolveReal(absolute)
    reals.set(absolute, resolved)
    return resolved
  }
  // The real path of the deepest folder that resolves, with the rest of the path as written.
  const resolveReal = (absolute: string): string => {
    try {
      return fs.realpathSync.native(absolute)
    } catch {
      const parent = path.dirname(absolute)
      return parent === absolute ? absolute : path.join(real(parent), path.basename(absolute))
    }
  }
  const forms = (value: string) => {
    const absolute = path.resolve(value)
    return [...new Set([absolute, real(absolute)])]
  }
  const service = dirs.service.flatMap(forms)
  const data = dirs.data.flatMap(forms)
  const databases = dirs.databases.flatMap((file) => DATABASE_SIDE_FILES.flatMap((suffix) => forms(file + suffix)))
  const serviceFolders = new Set(service.map(foldPath))
  const dataFolders = new Set(data.map(foldPath))
  const databaseFiles = new Set(databases.map(foldPath))
  const folders = [...service, ...data, ...databases.map((file) => path.dirname(file))]
  const existing = [
    ...new Set([...listed(service, SERVICE_FILE), ...listed(data, DATABASE_FILE), ...databases.filter(isFile)]),
  ]
  // A hard link is the same file under another name.
  const identities = new Set(existing.flatMap(fileIdentity))
  const matched = new Map<string, boolean>()
  const roots = [
    ...service.map((folder) => ({ folder, toward: ["service"] })),
    ...data.map((folder) => ({ folder, toward: ["opencode"] })),
  ]
  // What code that names a folder also names when it is after the state: a state file's name below the folder, or the
  // name of a state folder below it (`abucode` below `~/.config`).
  const marksBelow = (folder: string) => [
    ...new Set([
      ...existing.filter((file) => containsPath(folder, file)).map(stateFileName),
      ...[...service, ...data]
        .filter((root) => containsPath(folder, root) && foldPath(root) !== foldPath(folder))
        .map((root) => foldPath(path.basename(root))),
    ]),
  ]
  const isStateFile = (absolute: string) =>
    [absolute, real(absolute)].some((candidate) => {
      const name = stateFileName(candidate)
      const folder = foldPath(path.dirname(candidate))
      return (
        (SERVICE_FILE.test(name) && serviceFolders.has(folder)) ||
        (DATABASE_FILE.test(name) && dataFolders.has(folder)) ||
        databaseFiles.has(foldPath(candidate))
      )
    }) || fileIdentity(absolute).some((identity) => identities.has(identity))
  const below = (roots: readonly string[], skipsHidden: boolean) =>
    folders.some((folder) =>
      roots.some(
        (root) =>
          containsPath(root, folder) &&
          !(skipsHidden && path.relative(foldPath(root), foldPath(folder)).split(/[\\/]/).some(isHidden)),
      ),
    )
  return {
    real,
    /** Whether an absolute path is a state file: as written, through links, or by being the same file. */
    matches: (absolute: string) => {
      const known = matched.get(absolute)
      if (known !== undefined) return known
      const result = isStateFile(absolute)
      matched.set(absolute, result)
      return result
    },
    /** Whether a root is a state file's folder or above one; `skipsHidden` when the reader skips hidden folders. */
    below,
    /** Whether a folder is one of the folders that hold the state files. */
    isFolder: (folder: string) =>
      [folder, real(folder)].some((form) => serviceFolders.has(foldPath(form)) || dataFolders.has(foldPath(form))),
    /** The state files that exist now. */
    existing,
    /** The state files' folders and every folder above them, which a glob can name. */
    ancestors: [...new Set(folders.flatMap(ancestorsOf))],
    /** How a state file's path shows inside text that `normalizeMention` read. */
    patterns: [
      ...spellings(service, dirs.home).map((folder) => new RegExp(`${folder}/+service(?:-[\\w.-]+)?\\.json`)),
      ...spellings(data, dirs.home).map((folder) => new RegExp(`${folder}/+opencode(?:-[\\w.-]+)?\\.db`)),
      ...databases.map((file) => new RegExp(escapeRegExp(foldPath(slashed(file))))),
    ].map((pattern): Mention => ({ pattern })),
    /** How a state folder shows inside an interpreter's code, which can read, copy or move it whole. */
    folderPatterns: roots.flatMap((root) =>
      folderMention(root.folder, root.toward, marksBelow(root.folder), true, dirs.home, existing),
    ),
    /** How a folder above a state folder, inside the home folder, shows inside an interpreter's code. */
    ancestorPatterns: foldersAbove([...service, ...data], dirs.home).flatMap((above) =>
      folderMention(above.folder, above.toward, marksBelow(above.folder), false, dirs.home, existing),
    ),
    /** The state folders, each with the start of its state files' names. */
    roots,
    /** Whether a folder is a state folder or inside one, such as a worktree in the data folder. */
    inside: (folder: string) => [...service, ...data].some((root) => containsPath(root, folder)),
    /** A state file's name in code that also climbs out of a path (CLIMB). */
    namePatterns: [...new Set(existing.map(stateFileName))].map(
      (name): Mention => ({
        pattern: new RegExp(`^(?=[\\s\\S]*?(?<![\\w.-])${escapeRegExp(name)}(?![\\w.-]))(?=[\\s\\S]*?(?:${CLIMB}))`),
        files: existing.filter((file) => stateFileName(file) === name),
      }),
    ),
  }
}

// What code may climb out of a path with: `dirname`, `os.pardir`, `.parent`, `parent_path`, a split, `.dir` and `..`.
const CLIMB = String.raw`dirname|pardir|\bparents?\b|parent_path|rsplit|\bsplit\b|\.dir\b|(?<![\w.])\.\.(?![\w.])`

// The folders above `folders` inside the home folder, each with the names of its subfolders that lead to them.
function foldersAbove(folders: readonly string[], home: string): { folder: string; toward: string[] }[] {
  const steps = folders.flatMap((folder) =>
    ancestorsOf(path.dirname(folder))
      .filter((above) => foldPath(above) !== foldPath(home) && containsPath(home, above))
      .map((above) => ({ above, next: path.relative(above, folder).split(path.sep)[0] ?? "" })),
  )
  return [...new Set(steps.map((step) => step.above))].map((above) => ({
    folder: above,
    toward: [...new Set(steps.filter((step) => step.above === above).map((step) => step.next))],
  }))
}

// A folder named in code. Below it the code counts unless it names something else whole: a path into another folder
// (`worktree/…`) or a complete name that does not lead to a state file (`opencode.json` in the config folder). So the
// folder counts on its own (`~/.config/abucode`, `~/.local/state/abucode/`), with a glob after its name or below it
// (`abucode*`, `s*`), with a name the code fills in or a call on the string after it (`{name}`, `$f`, `#{f}`, `%s`,
// `.concat(`), and with the start of a name in `toward`, the names that lead to a state file (`s` + `ervice-local.json`).
// Code can also step back up from a path it names whole, so code that names the folder at all counts when it also
// names one of `marks` (a state file below it, or a state folder below it such as `abucode`), or, for a state folder
// itself (`up`), climbs out of a path (CLIMB).
function folderMention(
  folder: string,
  toward: readonly string[],
  marks: readonly string[],
  up: boolean,
  home: string,
  existing: readonly string[],
): Mention[] {
  const after = folderAfter(toward)
  // A mark on its own, not a segment of a path such as `~/.local/share/abucode/log`.
  const named =
    marks.length === 0 ? "(?!)" : `(?<![\\w./-])(?:${marks.map(escapeRegExp).join("|")})(?![\\w.-])`
  const files = existing.filter((found) => containsPath(folder, found))
  return spellings([folder], home).flatMap((spelling): Mention[] => [
    { pattern: new RegExp(`${spelling}${after}`), files },
    {
      pattern: new RegExp(`^(?=[\\s\\S]*?${spelling}(?![\\w.-]))(?=[\\s\\S]*?(?:${named}${up ? `|${CLIMB}` : ""}))`),
      files,
    },
  ])
}

// What may follow a folder's spelling for code to count as naming it (see folderMention).
function folderAfter(toward: readonly string[]): string {
  const end = String.raw`(?=$|[\s\`),;:\]}+<>|&])`
  const open = String.raw`[\w.-]*(?=[^\w.\-/\s\`),;:\]}+<>|&])`
  return `(?:${end}|[*?[{]|/(?:${end}|${open}|(?:${toward.map(startsOf).join("|")})${end}))`
}

// `name` and every start of it, as folded text: `s`, `se`, … `service`, and `service` with more after it.
function startsOf(name: string): string {
  return [...foldPath(name)].reduceRight((rest, char) => `${escapeRegExp(char)}(?:${rest})?`, String.raw`[\w.-]*`)
}

function ancestorsOf(folder: string): string[] {
  const parent = path.dirname(folder)
  return parent === folder ? [folder] : [folder, ...ancestorsOf(parent)]
}

// A folder written from the root, or from the home folder at the start of a path, as a regular expression of folded
// text. A home-relative spelling after a path segment, such as a test fixture's `/tmp/home/.config/...`, is another
// folder; after `'/`, `%s/` or `}./` it is the home folder joined in code.
function spellings(folders: readonly string[], home: string): string[] {
  const fromHome = folders.flatMap((folder) =>
    containsPath(home, folder) ? [path.relative(foldPath(home), foldPath(folder))] : [],
  )
  // A home-relative spelling starts a path: `.local` in `.env.local` or `app.config` is a name, not the folder.
  return [
    ...new Set([
      ...folders.map((folder) => escapeRegExp(foldPath(slashed(folder)))),
      ...fromHome.filter(Boolean).map((folder) => `(?<![\\w.-])(?<!/[\\w.-]+/)${escapeRegExp(slashed(folder))}`),
    ]),
  ]
}

function listed(folders: readonly string[], pattern: RegExp): string[] {
  return folders.flatMap((folder) =>
    listFolder(folder)
      .filter((name) => pattern.test(stateFileName(name)))
      .map((name) => path.join(folder, name)),
  )
}

// A path as core's FileAccess.resolvePath reads what a file tool was given: `~` and `~/` start at the home folder.
function resolveToolPath(target: string, cwd: string, home: string): string {
  const normalized = FSUtil.windowsPath(target)
  const expanded =
    normalized === "~" ? home : /^~[\\/]/.test(normalized) ? path.join(home, normalized.slice(2)) : normalized
  return path.resolve(cwd, expanded)
}

// A file's name as the file system matches it: without case on macOS and Windows, and on Windows without an NTFS
// stream suffix or trailing dots and spaces.
function stateFileName(file: string): string {
  return foldPath(path.basename(file))
    .replace(/:.*$/, "")
    .replace(/[. ]+$/, "")
}

// The device and inode of an existing file; some file systems give no inode.
function fileIdentity(file: string): string[] {
  const stat = statOf(file)
  return stat?.isFile() && stat.ino !== 0 ? [`${stat.dev}:${stat.ino}`] : []
}

function isFile(file: string): boolean {
  return statOf(file)?.isFile() ?? false
}

// A path that is missing, or runs through a file, has no status.
function statOf(file: string): fs.Stats | undefined {
  if (file.length > PATH_MAX) return undefined
  try {
    return fs.statSync(file, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
}

function isHidden(segment: string): boolean {
  return segment.startsWith(".") && segment !== "." && segment !== ".."
}

function slashed(value: string): string {
  return value.replaceAll("\\", "/")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function listFolder(folder: string): string[] {
  try {
    return fs.readdirSync(folder)
  } catch {
    return []
  }
}

export function knownSecretValues(envLocalPath?: string): string[] {
  const resolved = loadResolvedSecretEnv(envLocalPath)
  // A key changed in a vault file while the engine runs is not in its environment yet.
  const files = readVaultFiles(envLocalPath)
  const values = new Set<string>()
  for (const meta of PROVIDERS_META) {
    const v1 = resolved[meta.envKey]?.trim() ?? ""
    const v2 = process.env[meta.envKey]?.trim() ?? ""
    const v3 = files[meta.envKey]?.trim() ?? ""
    if (v1.length >= 8) values.add(v1)
    if (v2.length >= 8) values.add(v2)
    if (v3.length >= 8) values.add(v3)
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

/**
 * `value` with `mask` applied to every string in it, through arrays and plain objects; other values stay as they are.
 * An array or object with nothing to mask is returned as it was, so a caller can tell whether anything changed.
 */
export function maskStrings<T>(value: T, mask: (text: string) => string): T {
  const masked = (item: unknown): unknown => {
    if (typeof item === "string") return mask(item)
    if (Array.isArray(item)) {
      const items = item.map(masked)
      return items.every((entry, index) => entry === item[index]) ? item : items
    }
    if (item === null || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) return item
    const entries = Object.entries(item).map(([key, entry]) => [key, entry, masked(entry)] as const)
    return entries.every(([, entry, next]) => entry === next)
      ? item
      : Object.fromEntries(entries.map(([key, , next]) => [key, next]))
  }
  // Masking a string keeps it a string, so the shape is unchanged.
  return masked(value) as T
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

// Whether ps is asked to print environments: an `e` or `E` among its option letters, as in macOS's `-e` and `-E` or
// BSD's `e` as the first word, but not in an option's value such as `-o %MEM`, `-p $SERVER_PID` or `-u $USER`.
function psPrintsEnvironment(args: readonly string[]): boolean {
  const VALUE_LETTERS = /[oOptUuGgsqkC]/
  return args.some((arg, index) => {
    if (index > 0 && /^-[A-Za-z]*[oOptUuGgsqkC]$/.test(args[index - 1]!)) return false
    const bsd = index === 0 && /^[A-Za-z]+$/.test(arg)
    if (!bsd && !/^-[A-Za-z]/.test(arg)) return false
    const letters = bsd ? arg : arg.slice(1)
    // In a dash cluster, the letters after one that takes a value are that value (`-o%MEM`).
    const valueAt = bsd ? -1 : letters.search(VALUE_LETTERS)
    return /e/i.test(valueAt === -1 ? letters : letters.slice(0, valueAt + 1))
  })
}

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

  // Process env / infra secret dumps -> ask_always. macOS's `ps -E` prints the environment too, and Linux keeps it in
  // `/proc/<pid>/environ`; an engine started with OPENCODE_PASSWORD still holds its password there.
  if (cmd === "ps" && psPrintsEnvironment(rest)) {
    return { kind: "ask_always", reason: "ps with environment flag prints process secrets" }
  }
  if (rest.some((t) => /\/proc\/[^/\s]+\/environ\b/.test(t))) {
    return { kind: "ask_always", reason: `${cmd} reads a process's environment` }
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
// The bodies of the heredocs a shell reads as its script (`bash <<'EOF'`, `bash -euo pipefail <<EOF`, `sh -s -- a <<EOF`,
// `source /dev/stdin <<EOF`), each with the folder the shell runs in after the commands before it. A heredoc inside
// another one's body is that one's data, and one given to a command that passes it on, such as `ssh host bash`, does
// not run here.
function shellHeredocScripts(command: string, cwd: string, home: string): { text: string; folder: string }[] {
  const lines = command.split("\n")
  const outside: string[] = []
  const found: { text: string; folder: string }[] = []
  // A plain loop: each heredoc's body is skipped as a whole.
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const marker = /<<(-?)\s*\\?(['"]?)([A-Za-z_][\w.-]*)\2/.exec(line.replaceAll("<<<", "   "))
    if (!marker) {
      outside.push(line)
      continue
    }
    const end = lines.findIndex(
      (next, at) => at > index && (marker[1] === "-" ? next.replace(/^\t+/, "") : next).replace(/\r$/, "") === marker[3],
    )
    const folder = heredocShellFolder([...outside, line.slice(0, marker.index)].join("\n"), cwd, home)
    if (folder !== undefined) found.push({ text: lines.slice(index + 1, end === -1 ? undefined : end).join("\n"), folder })
    outside.push(line)
    index = end === -1 ? lines.length : end
  }
  return found
}

// The folder a shell runs in when the last command of `before` is a shell that reads its script from its input.
function heredocShellFolder(before: string, cwd: string, home: string): string | undefined {
  const commands = scanShellCommandStructure(preparePosix(before)).segments.map(
    (segment) => stripLeadingEnvAndWrappers(dropWrapperOptionValues(segment)).argv,
  )
  const last = commands.at(-1)
  if (last === undefined || !readsScriptFromInput(last)) return undefined
  return commands.slice(0, -1).reduce((folder, argv) => {
    const target = changedDirectory(argv)
    return target === undefined ? folder : resolveShellPath(target, folder, home)
  }, cwd)
}

// Whether a command reads its script from its input: a shell with no `-c` and no script file, or with `-s`, `-` or
// `/dev/stdin`, and `source /dev/stdin`.
function readsScriptFromInput(argv: readonly string[]): boolean {
  const name = commandName(argv)
  const args = argv.slice(1)
  if (name === "source" || name === ".") return args[0] === "/dev/stdin" || args[0] === "-"
  if (!SHELLS.has(name)) return false
  // Options come first: `-o name` and `+o name` take a value, and `--` ends them.
  const at = args.findIndex(
    (arg, index) => arg === "--" || (!/^[-+]/.test(arg) && !/^[-+][A-Za-z]*o$/.test(args[index - 1] ?? "")),
  )
  const options = at === -1 ? args : args.slice(0, at)
  if (options.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg))) return false
  const operands = at === -1 ? [] : args.slice(args[at] === "--" ? at + 1 : at)
  return (
    operands.length === 0 ||
    options.some((arg) => /^-[A-Za-z]*s[A-Za-z]*$/.test(arg)) ||
    operands[0] === "-" ||
    operands[0] === "/dev/stdin"
  )
}

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
  // zsh's `emulate [-LR] mode [options] -c text` runs `text` in that mode.
  if (name === "emulate") {
    // The text may follow `-c` as the next word, after `--`, or glued to it (`-c'text'`).
    const glued = rest.find((arg) => arg.startsWith("-c") && arg.length > 2)
    const index = rest.indexOf("-c")
    const text = index === -1 ? glued?.slice(2) : rest[index + 1] === "--" ? rest[index + 2] : rest[index + 1]
    return text === undefined ? [] : [text]
  }
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
  // Dotted ::ffff:127.0.0.1 or 64:ff9b::127.0.0.1, the IPv4-translated ::ffff:0:127.0.0.1 and IPv4-compatible
  // ::127.0.0.1 forms, and the local-use NAT64 64:ff9b:1::127.0.0.1
  const dotted =
    /^(?:::ffff:|0:0:0:0:0:ffff:|64:ff9b::|::ffff:0:|::|64:ff9b:1:(?:[0-9a-f]{1,4}:)*:?)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(
      lower,
    )
  if (dotted?.[1]) return dotted[1]

  // 6to4 2002:WWXX:YYZZ::/48 carries the IPv4 address in its second and third groups
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(lower)
  // Hex ::ffff:7f00:0001 or 64:ff9b::7f00:1, ::ffff:0:7f00:1 or ::7f00:1, and the local-use NAT64 64:ff9b:1::7f00:1
  const hexMapped =
    sixToFour ?? /^(?:::ffff:|0:0:0:0:0:ffff:|64:ff9b::|::ffff:0:|::|64:ff9b:1:(?:[0-9a-f]{1,4}:)*:?)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
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

// Whether a request to `target`, whose host is or resolves to `addresses`, reaches one of `servers`: the same port on
// this machine, since a server bound to the wildcard address answers on every local address, or the host name of a
// server elsewhere, such as the remote-access URL, by any scheme and port.
function reachesOwnServer(target: URL, addresses: readonly string[], servers: readonly string[]): boolean {
  return servers.some((server) => {
    const own = URL.parse(server)
    if (!own) return false
    if (!isThisMachine(own.hostname)) return own.hostname.replace(/\.$/, "") === target.hostname.replace(/\.$/, "")
    return own.origin === target.origin || (portOf(own) === portOf(target) && addresses.some(isThisMachine))
  })
}

/** Whether a URL, as written, names one of `servers` (see FetchGuardOptions.ownServers). */
export function isOwnServerUrl(rawUrl: string, servers: readonly string[]): boolean {
  const parsed = URL.parse(rawUrl.trim())
  return parsed !== null && reachesOwnServer(parsed, [parsed.hostname], servers)
}

function portOf(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80")
}

// Loopback, the wildcard address and the addresses of this machine's network interfaces, each of which reaches a server
// listening here.
function isThisMachine(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || isLoopbackHost(host)) return true
  const address = extractEmbeddedIpv4FromIpv6(host) ?? host
  if (address === "0.0.0.0" || address === "::") return true
  return Object.values(os.networkInterfaces()).some((entries) =>
    (entries ?? []).some((entry) => entry.address.toLowerCase() === address),
  )
}

function isProtectedSelfApiPath(parsed: URL): boolean {
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!isLoopbackHost(host) && !host.endsWith(".ts.net") && classifyIpAddress(host) !== "local") {
    return false
  }
  const pathname = parsed.pathname.toLowerCase()
  if (pathname === "/api/health" || pathname === "/health") return false
  // Protect MultiCode control plane endpoints on loopback; this engine's own server is refused whole, by its address.
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

export interface FetchGuardOptions {
  readonly method?: string
  readonly allowLoopbackGet?: boolean
  readonly allowLocalGet?: boolean
  /**
   * The URLs of this engine's own servers. A request to one of them, by any method and to any path, is refused: with
   * the server password it could run commands and answer permission prompts as the engine's owner.
   */
  readonly ownServers?: readonly string[]
}

export function validateFetchUrlGuard(rawUrl: string, opts?: FetchGuardOptions): string | undefined {
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

  if (reachesOwnServer(parsed, [host], opts?.ownServers ?? [])) return ownServerReason(parsed)

  if (isProtectedSelfApiPath(parsed)) {
    return `Blocked request to protected local agent/control API '${parsed.pathname}' (Self-API shield).`
  }

  if (host === "0.0.0.0" || host === "::" || host.endsWith(".internal")) {
    return `Blocked wildcard/internal host '${host}' (SSRF guard).`
  }

  // This machine's own addresses reach its loopback services too, a public one included.
  if (isLoopbackHost(host) || (net.isIP(host) !== 0 && isThisMachine(host))) {
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
  opts?: FetchGuardOptions & {
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

  if (
    reachesOwnServer(
      parsed,
      records.map((record) => record.address),
      opts?.ownServers ?? [],
    )
  )
    return ownServerReason(parsed)

  for (const rec of records) {
    const addr = rec.address
    const kind = isThisMachine(addr) ? "local" : classifyIpAddress(addr)
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
 * Where a play-test browser may connect for `host` and `port`: the addresses, in the resolver's order, which the
 * caller connects to without resolving the name again, or why the connection is refused. Loopback addresses are
 * allowed, except the engine's own servers; with `external`, so are other machines' public addresses. This machine's
 * other addresses, the LAN, reserved and cloud-metadata addresses never are, as for the page's own requests, and a name
 * is refused unless every address it resolves to is allowed.
 */
export async function playtestConnectionAddresses(
  host: string,
  port: number,
  opts: { readonly ownServers: readonly string[]; readonly external: boolean },
): Promise<{ readonly addresses: readonly string[] } | { readonly refused: string }> {
  const bare = host.replace(/^\[|\]$/g, "")
  const own = { refused: "this ABuCode engine's own server" }
  // Only a host name or an address, which is all a browser sends: anything else could move the port into the path.
  if (!/^[\w.:-]+$/.test(bare)) return { refused: "not a host name" }
  // The URL parser writes each address one way (`[::1]` for `0:0:0:0:0:0:0:1`), as the checks below expect.
  const target = URL.parse(`http://${net.isIPv6(bare) ? `[${bare}]` : bare}:${port}/`)
  if (target === null || Number(target.port || 80) !== port) return { refused: "not a host name" }
  const name = target.hostname.replace(/^\[|\]$/g, "")
  if (reachesOwnServer(target, [name], opts.ownServers)) return own
  const addresses =
    net.isIP(name) !== 0
      ? [name]
      : await dns.promises.lookup(name, { all: true, verbatim: true }).then(
          (records) => records.map((record) => record.address),
          () => [],
        )
  if (addresses.length === 0) return { refused: "a name that does not resolve" }
  if (reachesOwnServer(target, addresses, opts.ownServers)) return own
  if (addresses.every((address) => isLoopbackHost(address))) return { addresses }
  if (!opts.external) return { refused: "not a loopback server (allow_external_assets lets the page load public ones)" }
  const allowed = addresses.every(
    (address) =>
      isLoopbackHost(address) || (classifyIpAddress(address) === "public" && !isThisMachine(address)),
  )
  return allowed ? { addresses } : { refused: "a LAN, reserved or cloud-metadata address, or this machine's own" }
}

// The address alone decides, not the path: every route of the engine's API is open to its password.
function ownServerReason(target: URL): string {
  return `Blocked request to this ABuCode engine's own server (${target.host}): with the engine's password a request there could run commands and answer permission prompts (Self-API shield).`
}

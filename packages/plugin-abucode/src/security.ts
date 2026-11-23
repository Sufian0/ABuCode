import path from "node:path"
import type { PolicyTier } from "@opencode/schema/abucode"
import { loadResolvedSecretEnv, PROVIDERS_META } from "./providers.js"

const SECRET_ENV_NAME_RE =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|(?:^|_)PAT(?:_|$)|_(?:KEY|PWD|DSN)$|^PG(?:PASSWORD|PASSFILE)$/i

const NOT_CREDENTIALS = new Set(["TOKENIZERS_PARALLELISM"])
const KEY_FILE_NAMES = new Set([".env", ".envrc"])
const KEY_FILE_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"]

const HIDDEN_CHARACTERS_RE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u2D7F\u3164\uFE00-\uFE0F\uFFA0\uFFFC\u{E0100}-\u{E01EF}]/gu
const MANY_COMBINING_MARKS_RE = /\p{M}{4,}/gu

export function normalizePolicyTier(raw: string | undefined): PolicyTier {
  const clean = (raw ?? "").trim().toLowerCase()
  if (clean === "request_review" || clean === "review") return "request_review"
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

export function secretFileAccessReason(targetPath: string): string | undefined {
  const base = path.basename(targetPath)
  const lower = base.toLowerCase()
  if (isEnvStyleSecretFile(base)) {
    return `\`${base}\` holds API keys or secrets, so ABuCode's file tools cannot read, search, or modify it directly.`
  }
  if (lower === ".provider_settings.json" || lower === "opencode.json") {
    const norm = targetPath.replaceAll("\\", "/").toLowerCase()
    if (lower === ".provider_settings.json" || norm.includes("/.config/opencode/") || norm.includes("/.config/abucode/")) {
      return `\`${base}\` configures provider credentials/routing, so ABuCode's agent tools cannot read or modify it.`
    }
  }
  return undefined
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

export function classifyCatastrophicCommand(command: string): string | undefined {
  const norm = command.trim()
  if (!norm) return undefined

  // Fork bomb patterns
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(norm)) {
    return "Blocked: fork bomb pattern detected."
  }
  // Disk wipe / raw block device writes / OS formatters
  if (/\b(?:mkfs(?:\.\w+)?|diskutil\s+eraseDisk|format\s+[A-Za-z]:|cipher\s+\/w:)\b/i.test(norm)) {
    return "Blocked: disk formatting / raw erase command is never permitted."
  }
  if (/\bdd\b[^\n;|&]*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|disk\d+|rdisk\d+)\b/i.test(norm)) {
    return "Blocked: writing directly to a raw disk device is never permitted."
  }
  // Machine shutdown / reboot
  if (/(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|reboot|poweroff|halt|init\s+[06]|Stop-Computer|Restart-Computer)\b/i.test(norm)) {
    return "Blocked: shutting down or rebooting the host machine is never permitted."
  }
  // Recursive root / home wipe
  if (/\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|--recursive)\s+(?:\/(?:\s|$|\*)|~(?:\s|$|\/\*)|\$HOME(?:\s|$|\/\*))/i.test(norm)) {
    return "Blocked: deleting root (/) or home (~) recursively is never permitted."
  }
  return undefined
}

export function commandStagesSecretEnvFile(command: string): string | undefined {
  const norm = command.trim()
  if (!/\bgit\s+(?:add|stage|commit)\b/i.test(norm)) return undefined
  if (/(?:^|\s)(?:\.env|\.envrc|\.env\.(?!example|sample|template|dist)[\w.-]+)(?:\s|$|["'])/i.test(norm)) {
    return "Staging or committing `.env` credential files is blocked by ABuCode."
  }
  return undefined
}

const SENSITIVE_COMMAND_RE =
  /\b(?:rm|del|Remove-Item|rmdir|sudo|su|kill|pkill|taskkill|scp|ssh|nc|ncat|curl\s+[^\n]*?(?:-d|--data|-X\s*(?:POST|PUT|DELETE))|git\s+(?:push|reset\s+--hard|clean|branch\s+-[Df]|checkout\s+--))\b|(?:^|[\s"'=/\\])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|id_rsa|id_ed25519|[\w.-]+\.(?:pem|key|tfstate|tfvars))\b/i

export function evaluateShellPolicyDecision(
  tier: PolicyTier,
  command: string,
  baseEffect: "allow" | "ask" | "deny",
): { readonly effect: "allow" | "ask" | "deny"; readonly message?: string } {
  const catastrophic = classifyCatastrophicCommand(command)
  if (catastrophic) return { effect: "deny", message: catastrophic }

  const envStage = commandStagesSecretEnvFile(command)
  if (envStage) return { effect: "deny", message: envStage }

  if (baseEffect === "deny") return { effect: "deny" }

  if (tier === "request_review") {
    return { effect: "ask", message: "Request Review policy: asks before every shell command." }
  }
  if (tier === "turbo") {
    return { effect: "allow" }
  }
  if (tier === "auto") {
    if (SENSITIVE_COMMAND_RE.test(command)) {
      return { effect: "ask", message: "Auto policy: asks before deletes, git push, sudo, or credential paths." }
    }
    return { effect: "allow" }
  }
  // "default" tier: keep OpenCode's native ask/allow, plus enforce ask on sensitive patterns
  if (SENSITIVE_COMMAND_RE.test(command)) {
    return { effect: "ask", message: "Default policy: sensitive command requires confirmation." }
  }
  return { effect: baseEffect }
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (octets.some((n) => n < 0 || n > 255)) return true
  const a = octets[0]!
  const b = octets[1]!
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT / Tailscale 100.x
  if (a >= 224) return true
  return false
}

export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.trim().replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("127.")
}

export function validateFetchUrlGuard(
  rawUrl: string,
  opts?: { readonly allowLoopbackGet?: boolean },
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

  if (isLoopbackHost(host)) {
    return opts?.allowLoopbackGet ? undefined : "Loopback addresses are blocked for external fetches."
  }
  if (host === "0.0.0.0" || host === "::" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".ts.net")) {
    return `Blocked private/tailnet host '${host}' (SSRF guard).`
  }
  if (isPrivateOrReservedIpv4(host)) {
    return `Blocked private/reserved IP '${host}' (SSRF guard).`
  }
  if (host.includes(":") && (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd"))) {
    return `Blocked private/link-local IPv6 '${host}' (SSRF guard).`
  }
  return undefined
}

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ConnectionTestResult, ProviderKeyInfo } from "@opencode/schema/abucode"
import { ABUCODE_ENV_LOCAL } from "./content-paths.js"

export interface ProviderMeta {
  readonly id: string
  readonly name: string
  readonly envKey: string
  readonly baseUrl: string
  readonly defaultModel: string
}

export const PROVIDERS_META: readonly ProviderMeta[] = [
  {
    id: "venice",
    name: "Venice",
    envKey: "VENICE_API_KEY",
    baseUrl: "https://api.venice.ai/api/v1/chat/completions",
    defaultModel: "gemini-4-argon",
  },
  {
    id: "nano-gpt",
    name: "NanoGPT",
    envKey: "NANO_GPT_API_KEY",
    baseUrl: "https://api.nano-gpt.com/api/v1/chat/completions",
    defaultModel: "google/gemini-4-argon",
  },
  {
    id: "poe",
    name: "Poe",
    envKey: "POE_API_KEY",
    baseUrl: "https://api.poe.com/v1/chat/completions",
    defaultModel: "google/gemini-3.8-flash",
  },
  {
    id: "runpod",
    name: "RunPod",
    envKey: "RUNPOD_API_KEY",
    baseUrl: "https://api.runpod.ai/v2",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
  },
]

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return {}
    const out: Record<string, string> = {}
    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const stripped = rawLine.trim()
      if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue
      const eq = stripped.indexOf("=")
      const key = stripped.slice(0, eq).trim()
      const val = stripped
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
      if (key && val) out[key] = val
    }
    return out
  } catch {
    return {}
  }
}

function readFallbackOpenCodeConfigKeys(): Record<string, string> {
  const candidates = [
    path.join(os.homedir(), ".config", "abucode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), "AppData", "Roaming", "opencode", "opencode.json"),
    path.join(os.homedir(), "AppData", "Local", "opencode", "opencode.json"),
  ]
  const found: Record<string, string> = {}
  for (const cfgPath of candidates) {
    try {
      if (!fs.existsSync(cfgPath)) continue
      const data = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as {
        providers?: Record<string, { settings?: { apiKey?: string } }>
      }
      const provs = data.providers ?? {}
      const veniceKey = provs.venice?.settings?.apiKey?.trim() ?? ""
      const nanoKey = provs["nano-gpt"]?.settings?.apiKey?.trim() ?? ""
      const poeKey = provs.poe?.settings?.apiKey?.trim() ?? ""
      if (veniceKey && !found.VENICE_API_KEY) found.VENICE_API_KEY = veniceKey
      if (nanoKey && !found.NANO_GPT_API_KEY) found.NANO_GPT_API_KEY = nanoKey
      if (poeKey && !found.POE_API_KEY) found.POE_API_KEY = poeKey
    } catch {
      // Ignore unreadable fallback configs
    }
  }
  return found
}

export function loadResolvedSecretEnv(envLocalPath = ABUCODE_ENV_LOCAL): Record<string, string> {
  const fallbackEnvCandidates = [
    envLocalPath,
    "D:/Libraries/Documents/1ACode/MultiCode/.env.local",
    path.join(os.homedir(), "Documents", "Projects", "MultiCode", ".env.local"),
  ]
  const combined: Record<string, string> = { ...readFallbackOpenCodeConfigKeys() }
  for (const candidate of fallbackEnvCandidates.reverse()) {
    Object.assign(combined, parseEnvFile(candidate))
  }
  for (const meta of PROVIDERS_META) {
    const live = process.env[meta.envKey]?.trim()
    if (live) combined[meta.envKey] = live
    else if (combined[meta.envKey]) process.env[meta.envKey] = combined[meta.envKey]
  }
  return combined
}

export function maskSecretKey(rawKey: string): string {
  const trimmed = rawKey.trim()
  if (!trimmed) return ""
  if (trimmed.length <= 8) return "••••••••"
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`
}

export function getProviderKeysStatus(envLocalPath = ABUCODE_ENV_LOCAL): ProviderKeyInfo[] {
  const secrets = loadResolvedSecretEnv(envLocalPath)
  return PROVIDERS_META.map((meta) => {
    const raw = secrets[meta.envKey]?.trim() ?? ""
    return {
      id: meta.id,
      name: meta.name,
      envKey: meta.envKey,
      hasKey: raw.length > 0,
      maskedKey: maskSecretKey(raw),
    }
  })
}

export function saveProviderKeysToEnvLocal(
  incoming: Readonly<Record<string, string>>,
  envLocalPath = ABUCODE_ENV_LOCAL,
): ProviderKeyInfo[] {
  const existingLines = fs.existsSync(envLocalPath)
    ? fs.readFileSync(envLocalPath, "utf8").split(/\r?\n/)
    : []
  const updates = new Map<string, string>()

  for (const meta of PROVIDERS_META) {
    const candidate = (incoming[meta.id] ?? incoming[meta.envKey] ?? "").trim()
    if (!candidate || candidate.startsWith("•") || candidate.startsWith("*")) continue
    updates.set(meta.envKey, candidate)
    process.env[meta.envKey] = candidate
  }

  if (updates.size > 0) {
    const seen = new Set<string>()
    const nextLines = existingLines.map((line) => {
      const stripped = line.trim()
      for (const [envKey, val] of updates.entries()) {
        if (stripped.startsWith(`${envKey}=`)) {
          seen.add(envKey)
          return `${envKey}=${val}`
        }
      }
      return line
    })
    for (const [envKey, val] of updates.entries()) {
      if (!seen.has(envKey)) nextLines.push(`${envKey}=${val}`)
    }
    const cleanBody = `${nextLines.filter((line, idx, arr) => !(idx === arr.length - 1 && line === "")).join("\n")}\n`
    fs.mkdirSync(path.dirname(envLocalPath), { recursive: true })
    fs.writeFileSync(envLocalPath, cleanBody, "utf8")
  }

  return getProviderKeysStatus(envLocalPath)
}

const CUSTOM_POE_BOTS = new Set(["CArgon-4", "CArgon-4T", "CFable-51", "CFable-51T"])

export async function testProviderConnection(input: {
  readonly provider: string
  readonly model?: string
  readonly effort?: string
  readonly envLocalPath?: string
}): Promise<ConnectionTestResult> {
  const provID = input.provider.trim().toLowerCase()
  const meta = PROVIDERS_META.find((item) => item.id === provID)
  if (!meta) {
    return { ok: false, provider: provID, error: `Unsupported provider '${provID}'.` }
  }
  const secrets = loadResolvedSecretEnv(input.envLocalPath)
  const apiKey = secrets[meta.envKey]?.trim() ?? ""
  if (!apiKey) {
    return {
      ok: false,
      provider: provID,
      error: `${meta.name} API key (${meta.envKey}) is not configured.`,
    }
  }

  const chosenModel = input.model?.trim() || meta.defaultModel
  const payload: Record<string, unknown> = {
    model: chosenModel,
    messages: [{ role: "user", content: "Say hi in 3 words." }],
    stream: false,
    max_tokens: 16,
  }
  const cleanEffort = input.effort?.trim().toLowerCase() ?? ""
  if (cleanEffort && cleanEffort !== "default" && !(provID === "poe" && CUSTOM_POE_BOTS.has(chosenModel))) {
    payload.reasoning_effort = cleanEffort
  }

  const start = performance.now()
  try {
    const response = await fetch(meta.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    const latencyMs = Math.round(performance.now() - start)
    if (response.ok) {
      const body = (await response.json()) as { model?: string }
      const usedModel = body.model || chosenModel
      return {
        ok: true,
        provider: provID,
        latencyMs,
        message: `Connected (${usedModel}, ${latencyMs}ms)`,
      }
    }
    const text = await response.text()
    return {
      ok: false,
      provider: provID,
      latencyMs,
      error: `HTTP ${response.status}: ${text.slice(0, 240)}`,
    }
  } catch (err) {
    return {
      ok: false,
      provider: provID,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import type { ConnectionTestResult, ProviderKeyInfo } from "@opencode/schema/abucode"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { ABUCODE_ENV_LOCAL } from "./content-paths.js"
import { CUSTOM_POE_BOTS } from "./stream-bridge.js"

export interface ProviderMeta {
  readonly id: string
  readonly name: string
  readonly envKey: string
  readonly baseUrl: string
  readonly apiRoot: string
  readonly defaultModel: string
}

export const PROVIDERS_META: readonly ProviderMeta[] = [
  {
    id: "venice",
    name: "Venice",
    envKey: "VENICE_API_KEY",
    baseUrl: "https://api.venice.ai/api/v1/chat/completions",
    apiRoot: "https://api.venice.ai/api/v1",
    defaultModel: "gemini-4-argon",
  },
  {
    id: "nano-gpt",
    name: "NanoGPT",
    envKey: "NANO_GPT_API_KEY",
    baseUrl: "https://api.nano-gpt.com/api/v1/chat/completions",
    apiRoot: "https://api.nano-gpt.com/api/v1",
    defaultModel: "google/gemini-4-argon",
  },
  {
    id: "poe",
    name: "Poe",
    envKey: "POE_API_KEY",
    baseUrl: "https://api.poe.com/v1/chat/completions",
    apiRoot: "https://api.poe.com/v1",
    defaultModel: "google/gemini-3.8-flash",
  },
  {
    id: "runpod",
    name: "RunPod",
    envKey: "RUNPOD_API_KEY",
    baseUrl: "https://api.runpod.ai/v2",
    apiRoot: "https://api.runpod.ai/v2",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
  },
]

interface SupplementalSpec {
  readonly id: string
  readonly name: string
  readonly family: string
  readonly tools: boolean
  readonly efforts: readonly string[]
  readonly costIn?: number
  readonly costOut?: number
  readonly contextLimit?: number
  readonly outputLimit?: number
}

const SUPPLEMENTAL_MODELS: Readonly<Record<string, readonly SupplementalSpec[]>> = {
  venice: [
    {
      id: "gemini-4-carbon",
      name: "★ Gemini 4 Carbon",
      family: "gemini",
      tools: true,
      efforts: ["low", "medium", "high"],
      costIn: 2.5,
      costOut: 12.5,
      contextLimit: 1_000_000,
      outputLimit: 64_000,
    },
    {
      id: "gemini-4-argon",
      name: "★ Gemini 4 Argon",
      family: "gemini",
      tools: true,
      efforts: ["low", "medium", "high"],
      costIn: 2.5,
      costOut: 12.5,
      contextLimit: 1_000_000,
      outputLimit: 64_000,
    },
    {
      id: "claude-fable-5-2",
      name: "★ Claude Fable 5.2",
      family: "claude-fable",
      tools: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      costIn: 8,
      costOut: 40,
      contextLimit: 200_000,
      outputLimit: 64_000,
    },
    {
      id: "claude-opus-5-5",
      name: "★ Claude Opus 5.5",
      family: "claude-opus",
      tools: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      costIn: 4,
      costOut: 20,
      contextLimit: 200_000,
      outputLimit: 64_000,
    },
    {
      id: "openai-gpt-61-sol",
      name: "★ GPT 6.1 Sol",
      family: "gpt",
      tools: true,
      efforts: ["low", "medium", "high", "xhigh"],
      costIn: 2,
      costOut: 10,
      contextLimit: 400_000,
      outputLimit: 64_000,
    },
  ],
  "nano-gpt": [
    {
      id: "google/gemini-4-carbon",
      name: "★ Gemini 4 Carbon",
      family: "gemini",
      tools: true,
      efforts: ["low", "medium", "high"],
      costIn: 2,
      costOut: 10,
      contextLimit: 1_000_000,
      outputLimit: 64_000,
    },
    {
      id: "google/gemini-4-argon",
      name: "★ Gemini 4 Argon",
      family: "gemini",
      tools: true,
      efforts: ["low", "medium", "high"],
      costIn: 2,
      costOut: 10,
      contextLimit: 1_000_000,
      outputLimit: 64_000,
    },
    {
      id: "anthropic/claude-fable-5.2",
      name: "★ Claude Fable 5.2",
      family: "claude-fable",
      tools: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      costIn: 10,
      costOut: 50,
      contextLimit: 200_000,
      outputLimit: 64_000,
    },
    {
      id: "anthropic/claude-opus-5.5",
      name: "★ Claude Opus 5.5",
      family: "claude-opus",
      tools: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      costIn: 4,
      costOut: 20,
      contextLimit: 200_000,
      outputLimit: 64_000,
    },
    {
      id: "openai/gpt-6.1-sol",
      name: "★ GPT 6.1 Sol",
      family: "gpt",
      tools: true,
      efforts: ["low", "medium", "high", "xhigh"],
      costIn: 2,
      costOut: 10,
      contextLimit: 400_000,
      outputLimit: 64_000,
    },
  ],
  poe: [
    {
      id: "CArgon-4",
      name: "★ Gemini 4 Argon (Poe Bot)",
      family: "gemini",
      tools: true,
      efforts: [],
    },
    {
      id: "CArgon-4T",
      name: "★ Gemini 4 Argon Thinking (Poe Bot)",
      family: "gemini-thinking",
      tools: true,
      efforts: [],
    },
    {
      id: "CFable-51",
      name: "★ Claude Fable 5.1 (Poe Bot)",
      family: "claude",
      tools: true,
      efforts: [],
    },
    {
      id: "CFable-51T",
      name: "★ Claude Fable 5.1 Thinking (Poe Bot)",
      family: "claude-thinking",
      tools: true,
      efforts: [],
    },
  ],
}

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

function buildSupplementalModelInfo(providerID: Provider.ID, spec: SupplementalSpec): Model.Info {
  const base = Model.Info.default(providerID, Model.ID.make(spec.id))
  const isVenice = providerID === "venice"
  const variants: Model.Variant[] = spec.efforts.map((effort) =>
    isVenice
      ? {
          id: Model.VariantID.make(effort),
          settings: { reasoningEffort: effort },
        }
      : {
          id: Model.VariantID.make(effort),
          body: { reasoning_effort: effort },
        },
  )
  const cost: Model.Cost[] =
    spec.costIn !== undefined && spec.costOut !== undefined
      ? [
          {
            input: Money.USDPerMillionTokens.make(spec.costIn),
            output: Money.USDPerMillionTokens.make(spec.costOut),
            cache: {
              read: Money.USDPerMillionTokens.make(Number((spec.costIn * 0.1).toFixed(4))),
              write: Money.USDPerMillionTokens.make(0),
            },
          },
        ]
      : []

  return {
    ...base,
    name: spec.name,
    family: Model.Family.make(spec.family),
    capabilities: {
      tools: spec.tools,
      input: ["text", "image"],
      output: ["text"],
    },
    limit: {
      context: spec.contextLimit ?? base.limit.context,
      output: spec.outputLimit ?? base.limit.output,
    },
    variants,
    cost,
  }
}

export function applyABuCodeProviderTransform(editor: ProviderEditor): void {
  const secrets = loadResolvedSecretEnv()

  for (const meta of PROVIDERS_META) {
    if (meta.id === "runpod") continue
    const pid = Provider.ID.make(meta.id)
    const apiKey = secrets[meta.envKey]?.trim() ?? ""
    const existing = editor.get(meta.id)
    const specs = SUPPLEMENTAL_MODELS[meta.id] ?? []
    const defaultPkg = meta.id === "venice" ? "@opencode/ai/providers/venice" : "@ai-sdk/openai-compatible"

    if (!existing) {
      editor.add({
        info: {
          id: pid,
          name: meta.name,
          activation: apiKey ? "enabled" : "auto",
          package: defaultPkg,
          settings: {
            baseURL: meta.apiRoot,
            ...(apiKey ? { apiKey } : {}),
          },
        },
        models: specs.map((spec) => buildSupplementalModelInfo(pid, spec)),
      })
      continue
    }

    if (apiKey || meta.id === "venice") {
      editor.update(meta.id, (prov) => {
        if (meta.id === "venice" && (!prov.package || prov.package === "@ai-sdk/openai-compatible")) {
          prov.package = "@opencode/ai/providers/venice"
        }
        if (!apiKey) return
        prov.activation = "enabled"
        prov.settings = {
          ...(prov.settings ?? {}),
          baseURL: (prov.settings as Record<string, unknown> | undefined)?.baseURL ?? meta.apiRoot,
          apiKey: (prov.settings as Record<string, unknown> | undefined)?.apiKey || apiKey,
        }
      })
    }

    const currentModels = new Map(existing.models)
    let added = false
    for (const spec of specs) {
      const built = buildSupplementalModelInfo(pid, spec)
      const prev = currentModels.get(spec.id)
      if (!prev) {
        currentModels.set(spec.id, built)
        added = true
      } else if (built.variants.length > 0 && prev.variants.length === 0) {
        currentModels.set(spec.id, {
          ...prev,
          name: built.name,
          variants: built.variants,
        })
        added = true
      }
    }
    if (added) {
      editor.models.set(meta.id, Array.from(currentModels.values()))
    }
  }
}

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
    ...(provID === "venice"
      ? {
          max_completion_tokens: 16,
          venice_parameters: { include_venice_system_prompt: false },
        }
      : { max_tokens: 16 }),
  }
  const cleanEffort = input.effort?.trim().toLowerCase() ?? ""
  if (cleanEffort && cleanEffort !== "default" && !(provID === "poe" && CUSTOM_POE_BOTS.has(chosenModel))) {
    if (provID === "venice") payload.reasoning = { effort: cleanEffort }
    if (provID !== "venice") payload.reasoning_effort = cleanEffort
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

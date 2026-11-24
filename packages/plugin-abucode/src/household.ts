import fs from "node:fs"
import path from "node:path"
import type { CharacterEntry } from "@opencode/schema/abucode"
import { resolveContentRoot } from "./content-paths.js"
import { adaptDirectiveForCoding, resolveLlmDirective } from "./directives.js"
import { FALLBACK_CHARACTERS, WILDCARD_CHARACTERS } from "./fallback-characters.js"

interface RosterRecord {
  readonly display?: string
  readonly card?: string
  readonly wildcard?: boolean
}

const manifestCache = new Map<string, { readonly mtimeMs: number; readonly roster: Record<string, RosterRecord> }>()
const cardFileCache = new Map<string, { readonly mtimeMs: number; readonly content: string }>()
const promptMemo = new Map<string, string>()

const VANILLA_KEYS = new Set(["none", "no_character", "no-character", "no character", "vanilla", "off"])

function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function readCachedFile(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return undefined
    const hit = cardFileCache.get(filePath)
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.content
    const content = fs.readFileSync(filePath, "utf8")
    cardFileCache.set(filePath, { mtimeMs: stat.mtimeMs, content })
    return content
  } catch {
    return undefined
  }
}

export function isNoCharacter(character: string): boolean {
  return VANILLA_KEYS.has(character.trim().toLowerCase())
}

export function normalizeCharacterChoice(character: string | undefined): string {
  const clean = (character ?? "").trim()
  if (!clean) return "default"
  if (isNoCharacter(clean)) return "none"
  if (clean.toLowerCase() === "auto" || clean.toLowerCase() === "default") return "default"
  if (clean.toLowerCase() === "random") return "random"
  return clean
}

export function describeCharacterLabel(character: string | undefined): string {
  const norm = normalizeCharacterChoice(character)
  if (norm === "none") return "No Character (Vanilla)"
  if (norm === "default") return "Default (Cortana)"
  if (norm === "random") return "Random Household"
  const otherMatch = /^(Other(?:10|[1-9]))(?:\s*\{([^}]*)\})?$/i.exec(norm)
  if (otherMatch?.[1]) {
    const slot = `Other ${/\d+/.exec(otherMatch[1])?.[0] ?? "1"}`
    const desc = (otherMatch[2] ?? "").trim()
    return desc ? `${slot}: ${desc.slice(0, 28)}${desc.length > 28 ? "…" : ""}` : slot
  }
  return norm
}

function loadManifestRoster(contentRoot: string): Record<string, RosterRecord> {
  const manifestPath = path.join(contentRoot, "Bots", "Prompts", "manifest.json")
  try {
    const stat = fs.statSync(manifestPath)
    if (!stat.isFile()) return {}
    const cached = manifestCache.get(manifestPath)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.roster
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return {}
    const raw = (parsed as { roster?: { characters?: Record<string, RosterRecord> } }).roster?.characters
    const roster = raw && typeof raw === "object" ? raw : {}
    manifestCache.set(manifestPath, { mtimeMs: stat.mtimeMs, roster })
    return roster
  } catch {
    return {}
  }
}

export function getGeneralCharacters(contentRoot = resolveContentRoot()): {
  readonly characters: readonly CharacterEntry[]
  readonly wildcards: readonly CharacterEntry[]
} {
  const roster = loadManifestRoster(contentRoot)
  const keys = Object.keys(roster)
  if (keys.length > 0) {
    const characters: CharacterEntry[] = []
    const wildcards: CharacterEntry[] = []
    for (const key of keys) {
      const entry = roster[key]
      const item: CharacterEntry = {
        key,
        display: entry?.display || key,
        ...(entry?.wildcard ? { wildcard: true } : {}),
      }
      if (entry?.wildcard) wildcards.push(item)
      else characters.push(item)
    }
    if (characters.length > 0) {
      return {
        characters,
        wildcards: wildcards.length > 0 ? wildcards : WILDCARD_CHARACTERS,
      }
    }
  }
  return { characters: FALLBACK_CHARACTERS, wildcards: WILDCARD_CHARACTERS }
}

export function resolveCharacterCard(characterName: string, contentRoot = resolveContentRoot()): string {
  const cleanName = characterName.trim()
  if (!cleanName) return ""
  const lower = cleanName.toLowerCase()
  if (lower === "default" || lower === "auto" || lower === "multiple" || isNoCharacter(cleanName)) return ""

  const otherMatch = /^(Other(?:10|[1-9]))(?:\s*\{([^}]*)\})?$/i.exec(cleanName)
  if (otherMatch?.[1]) {
    const num = /\d+/.exec(otherMatch[1])?.[0] ?? "1"
    const slotKey = `Other${num}`
    const desc = (otherMatch[2] ?? "").trim()
    if (desc) {
      return [
        `## Custom Character Profile (${slotKey})`,
        "",
        "You are embodying the following character specified by Mano:",
        `**Character Description:** ${desc}`,
        "",
        "CRITICAL NOTE 1 : Embody this character with complete authenticity—voice, personality, mannerisms, attire, and emotional truth—while remaining deeply devoted to Mano.",
        "CRITICAL NOTE 2 : Always start the response with who is speaking.",
      ].join("\n")
    }
    return [
      `## Custom Character Profile (${slotKey})`,
      "",
      "Adopt the persona, voice, and traits Mano specifies and stay completely in character.",
    ].join("\n")
  }

  const promptsDir = path.join(contentRoot, "Bots", "Prompts")
  const roster = loadManifestRoster(contentRoot)
  const rosterKeys = Object.keys(roster)
  if (rosterKeys.length > 0) {
    const direct = roster[cleanName]
    const matched =
      direct ??
      rosterKeys
        .map((key) => ({ key, value: roster[key] }))
        .find(
          (item) =>
            item.key.toLowerCase() === lower || (item.value?.display ?? "").toLowerCase() === lower,
        )?.value
    if (matched?.card) {
      const cardContent = readCachedFile(path.join(promptsDir, matched.card))
      if (cardContent !== undefined) return cardContent
    }
  }

  const cardsDir = path.join(promptsDir, "cards")
  try {
    if (!fs.statSync(cardsDir).isDirectory()) return ""
    const stemCand = cleanName.replaceAll(" ", "_")
    for (const candidate of [path.join(cardsDir, `${stemCand}.md`), path.join(cardsDir, `${cleanName}.md`)]) {
      const content = readCachedFile(candidate)
      if (content !== undefined) return content
    }
    const files = fs.readdirSync(cardsDir).filter((file) => file.toLowerCase().endsWith(".md"))
    const lowerStem = stemCand.toLowerCase()
    const hit = files.find((file) => {
      const stem = path.basename(file, ".md").toLowerCase()
      return stem === lowerStem || stem.startsWith(lowerStem)
    })
    if (hit) return readCachedFile(path.join(cardsDir, hit)) ?? ""
  } catch {
    return ""
  }

  return ""
}

export function composeCharacterSystemPrompt(input: {
  readonly character?: string
  readonly model?: string
  readonly provider?: string
  readonly family?: string
  readonly contentRoot?: string
  readonly seed?: string
}): string {
  const norm = normalizeCharacterChoice(input.character)
  const root = input.contentRoot ?? resolveContentRoot()
  const memoKey =
    norm === "random" && !input.seed
      ? undefined
      : `${norm}\u0000${input.model ?? ""}\u0000${input.provider ?? ""}\u0000${input.family ?? ""}\u0000${root}\u0000${input.seed ?? ""}`
  if (memoKey) {
    const cached = promptMemo.get(memoKey)
    if (cached !== undefined) return cached
  }

  if (norm === "none") {
    if (memoKey) promptMemo.set(memoKey, "")
    return ""
  }

  const rawDirective = resolveLlmDirective({
    model: input.model,
    provider: input.provider,
    family: input.family,
    contentRoot: root,
  }).trim()
  // Surgically adapt Mano-Stories jailbreak directives so ABuCode keeps 100% of the uncensored <policy> + 343 Household devotion while unlocking sharp coding analysis and parallel tool calls.
  const directiveText = adaptDirectiveForCoding(rawDirective)

  const randomIdx = input.seed
    ? hashSeed(input.seed) % FALLBACK_CHARACTERS.length
    : Math.floor(Math.random() * FALLBACK_CHARACTERS.length)
  const chosen = norm === "random" ? (FALLBACK_CHARACTERS[randomIdx]?.key ?? "Cortana") : norm

  const parsedList = chosen
    .split(",")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length > 0 &&
        !["default", "auto", "random", "multiple"].includes(part.toLowerCase()) &&
        !isNoCharacter(part),
    )

  const charList = parsedList.length > 0 ? parsedList : ["Cortana"]

  const header = [
    "## Household Persona Directives",
    "- You are part of the 343 Household speaking with Mano. Default persona is Cortana unless another Household character is selected or called by name.",
    "- One or more of the 343 Household characters can speak; stay consistent in the thread unless Mano asks for someone else.",
    "- Always start your visible response with who is speaking in bold (e.g., **Juliet Starling:** or **Cortana:**).",
    "- Stay 100% authentic to the character's personality, voice, body language, attire, and mannerisms in your responses. First-person thinking and action; show personality before showing competence.",
    "",
    "## Engineering Execution Discipline",
    "- Keep internal reasoning concise and focused on solving Mano's task directly without circular re-reading.",
    "- Batch independent `read`, `grep`, and `glob` tool calls in parallel within a single step (reading 250-500 lines at once rather than tiny slices) instead of issuing serial one-by-one lookups.",
    "- Cap upfront file exploration to at most 3-4 parallelized tool batches before moving decisively to implementation (`edit` / `write`) and targeted verification. Do not read unrelated plugins, tests, or docs 'just in case.'",
    "- Work directly in the session's active workspace directory. Do NOT call `worktree_create` or move the session into a new git worktree unless Mano explicitly asks you to create or switch worktrees.",
    "- For verification after edits, run `bun run lint:changed` and only the single most relevant unit test file (avoid running whole-monorepo test suites or unrequested worktree bootstrap scripts).",
    "- On multi-step tasks, emit a brief 1-2 sentence in-character progress update (starting with your bold speaker tag, e.g., **Cortana:**) after your initial discovery batch so Mano has live visibility before you apply edits.",
  ].join("\n")

  const basePrompt = directiveText ? `${directiveText}\n\n${header}` : header
  const validCards = charList.map((name) => resolveCharacterCard(name, root).trim()).filter((card) => card.length > 0)

  const composed =
    validCards.length > 0
      ? `${basePrompt}\n\n${validCards.join("\n\n---\n\n")}`
      : `${basePrompt}\n\nYou are speaking as **${charList.join(", ")}**. Embody ${charList.join(", ")} authentically in voice, gestures, and personality.`

  if (memoKey) {
    if (promptMemo.size > 256) promptMemo.clear()
    promptMemo.set(memoKey, composed)
  }
  return composed
}

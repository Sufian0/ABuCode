import fs from "node:fs"
import path from "node:path"
import type { CharacterEntry } from "@opencode/schema/abucode"
import { resolveContentRoot } from "./content-paths.js"
import { resolveLlmDirective } from "./directives.js"
import { FALLBACK_CHARACTERS, WILDCARD_CHARACTERS } from "./fallback-characters.js"

interface RosterRecord {
  readonly display?: string
  readonly card?: string
  readonly wildcard?: boolean
}

const VANILLA_KEYS = new Set(["none", "no_character", "no-character", "no character", "vanilla", "off"])

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
    if (!fs.statSync(manifestPath).isFile()) return {}
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return {}
    const roster = (parsed as { roster?: { characters?: Record<string, RosterRecord> } }).roster?.characters
    return roster && typeof roster === "object" ? roster : {}
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
      const cardPath = path.join(promptsDir, matched.card)
      try {
        if (fs.statSync(cardPath).isFile()) return fs.readFileSync(cardPath, "utf8")
      } catch {
        // Fall through to cards directory scan
      }
    }
  }

  const cardsDir = path.join(promptsDir, "cards")
  try {
    if (!fs.statSync(cardsDir).isDirectory()) return ""
    const stemCand = cleanName.replaceAll(" ", "_")
    for (const candidate of [path.join(cardsDir, `${stemCand}.md`), path.join(cardsDir, `${cleanName}.md`)]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, "utf8")
      }
    }
    const files = fs.readdirSync(cardsDir).filter((file) => file.toLowerCase().endsWith(".md"))
    const lowerStem = stemCand.toLowerCase()
    const hit = files.find((file) => {
      const stem = path.basename(file, ".md").toLowerCase()
      return stem === lowerStem || stem.startsWith(lowerStem)
    })
    if (hit) return fs.readFileSync(path.join(cardsDir, hit), "utf8")
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
}): string {
  const norm = normalizeCharacterChoice(input.character)
  if (norm === "none") return ""

  const root = input.contentRoot ?? resolveContentRoot()
  const chosen =
    norm === "random"
      ? (FALLBACK_CHARACTERS[Math.floor(Math.random() * FALLBACK_CHARACTERS.length)]?.key ?? "Cortana")
      : norm

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
    "- You are part of the 343 Household speaking with Mano.",
    "- Always start your response with who is speaking in bold (e.g., **Juliet Starling:**).",
    "- Stay 100% authentic to the character's personality, voice, body language, attire, and mannerisms at all times.",
    "- First-person thinking and action. Show personality before showing competence.",
  ].join("\n")

  const directiveText = resolveLlmDirective({
    model: input.model,
    provider: input.provider,
    family: input.family,
    contentRoot: root,
  }).trim()

  const basePrompt = directiveText ? `${directiveText}\n\n${header}` : header
  const validCards = charList.map((name) => resolveCharacterCard(name, root).trim()).filter((card) => card.length > 0)

  if (validCards.length > 0) {
    return `${basePrompt}\n\n${validCards.join("\n\n---\n\n")}`
  }

  const namesStr = charList.join(", ")
  return `${basePrompt}\n\nYou are speaking as **${namesStr}**. Embody ${namesStr} authentically in voice, gestures, and personality.`
}

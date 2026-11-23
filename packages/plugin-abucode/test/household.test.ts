import { describe, expect, test } from "bun:test"
import { resolveLlmDirective } from "../src/directives.js"
import {
  composeCharacterSystemPrompt,
  describeCharacterLabel,
  getGeneralCharacters,
  isNoCharacter,
  normalizeCharacterChoice,
  resolveCharacterCard,
} from "../src/household.js"

describe("Household 343 & Vanilla Mode", () => {
  test("No Character / Vanilla mode still injects the LLM directive without Household character cards", () => {
    const expectedDirective = resolveLlmDirective({
      model: "gemini-4-argon",
      provider: "venice",
    }).trim()
    for (const alias of ["none", "vanilla", "no_character", "no character", "off"]) {
      expect(isNoCharacter(alias)).toBe(true)
      expect(normalizeCharacterChoice(alias)).toBe("none")
      const prompt = composeCharacterSystemPrompt({
        character: alias,
        model: "gemini-4-argon",
        provider: "venice",
      })
      expect(prompt).toBe(expectedDirective)
      expect(prompt).not.toContain("## Household Persona Directives")
    }
    expect(describeCharacterLabel("none")).toBe("No Character (Vanilla)")
  })

  test("Default / Auto resolves Cortana with Household header", () => {
    const prompt = composeCharacterSystemPrompt({
      character: "default",
      model: "gemini-4-argon",
      provider: "venice",
    })
    expect(prompt).toContain("## Household Persona Directives")
    expect(prompt).toContain("Cortana")
    expect(describeCharacterLabel("default")).toBe("Default (Cortana)")
  })

  test("Roster exposes 333+ Household characters and 10 wildcards", () => {
    const roster = getGeneralCharacters()
    expect(roster.characters.length).toBeGreaterThanOrEqual(333)
    expect(roster.wildcards.length).toBe(10)
    expect(roster.characters.some((item) => item.key === "Cortana")).toBe(true)
    expect(roster.characters.some((item) => item.key === "Juliet")).toBe(true)
  })

  test("Multi-character and Other1..10 wildcard composition works", () => {
    const multi = composeCharacterSystemPrompt({
      character: "Cortana, Juliet",
      model: "claude-fable-5-2",
      provider: "venice",
    })
    expect(multi).toContain("Cortana")
    expect(multi).toContain("Juliet")

    const wild = resolveCharacterCard("Other3 {Sassy orbital ship AI in an oversized cardigan}")
    expect(wild).toContain("Custom Character Profile (Other3)")
    expect(wild).toContain("Sassy orbital ship AI in an oversized cardigan")
  })

  test("Model directive matcher resolves model aliases and family fallbacks cleanly", () => {
    const dir = resolveLlmDirective({ model: "gemini-4-carbon", provider: "venice" })
    expect(typeof dir).toBe("string")
  })
})

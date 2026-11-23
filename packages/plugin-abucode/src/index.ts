import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { ABuCode, type PolicyTier, type SessionSettings } from "@opencode/schema/abucode"
import { Effect, Option, Schema } from "effect"
import { resolveContentRoot } from "./content-paths.js"
import {
  composeCharacterSystemPrompt,
  describeCharacterLabel,
  getGeneralCharacters,
  normalizeCharacterChoice,
} from "./household.js"
import {
  applyABuCodeProviderTransform,
  getProviderKeysStatus,
  loadResolvedSecretEnv,
  saveProviderKeysToEnvLocal,
  testProviderConnection,
} from "./providers.js"
import { normalizePolicyTier } from "./security.js"
import { isCustomPoeBot, sanitizePoeRequestBodyJson, wrapResilientLanguageModel } from "./stream-bridge.js"

const decodeString = Schema.decodeUnknownOption(Schema.String)

const KEY_DEFAULT_CHARACTER = "global:character"
const KEY_DEFAULT_POLICY = "global:policy"
const sessionCharKey = (sessionID: string) => `session:${sessionID}:character`
const sessionMemKey = (sessionID: string) => `session:${sessionID}:memory`
const sessionPolicyKey = (sessionID: string) => `session:${sessionID}:policy`

const CHARACTER_USAGE = [
  "Usage: /character <choice>",
  "Choices:",
  "  none          - No Character (pure vanilla coding assistant)",
  "  default       - Auto mode (Cortana default, switches when called)",
  "  random        - Pick a random Household character",
  "  <Name>        - Any of the 343 Household characters (e.g. Cortana, Juliet, Aerith)",
  "  <N1, N2>      - Multiple simultaneous speakers (e.g. Cortana, Juliet)",
  "  Other1 {desc} - Custom wildcard slot Other1..Other10",
  "  list [filter] - Search available Household characters",
].join("\n")

interface ChangedPayload {
  readonly sessionID?: string
  readonly settings?: SessionSettings
  readonly defaultCharacter?: string
  readonly defaultPolicy?: PolicyTier
}

export default define({
  id: "abucode.core",
  effect: Effect.fn("ABuCodePlugin")(function* (ctx) {
    loadResolvedSecretEnv()

    yield* ctx.provider.transform(applyABuCodeProviderTransform)

    yield* ctx.aisdk.hook("sdk", (event) =>
      Effect.sync(() => {
        const modelID = String(event.model.modelID || event.model.id)
        const providerID = String(event.model.providerID)
        if (!isCustomPoeBot(providerID, modelID)) return
        const baseFetch: typeof fetch = typeof event.options.fetch === "function" ? event.options.fetch : fetch
        event.options.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (init && typeof init.body === "string") {
            return baseFetch(input, {
              ...init,
              body: sanitizePoeRequestBodyJson(init.body, providerID, modelID),
            })
          }
          return baseFetch(input, init)
        }
      }),
    )

    yield* ctx.aisdk.hook("language", (event) =>
      Effect.sync(() => {
        const providerID = String(event.model.providerID)
        const modelID = String(event.model.modelID || event.model.id)
        const rawLang =
          event.language ??
          (typeof event.sdk?.languageModel === "function" ? event.sdk.languageModel(modelID) : undefined)
        if (!rawLang) return
        event.language = wrapResilientLanguageModel(rawLang, {
          providerID,
          modelID,
          forceXmlTools: isCustomPoeBot(providerID, modelID) || !event.model.capabilities.tools,
        })
      }),
    )

    let emitChanged: (payload: ChangedPayload) => Effect.Effect<void> = () => Effect.void

    const readStr = (key: string) =>
      ctx.storage.get(key).pipe(
        Effect.map((raw) => Option.getOrUndefined(decodeString(raw))),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

    const writeStr = (key: string, value: string) =>
      ctx.storage.set(key, value).pipe(Effect.catchCause(() => Effect.void))

    const removeKey = (key: string) =>
      ctx.storage.remove(key).pipe(Effect.catchCause(() => Effect.void))

    const getDefaultCharacter = () => readStr(KEY_DEFAULT_CHARACTER).pipe(Effect.map(normalizeCharacterChoice))

    const getDefaultPolicy = () => readStr(KEY_DEFAULT_POLICY).pipe(Effect.map(normalizePolicyTier))

    const buildSessionSettings = (sessionID: string) =>
      Effect.gen(function* () {
        const savedChar = yield* readStr(sessionCharKey(sessionID))
        const effectiveChar =
          savedChar !== undefined ? normalizeCharacterChoice(savedChar) : yield* getDefaultCharacter()
        const memory = (yield* readStr(sessionMemKey(sessionID))) ?? ""
        const savedPol = yield* readStr(sessionPolicyKey(sessionID))
        const policy = savedPol !== undefined ? normalizePolicyTier(savedPol) : yield* getDefaultPolicy()
        const settings: SessionSettings = {
          sessionID,
          character: effectiveChar,
          characterLabel: describeCharacterLabel(effectiveChar),
          memory,
          policy,
        }
        return settings
      })

    const rpc = yield* ctx.rpc
      .register(ABuCode.Definition, {
        catalog: () =>
          Effect.gen(function* () {
            const contentRoot = resolveContentRoot()
            const roster = getGeneralCharacters(contentRoot)
            const defaultCharacter = yield* getDefaultCharacter()
            const defaultPolicy = yield* getDefaultPolicy()
            return {
              characters: [...roster.characters],
              wildcards: [...roster.wildcards],
              defaultCharacter,
              defaultPolicy,
              contentRoot,
            }
          }),
        getSession: (input) => buildSessionSettings(input.sessionID),
        setCharacter: (input) =>
          Effect.gen(function* () {
            const norm = normalizeCharacterChoice(input.character)
            yield* writeStr(sessionCharKey(input.sessionID), norm)
            if (input.saveAsDefault) {
              yield* writeStr(KEY_DEFAULT_CHARACTER, norm)
            }
            const next = yield* buildSessionSettings(input.sessionID)
            const defaultCharacter = yield* getDefaultCharacter()
            yield* emitChanged({ sessionID: input.sessionID, settings: next, defaultCharacter })
            return next
          }),
        setMemory: (input) =>
          Effect.gen(function* () {
            const clean = input.memory.trim()
            if (clean) yield* writeStr(sessionMemKey(input.sessionID), clean)
            else yield* removeKey(sessionMemKey(input.sessionID))
            const next = yield* buildSessionSettings(input.sessionID)
            yield* emitChanged({ sessionID: input.sessionID, settings: next })
            return next
          }),
        setPolicy: (input) =>
          Effect.gen(function* () {
            const tier = normalizePolicyTier(input.policy)
            yield* writeStr(sessionPolicyKey(input.sessionID), tier)
            if (input.saveAsDefault) {
              yield* writeStr(KEY_DEFAULT_POLICY, tier)
            }
            const next = yield* buildSessionSettings(input.sessionID)
            const defaultPolicy = yield* getDefaultPolicy()
            yield* emitChanged({ sessionID: input.sessionID, settings: next, defaultPolicy })
            return next
          }),
        getKeys: () => Effect.sync(() => getProviderKeysStatus()),
        saveKeys: (input) =>
          Effect.gen(function* () {
            const updated = saveProviderKeysToEnvLocal(input.keys)
            yield* ctx.provider.reload().pipe(Effect.catchCause(() => Effect.void))
            return updated
          }),
        testProvider: (input) =>
          Effect.promise(() =>
            testProviderConnection({
              provider: input.provider,
              model: input.model,
              effort: input.effort,
            }),
          ),
      })
      .pipe(Effect.orDie)

    emitChanged = (payload) => rpc.events.emit("changed", payload).pipe(Effect.catchCause(() => Effect.void))

    const injectContext = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const settings = yield* buildSessionSettings(event.sessionID)
        const parts: string[] = []

        const personaPrompt = composeCharacterSystemPrompt({
          character: settings.character,
          model: event.model.id,
          provider: event.model.providerID,
        }).trim()
        if (personaPrompt) parts.push(personaPrompt)

        if (settings.memory.trim()) {
          parts.push(`## Pinned Session Context / Memory\n\n${settings.memory.trim()}`)
        }

        if (parts.length > 0) {
          event.system.splice(1, 0, SystemPart.make(parts.join("\n\n---\n\n")))
        }
      }).pipe(Effect.catchCause(() => Effect.void))

    yield* ctx.session.hook("context", injectContext)
    yield* ctx.session.hook("generate", injectContext)

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "character",
        description: "switch Household persona or 'none' for Vanilla mode (/character [none|default|random|<Name>|list])",
        execute: (input) =>
          Effect.gen(function* () {
            const raw = input.prompt.text.trim()
            const current = yield* buildSessionSettings(input.sessionID)
            if (!raw) {
              return yield* Effect.fail(
                new Error(`Active character: ${current.characterLabel} (${current.character})\n\n${CHARACTER_USAGE}`),
              )
            }
            if (raw.toLowerCase() === "list" || raw.toLowerCase().startsWith("list ")) {
              const filter = raw.slice(4).trim().toLowerCase()
              const roster = getGeneralCharacters()
              const matches = roster.characters.filter(
                (item) =>
                  !filter ||
                  item.key.toLowerCase().includes(filter) ||
                  item.display.toLowerCase().includes(filter),
              )
              const preview = matches
                .slice(0, 25)
                .map((item) => `  ${item.key} (${item.display})`)
                .join("\n")
              const more =
                matches.length > 25 ? `\n  ...and ${matches.length - 25} more (use /character list <query>)` : ""
              return yield* Effect.fail(
                new Error(
                  `Household Characters (${matches.length} matched):\n  none (No Character — Vanilla)\n  default (Auto — Cortana)\n${preview}${more}`,
                ),
              )
            }
            const globalFlag = raw.endsWith(" --global")
            const choiceText = globalFlag ? raw.slice(0, -" --global".length).trim() : raw
            const norm = normalizeCharacterChoice(choiceText)
            yield* writeStr(sessionCharKey(input.sessionID), norm)
            if (globalFlag) yield* writeStr(KEY_DEFAULT_CHARACTER, norm)
            const next = yield* buildSessionSettings(input.sessionID)
            const defaultCharacter = yield* getDefaultCharacter()
            yield* emitChanged({ sessionID: input.sessionID, settings: next, defaultCharacter })
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Switched active persona to **${next.characterLabel}**.`,
              description: `Character -> ${next.characterLabel}`,
              metadata: { source: "abucode.character", character: next.character },
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })

      editor.add({
        name: "keys",
        description: "view .env.local provider key status or run latency test (/keys [status | test venice|nano-gpt|poe])",
        execute: (input) =>
          Effect.gen(function* () {
            const raw = input.prompt.text.trim().toLowerCase()
            if (!raw || raw === "status") {
              const statuses = getProviderKeysStatus()
              const lines = statuses.map(
                (k) => `  ${k.name} (${k.envKey}): ${k.hasKey ? `Ready (${k.maskedKey})` : "Not set"}`,
              )
              return yield* Effect.fail(
                new Error(
                  `ABuCode .env.local Provider Keys:\n${lines.join("\n")}\n\nRun '/keys test venice' (or nano-gpt / poe) to test connectivity, or configure keys in Settings -> ABuCode.`,
                ),
              )
            }
            if (raw.startsWith("test ")) {
              const target = raw.slice(5).trim()
              const res = yield* Effect.promise(() => testProviderConnection({ provider: target }))
              if (!res.ok) {
                return yield* Effect.fail(new Error(`${target} connection failed: ${res.error ?? "Unknown error"}`))
              }
              yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `Provider **${res.provider}** test succeeded: ${res.message ?? "OK"}`,
                description: `Provider test (${res.provider}): ${res.message ?? "OK"}`,
                metadata: { source: "abucode.keys" },
                delivery: input.delivery,
              })
              return
            }
            return yield* Effect.fail(new Error("Usage: /keys [status | test venice | test nano-gpt | test poe]"))
          }).pipe(Effect.asVoid),
      })
    })
  }),
})

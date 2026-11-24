import path from "node:path"
import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import {
  ABuCode,
  type ApprovalAlert,
  type PolicyTier,
  type SessionSettings,
  type SquadRoleName,
  type SquadSettings,
} from "@opencode/schema/abucode"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import {
  archiveSessionToChatHistory,
  coalesceSessionMessagesToTurns,
  isInTempDir,
  isSessionArchiveUpToDate,
  removeSessionFromChatHistory,
} from "./archiver.js"
import { resolveContentRoot } from "./content-paths.js"
import {
  composeCharacterSystemPrompt,
  describeCharacterLabel,
  getGeneralCharacters,
  normalizeCharacterChoice,
} from "./household.js"
import { isPlaytestTargetPortOpen, PlaytestInput, PlaytestOutput, runPlaytestUrl } from "./playtest.js"
import {
  applyABuCodeProviderTransform,
  getProviderKeysStatus,
  loadResolvedSecretEnv,
  saveProviderKeysToEnvLocal,
  testProviderConnection,
} from "./providers.js"
import {
  appendCompactionSummaryToMemory,
  buildRepoContextBlock,
  compactTurnsIntoMemory,
  derivePoeSmartTitle,
  type CompactableTurn,
} from "./repo-context.js"
import {
  classifyCatastrophicCommand,
  commandStagesSecretEnvFile,
  evaluateShellPolicyDecision,
  normalizePolicyTier,
  redactKnownSecrets,
  scrubEnvironmentInPlace,
  secretFileAccessReason,
  validateResolvedFetchUrlGuard,
} from "./security.js"
import {
  AgentReportStore,
  compileSquadWorkflow,
  DEFAULT_SQUAD_SETTINGS,
  DispatchSubagentInput,
  DispatchSubagentOutput,
  executeSquadWorkflow,
  GetAgentReportInput,
  GetAgentReportOutput,
  normalizeSquadSettings,
  runHouseholdSubagents,
  RunWorkflowInput,
  RunWorkflowOutput,
  SQUAD_ROLES,
  TurnAgentBudget,
} from "./squad.js"
import { isCustomPoeBot, sanitizePoeRequestBodyJson, wrapResilientLanguageModel } from "./stream-bridge.js"

const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeSquadJson = Schema.decodeUnknownOption(Schema.fromJsonString(ABuCode.SquadSettings))

const KEY_DEFAULT_CHARACTER = "global:character"
const KEY_DEFAULT_POLICY = "global:policy"
const KEY_DEFAULT_SQUAD = "global:squad"
const sessionCharKey = (sessionID: string) => `session:${sessionID}:character`
const sessionMemKey = (sessionID: string) => `session:${sessionID}:memory`
const sessionPolicyKey = (sessionID: string) => `session:${sessionID}:policy`
const sessionSquadKey = (sessionID: string) => `session:${sessionID}:squad`

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

const SQUAD_USAGE = [
  "Usage: /squad <command>",
  "Commands:",
  "  status                                     - Show active Squad workflow & routing settings",
  "  on | off                                   - Enable or disable Squad multi-agent orchestration",
  "  max <auto | 4 | 6 | 8 | 10 | 12>           - Set per-turn Squad agent cap",
  "  cost <usd>                                 - Set USD workflow cost confirmation gate (e.g. 5.0)",
  "  route <role> <same|venice|nano-gpt|poe> [model] [effort] - Route scout/investigator/skeptic/reviewer across subscriptions",
  "  reset                                      - Reset Squad settings to Auto defaults",
].join("\n")

interface ChangedPayload {
  readonly sessionID?: string
  readonly settings?: SessionSettings
  readonly defaultCharacter?: string
  readonly defaultPolicy?: PolicyTier
  readonly defaultSquad?: SquadSettings
  readonly approvalAlert?: ApprovalAlert
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

    const parseSquadJson = (raw: string | undefined): SquadSettings | undefined => {
      if (!raw) return undefined
      const decoded = Option.getOrUndefined(decodeSquadJson(raw))
      return decoded ? normalizeSquadSettings(decoded) : undefined
    }

    const getDefaultCharacter = () => readStr(KEY_DEFAULT_CHARACTER).pipe(Effect.map(normalizeCharacterChoice))
    const getDefaultPolicy = () => readStr(KEY_DEFAULT_POLICY).pipe(Effect.map(normalizePolicyTier))
    const getDefaultSquad = () =>
      readStr(KEY_DEFAULT_SQUAD).pipe(Effect.map((raw) => parseSquadJson(raw) ?? DEFAULT_SQUAD_SETTINGS))

    const buildSessionSettings = (sessionID: string) =>
      Effect.gen(function* () {
        const savedChar = yield* readStr(sessionCharKey(sessionID))
        const effectiveChar =
          savedChar !== undefined ? normalizeCharacterChoice(savedChar) : yield* getDefaultCharacter()
        const memory = (yield* readStr(sessionMemKey(sessionID))) ?? ""
        const savedPol = yield* readStr(sessionPolicyKey(sessionID))
        const policy = savedPol !== undefined ? normalizePolicyTier(savedPol) : yield* getDefaultPolicy()
        const savedSquad = parseSquadJson(yield* readStr(sessionSquadKey(sessionID)))
        const squad = savedSquad ?? (yield* getDefaultSquad())
        const settings: SessionSettings = {
          sessionID,
          character: effectiveChar,
          characterLabel: describeCharacterLabel(effectiveChar),
          memory,
          policy,
          squad,
        }
        return settings
      })

    const runSessionMemoryCompaction = (input: {
      readonly sessionID: Session.ID
      readonly keepLast?: number
      readonly note?: string
    }) =>
      Effect.gen(function* () {
        const rawMessages = yield* ctx.session
          .context({ sessionID: input.sessionID })
          .pipe(Effect.catchCause(() => Effect.succeed([])))
        const current = yield* buildSessionSettings(input.sessionID)
        const turns: CompactableTurn[] = rawMessages.flatMap((msg): CompactableTurn[] => {
          if (msg.type === "user") {
            return [{ role: "user", content: msg.text }]
          }
          if (msg.type === "assistant") {
            const text = msg.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n")
            const reasoning = msg.content.flatMap((p) => (p.type === "reasoning" ? [p.text] : [])).join("\n\n")
            if (!text.trim() && !reasoning.trim()) return []
            return [{ role: "assistant", content: text, reasoning: reasoning || undefined }]
          }
          return []
        })

        const compacted = compactTurnsIntoMemory({
          turns,
          existingMemory: current.memory,
          keepLast: input.keepLast,
          customNote: input.note,
        })
        if (compacted.compacted && compacted.nextMemory.trim()) {
          yield* writeStr(sessionMemKey(input.sessionID), compacted.nextMemory.trim())
        }
        const nextSettings = yield* buildSessionSettings(input.sessionID)
        yield* emitChanged({ sessionID: input.sessionID, settings: nextSettings })
        return {
          compacted: compacted.compacted,
          compactedCount: compacted.compactedCount,
          tokensSaved: compacted.tokensSaved,
          summary: compacted.summaryBlock,
          settings: nextSettings,
        }
      })

    const rpc = yield* ctx.rpc
      .register(ABuCode.Definition, {
        catalog: () =>
          Effect.gen(function* () {
            const contentRoot = resolveContentRoot()
            const roster = getGeneralCharacters(contentRoot)
            const defaultCharacter = yield* getDefaultCharacter()
            const defaultPolicy = yield* getDefaultPolicy()
            const defaultSquad = yield* getDefaultSquad()
            return {
              characters: [...roster.characters],
              wildcards: [...roster.wildcards],
              defaultCharacter,
              defaultPolicy,
              defaultSquad,
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
        compactToMemory: (input) =>
          runSessionMemoryCompaction({
            sessionID: Session.ID.make(input.sessionID),
            keepLast: input.keepLast,
            note: input.note,
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
        setSquad: (input) =>
          Effect.gen(function* () {
            const norm = normalizeSquadSettings(input.squad)
            yield* writeStr(sessionSquadKey(input.sessionID), JSON.stringify(norm))
            if (input.saveAsDefault) {
              yield* writeStr(KEY_DEFAULT_SQUAD, JSON.stringify(norm))
            }
            const next = yield* buildSessionSettings(input.sessionID)
            const defaultSquad = yield* getDefaultSquad()
            yield* emitChanged({ sessionID: input.sessionID, settings: next, defaultSquad })
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

    // Track latest active model/provider per session so Squad & dispatch_subagent inherit them accurately
    const sessionActiveModels = new Map<
      string,
      { readonly provider: string; readonly model: string; readonly effort: string }
    >()
    const sessionReportStores = new Map<string, AgentReportStore>()
    const sessionAgentBudgets = new Map<string, TurnAgentBudget>()

    const getOrCreateReportStore = (sessionID: string): AgentReportStore => {
      const existing = sessionReportStores.get(sessionID)
      if (existing) return existing
      const created = new AgentReportStore()
      sessionReportStores.set(sessionID, created)
      return created
    }

    const getOrCreateAgentBudget = (sessionID: string, squad?: SquadSettings): TurnAgentBudget => {
      const existing = sessionAgentBudgets.get(sessionID)
      if (existing) return existing
      const cap =
        squad && /^\d+$/.test(squad.maxAgents) ? Number.parseInt(squad.maxAgents, 10) : undefined
      const created = new TurnAgentBudget(cap)
      sessionAgentBudgets.set(sessionID, created)
      return created
    }

    const extractMessageText = (msg: unknown): string => {
      if (typeof msg !== "object" || msg === null) return ""
      const rec = msg as { content?: unknown; text?: unknown }
      if (typeof rec.text === "string") return rec.text
      if (typeof rec.content === "string") return rec.content
      if (Array.isArray(rec.content)) {
        return rec.content
          .flatMap((part) => {
            if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
              return [part.text]
            }
            return []
          })
          .join("\n")
      }
      return ""
    }

    const injectContext = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        sessionActiveModels.set(event.sessionID, {
          provider: String(event.model.providerID),
          model: String(event.model.id),
          effort: event.model.variant ? String(event.model.variant) : "",
        })

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

        // Proactive Repo Tree & Smart File Pre-Injection before Round 1 hits the LLM
        const repoRoot = ctx.location.directory ?? process.cwd()
        const msgTexts = event.messages.map(extractMessageText).filter((t) => t.trim().length > 0)
        const latestUserText = msgTexts[msgTexts.length - 1] ?? ""
        const proactive = buildRepoContextBlock({
          repoRoot,
          userMessage: latestUserText,
          recentTexts: msgTexts.slice(-4),
          squadEnabled: Boolean(settings.squad?.enabled),
        })
        if (proactive.contextBlock.trim()) {
          parts.push(proactive.contextBlock.trim())
        }

        if (parts.length > 0) {
          event.system.splice(1, 0, SystemPart.make(parts.join("\n\n---\n\n")))
        }
      }).pipe(Effect.catchCause(() => Effect.void))

    yield* ctx.session.hook("context", injectContext)
    yield* ctx.session.hook("generate", injectContext)

    // Poe Title Thrift: deterministically generate session title locally when using Poe to save Poe points
    yield* ctx.session.hook("title", (event) =>
      Effect.sync(() => {
        if (String(event.model.providerID).toLowerCase() !== "poe") return
        const firstPrompt =
          event.messages.map(extractMessageText).find((t) => t.trim().length > 0) ?? "New ABuCode Chat"
        event.result = derivePoeSmartTitle(firstPrompt)
      }),
    )

    // Sync native OpenCode compaction directly into Pinned Session Memory
    yield* ctx.session.hook("compaction", (event) =>
      Effect.gen(function* () {
        if (event.result?.summary?.trim()) {
          const current = yield* buildSessionSettings(event.sessionID)
          const merged = appendCompactionSummaryToMemory(current.memory, event.result.summary)
          if (merged !== current.memory) {
            yield* writeStr(sessionMemKey(event.sessionID), merged)
            const next = yield* buildSessionSettings(event.sessionID)
            yield* emitChanged({ sessionID: event.sessionID, settings: next })
          }
          return
        }
        // Also snapshot pre-compaction turns into Pinned Session Memory so context survives compaction
        yield* runSessionMemoryCompaction({ sessionID: event.sessionID, keepLast: 4 })
      }).pipe(Effect.catchCause(() => Effect.void)),
    )

    // --- Security Bodyguards & Turn State ---
    const sessionToolRounds = new Map<string, number>()
    const sessionToolCeiling = new Map<string, number>()
    const DEFAULT_TOOL_ROUND_CEILING = 40
    const EXTRA_TOOL_ROUNDS_STEP = 10

    const clearSessionTurnState = (sessionID: string) => {
      sessionToolRounds.delete(sessionID)
      sessionToolCeiling.delete(sessionID)
      sessionAgentBudgets.delete(sessionID)
      sessionReportStores.delete(sessionID)
    }

    const normalizeLocationDir = (dir: string): string => {
      const resolved = path.resolve(dir)
      return process.platform === "win32" ? resolved.toLowerCase() : resolved
    }

    const archiveLiveSession = (sessionID: Session.ID, opts?: { readonly onlyCurrentLocation?: boolean }) =>
      Effect.gen(function* () {
        const info = yield* ctx.session.get({ sessionID })
        if (info.parentID || info.title === "Memory maintenance") return []

        const sessionCwd = info.location?.directory ?? ctx.location.directory ?? process.cwd()
        if (
          opts?.onlyCurrentLocation &&
          ctx.location.directory &&
          normalizeLocationDir(sessionCwd) !== normalizeLocationDir(ctx.location.directory)
        ) {
          return []
        }

        const rawMessages = yield* ctx.session.context({ sessionID })
        const settings = yield* buildSessionSettings(sessionID)
        const turns = coalesceSessionMessagesToTurns(rawMessages, settings.characterLabel, info.outcome)
        if (turns.length === 0) return []

        const lastTurnMs = turns.at(-1)?.timestampMs ?? 0
        const updatedMs = Math.max(DateTime.toEpochMillis(info.time.updated), lastTurnMs)

        return archiveSessionToChatHistory({
          id: String(info.id),
          title: info.title ?? "ABuCode Session",
          createdMs: DateTime.toEpochMillis(info.time.created),
          updatedMs,
          cwd: sessionCwd,
          character: settings.characterLabel,
          messages: turns,
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("abucode chat archive failed", { sessionID, cause }).pipe(Effect.as([] as string[])),
        ),
      )

    yield* ctx.session.hook("experimental.idle", (event) =>
      Effect.gen(function* () {
        clearSessionTurnState(event.sessionID)
        yield* archiveLiveSession(event.sessionID)
      }),
    )

    yield* ctx.event
      .subscribe({
        types: [
          "session.inbox.delivered",
          "session.step.ended",
          "session.step.failed",
          "session.execution.succeeded",
          "session.execution.interrupted",
          "session.execution.failed",
          "session.renamed",
          "session.compaction.ended",
          "session.revert.committed",
          "session.deleted",
        ],
      })
      .pipe(
        Stream.runForEach((event) => {
          const sid = event.data.sessionID
          if (event.type === "session.deleted") {
            return Effect.sync(() => removeSessionFromChatHistory(sid, ctx.location.directory ?? process.cwd()))
          }
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.interrupted" ||
            event.type === "session.execution.failed"
          ) {
            clearSessionTurnState(sid)
          }
          return archiveLiveSession(sid, { onlyCurrentLocation: true }).pipe(Effect.asVoid)
        }),
        Effect.forkScoped({ startImmediately: true }),
      )

    if (ctx.location.directory && !isInTempDir(ctx.location.directory)) {
      const locationDir = ctx.location.directory
      yield* Effect.gen(function* () {
        const page = yield* ctx.session.list({
          directory: AbsolutePath.make(locationDir),
          parentID: null,
          order: "desc",
          limit: 100,
        })
        const stale = page.data.filter(
          (item) =>
            item.title !== "Memory maintenance" &&
            !isSessionArchiveUpToDate(
              item.id,
              DateTime.toEpochMillis(item.time.updated),
              item.location?.directory ?? locationDir,
            ),
        )
        yield* Effect.forEach(stale, (item) => archiveLiveSession(item.id), { discard: true })
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("abucode startup chat archive sweep failed", { cause })),
        Effect.forkScoped,
      )
    }

    const notifyApprovalNeeded = (sessionID: string, title: string, detail: string) =>
      emitChanged({
        sessionID,
        approvalAlert: {
          sessionID,
          title,
          detail: detail.slice(0, 180),
        },
      })

    yield* ctx.shell.hook("create.before", (event) =>
      Effect.sync(() => {
        scrubEnvironmentInPlace(event.env)
        const cwd = ctx.location.directory ?? process.cwd()
        const catastrophic = classifyCatastrophicCommand(event.command)
        if (catastrophic) throw new Error(catastrophic)
        const stagedEnv = commandStagesSecretEnvFile(event.command, cwd)
        if (stagedEnv) throw new Error(stagedEnv)
      }),
    )

    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.action !== "shell") return
        const settings = yield* buildSessionSettings(event.sessionID)
        const combined = event.resources.join("\n")
        const cwd = ctx.location.directory ?? process.cwd()
        const decision = evaluateShellPolicyDecision(settings.policy, combined, event.effect, cwd)
        event.effect = decision.effect
        if (decision.message) event.message = decision.message
        if (decision.effect === "ask") {
          yield* notifyApprovalNeeded(
            event.sessionID,
            "⏸ Approve a command · ABuCode",
            decision.message ?? combined.slice(0, 120),
          )
        }
      }).pipe(Effect.catchCause(() => Effect.void)),
    )

    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const inputObj =
          typeof event.input === "object" && event.input !== null
            ? (event.input as Record<string, unknown>)
            : {}

        // 1. Protect .env*, .git/, and credential files across read, write, edit, patch, grep, and glob
        const isWriteTool = ["write", "edit", "patch"].includes(event.tool)
        const isReadOrSearchTool = ["read", "grep", "glob"].includes(event.tool)
        if (isWriteTool || isReadOrSearchTool) {
          const mode = isWriteTool ? "write" : event.tool === "read" ? "read" : "search"
          for (const field of ["filePath", "path", "target", "include", "pattern"]) {
            const val = inputObj[field]
            if (typeof val === "string" && val.trim()) {
              const reason = secretFileAccessReason(val.trim(), { mode })
              if (reason) return yield* Effect.fail(new Tool.Error({ message: reason }))
            }
          }
        }

        // 2. DNS-resolving SSRF, Cloud Metadata & Self-API shield on webfetch
        if (event.tool === "webfetch" && typeof inputObj.url === "string") {
          const rawUrl = inputObj.url
          const method = typeof inputObj.method === "string" ? inputObj.method : "GET"
          const blockReason = yield* Effect.promise(() =>
            validateResolvedFetchUrlGuard(rawUrl, {
              method,
              allowLoopbackGet: true,
              allowLocalGet: true,
            }),
          )
          if (blockReason) return yield* Effect.fail(new Tool.Error({ message: blockReason }))
        }

        // 3. Tool-round limit pause gate (+10 extra rounds confirmation)
        const nextCount = (sessionToolRounds.get(event.sessionID) ?? 0) + 1
        sessionToolRounds.set(event.sessionID, nextCount)
        const ceiling = sessionToolCeiling.get(event.sessionID) ?? DEFAULT_TOOL_ROUND_CEILING
        if (nextCount > ceiling) {
          const promptMsg = `Reached ${ceiling} tool calls in this turn — allow +${EXTRA_TOOL_ROUNDS_STEP} more rounds?`
          yield* notifyApprovalNeeded(event.sessionID, "⏸ Continue tool rounds? · ABuCode", promptMsg)
          yield* ctx.permission.assert({
            action: "tool-round-limit",
            resources: [promptMsg],
            sessionID: event.sessionID,
            agent: event.agent,
            source: { type: "tool", messageID: event.messageID, id: event.id },
          })
          sessionToolCeiling.set(event.sessionID, ceiling + EXTRA_TOOL_ROUNDS_STEP)
        }
      }),
    )

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.sync(() => {
        if (event.status !== "completed") return
        const content = event.result.content
        if (typeof content === "string") {
          event.result = { ...event.result, content: redactKnownSecrets(content) }
          return
        }
        if (Array.isArray(content)) {
          event.result = {
            ...event.result,
            content: content.map((part) =>
              part.type === "text" ? { ...part, text: redactKnownSecrets(part.text) } : part,
            ),
          }
        }
      }),
    )

    yield* ctx.tool.transform((tools) => {
      // 1. Upgraded 18-action playtest_url with port reuse, JS dialog capture, and 4-tier start_command policy
      tools.add({
        name: "playtest_url",
        description:
          "Launch headless Chromium/Edge/Chrome via Playwright against a local loopback server (localhost / 127.0.0.1 / [::1]), reusing an open port or starting start_command under the 4-tier shell policy, running 18 interactive UI step/assertion types, capturing JS dialogs/console/HTTP errors, and returning live vision screenshots.",
        input: PlaytestInput,
        output: PlaytestOutput,
        options: { codemode: false, permission: "playtest_url" },
        execute: (input, toolCtx) =>
          Effect.gen(function* () {
            const settings = yield* buildSessionSettings(toolCtx.sessionID)
            const startCmd = input.start_command?.trim() ?? ""
            if (startCmd) {
              const alreadyOpen = yield* Effect.promise(() => isPlaytestTargetPortOpen(input.url))
              if (!alreadyOpen) {
                const effectiveCwd = input.cwd || (ctx.location.directory ?? process.cwd())
                const decision = evaluateShellPolicyDecision(settings.policy, startCmd, "allow", effectiveCwd)
                if (decision.effect === "deny") {
                  return yield* Effect.fail(
                    new Tool.Error({ message: decision.message ?? "Blocked start_command by security policy." }),
                  )
                }
                if (decision.effect === "ask") {
                  yield* notifyApprovalNeeded(
                    toolCtx.sessionID,
                    "⏸ Approve playtest dev server · ABuCode",
                    `${decision.message ?? "Confirm starting dev server"}: ${startCmd}`,
                  )
                  yield* ctx.permission
                    .assert({
                      action: "shell",
                      resources: [startCmd],
                      sessionID: toolCtx.sessionID,
                      agent: toolCtx.agent,
                      source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new Tool.Error({
                            message: cause instanceof Error ? cause.message : String(cause),
                            error: cause,
                          }),
                      ),
                    )
                }
              }
            }

            return yield* Effect.tryPromise({
              try: () => runPlaytestUrl(input, { policyTier: settings.policy }),
              catch: (cause) =>
                new Tool.Error({
                  message: cause instanceof Error ? cause.message : String(cause),
                  error: cause,
                }),
            })
          }),
      })

      // 2. Squad Multi-Agent Orchestration: run_workflow (diagnose | review | design | map)
      tools.add({
        name: "run_workflow",
        description:
          "Run a MultiCode-style Squad multi-agent workflow ('diagnose', 'review', 'design', or 'map') with optional Scout reconnaissance and 1..6 parallel Investigator/Reviewer + adversarial Skeptic verification lanes routed across Venice, NanoGPT, and Poe.",
        input: RunWorkflowInput,
        output: RunWorkflowOutput,
        options: { codemode: false, permission: "run_workflow" },
        execute: (input, toolCtx) =>
          Effect.gen(function* () {
            const settings = yield* buildSessionSettings(toolCtx.sessionID)
            const squadCfg = normalizeSquadSettings(settings.squad)
            const activeModel = sessionActiveModels.get(toolCtx.sessionID) ?? {
              provider: "venice",
              model: "gemini-4-argon",
              effort: "high",
            }
            const repoRoot = ctx.location.directory ?? process.cwd()
            const budget = getOrCreateAgentBudget(toolCtx.sessionID, squadCfg)
            const reportStore = getOrCreateReportStore(toolCtx.sessionID)

            const plan = yield* Effect.try({
              try: () =>
                compileSquadWorkflow(input, {
                  repo: repoRoot,
                  mainProvider: activeModel.provider,
                  mainModel: activeModel.model,
                  mainEffort: activeModel.effort,
                  squadSettings: squadCfg,
                  budget,
                }),
              catch: (err) =>
                new Tool.Error({
                  message: err instanceof Error ? err.message : String(err),
                  error: err,
                }),
            })

            // Enforce USD Cost Approval Gate when estimated workflow cost exceeds threshold
            if (plan.estimatedCostUsd > squadCfg.costThresholdUsd) {
              const costMsg = `Squad workflow '${plan.workflowId}' (${plan.template}, ${plan.scouts.length + plan.lanes.length * 2} agents) is estimated at ~$${plan.estimatedCostUsd.toFixed(2)} USD (threshold: $${squadCfg.costThresholdUsd.toFixed(2)}). Launch workflow?`
              yield* notifyApprovalNeeded(
                toolCtx.sessionID,
                "💰 Approve Squad workflow cost? · ABuCode",
                costMsg,
              )
              yield* ctx.permission
                .assert({
                  action: "squad-cost-gate",
                  resources: [costMsg],
                  sessionID: toolCtx.sessionID,
                  agent: toolCtx.agent,
                  source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new Tool.Error({
                        message: cause instanceof Error ? cause.message : String(cause),
                        error: cause,
                      }),
                  ),
                )
            }

            const executed = yield* Effect.tryPromise({
              try: () => executeSquadWorkflow(plan, reportStore),
              catch: (err) =>
                new Tool.Error({
                  message: err instanceof Error ? err.message : String(err),
                  error: err,
                }),
            })

            const output: RunWorkflowOutput = {
              workflowId: plan.workflowId,
              template: plan.template,
              totalAgentsRun: executed.totalAgentsRun,
              estimatedCostUsd: plan.estimatedCostUsd,
              digest: executed.digest,
            }
            return {
              output,
              content: [{ type: "text", text: executed.digest }],
            }
          }),
      })

      // 3. Squad Agent Report Drill-Down: get_agent_report
      tools.add({
        name: "get_agent_report",
        description:
          "Retrieve the full structured verdict, cited file/line evidence, tools called, and complete report of a Squad or Household subagent by ID from the current turn.",
        input: GetAgentReportInput,
        output: GetAgentReportOutput,
        options: { codemode: false },
        execute: (input, toolCtx) =>
          Effect.sync(() => {
            const store = getOrCreateReportStore(toolCtx.sessionID)
            const found = store.get(input.id)
            if (!found) {
              const msg = `No agent report found for id='${input.id}' in this session turn.`
              return {
                output: { found: false, id: input.id, report: msg },
                content: [{ type: "text", text: msg }],
              }
            }
            const lines = [
              `## Agent Report: \`${found.id}\` (${found.role.toUpperCase()} · ${found.character})`,
              `- **Status:** ${found.status} · **Model:** \`${found.provider}/${found.model}\` · **Tokens:** ${found.tokensUsed} (~$${found.estCostUsd.toFixed(4)})`,
              `- **Task:** ${found.task}`,
              ...(found.toolsCalled.length > 0 ? [`- **Tools (${found.toolsCalled.length}):** ${found.toolsCalled.join(", ")}`] : []),
              ...(found.verdict ? ["", "### Structured Verdict", "```json", JSON.stringify(found.verdict, null, 2), "```"] : []),
              ...(found.fullText ? ["", "### Full Text Output", found.fullText] : []),
            ]
            const report = lines.join("\n")
            return {
              output: { found: true, id: found.id, report },
              content: [{ type: "text", text: report }],
            }
          }),
      })

      // 4. Household-Embodied Parallel Subagents: dispatch_subagent
      tools.add({
        name: "dispatch_subagent",
        description:
          "Delegate up to 4 parallel read-only codebase research subtasks embodied by Household 343 personas (e.g. 'Cordelia', '2B', 'Rosalind', 'Cortana') without bloating the main context window.",
        input: DispatchSubagentInput,
        output: DispatchSubagentOutput,
        options: { codemode: false },
        execute: (input, toolCtx) =>
          Effect.gen(function* () {
            const settings = yield* buildSessionSettings(toolCtx.sessionID)
            const activeModel = sessionActiveModels.get(toolCtx.sessionID) ?? {
              provider: "venice",
              model: "gemini-4-argon",
              effort: "high",
            }
            const repoRoot = ctx.location.directory ?? process.cwd()
            const budget = getOrCreateAgentBudget(toolCtx.sessionID, settings.squad)
            const reportStore = getOrCreateReportStore(toolCtx.sessionID)

            const res = yield* Effect.tryPromise({
              try: () =>
                runHouseholdSubagents(input, {
                  repo: repoRoot,
                  provider: activeModel.provider,
                  model: activeModel.model,
                  effort: activeModel.effort,
                  defaultCharacter: settings.character,
                  budget,
                  reportStore,
                }),
              catch: (err) =>
                new Tool.Error({
                  message: err instanceof Error ? err.message : String(err),
                  error: err,
                }),
            })

            return {
              output: { count: res.count, report: res.report },
              content: [{ type: "text", text: res.report }],
            }
          }),
      })
    })

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
        name: "squad",
        description: "toggle Squad multi-agent workflows & per-role subscription routing (/squad [on|off|status|max|cost|route])",
        execute: (input) =>
          Effect.gen(function* () {
            const raw = input.prompt.text.trim()
            const current = yield* buildSessionSettings(input.sessionID)
            const sq = normalizeSquadSettings(current.squad)

            if (!raw || raw.toLowerCase() === "status") {
              const roleLines = SQUAD_ROLES.map((role) => {
                const r = sq.roles[role]
                return `  ${role.padEnd(13)}: count=${r.count}, provider=${r.provider}, model=${r.model}, effort=${r.effort}`
              }).join("\n")
              return yield* Effect.fail(
                new Error(
                  [
                    `Squad Orchestration: ${sq.enabled ? "ON" : "OFF"} (maxAgents=${sq.maxAgents}, costGate=$${sq.costThresholdUsd.toFixed(2)})`,
                    "Per-Role Routing:",
                    roleLines,
                    "",
                    SQUAD_USAGE,
                  ].join("\n"),
                ),
              )
            }

            const tokens = raw.split(/\s+/)
            const sub = (tokens[0] ?? "").toLowerCase()
            let updated: SquadSettings | undefined

            if (sub === "on" || sub === "enable") {
              updated = { ...sq, enabled: true }
            } else if (sub === "off" || sub === "disable") {
              updated = { ...sq, enabled: false }
            } else if (sub === "reset") {
              updated = DEFAULT_SQUAD_SETTINGS
            } else if (sub === "max" && tokens[1]) {
              updated = normalizeSquadSettings({ ...sq, maxAgents: tokens[1] })
            } else if (sub === "cost" && tokens[1]) {
              updated = normalizeSquadSettings({ ...sq, costThresholdUsd: Number(tokens[1]) })
            } else if (sub === "route" && tokens[1] && tokens[2]) {
              const role = tokens[1].toLowerCase() as SquadRoleName
              if (!SQUAD_ROLES.includes(role)) {
                return yield* Effect.fail(new Error(`Invalid Squad role '${tokens[1]}'. Choose: ${SQUAD_ROLES.join(", ")}`))
              }
              const provider = tokens[2].toLowerCase()
              const model = tokens[3] ?? sq.roles[role].model
              const effort = tokens[4] ?? sq.roles[role].effort
              updated = normalizeSquadSettings({
                ...sq,
                roles: {
                  ...sq.roles,
                  [role]: { ...sq.roles[role], provider, model, effort },
                },
              })
            }

            if (!updated) {
              return yield* Effect.fail(new Error(SQUAD_USAGE))
            }

            yield* writeStr(sessionSquadKey(input.sessionID), JSON.stringify(updated))
            yield* writeStr(KEY_DEFAULT_SQUAD, JSON.stringify(updated))
            const next = yield* buildSessionSettings(input.sessionID)
            const defaultSquad = yield* getDefaultSquad()
            yield* emitChanged({ sessionID: input.sessionID, settings: next, defaultSquad })
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Updated **Squad** settings: enabled=**${updated.enabled ? "ON" : "OFF"}**, maxAgents=**${updated.maxAgents}**, costGate=**$${updated.costThresholdUsd.toFixed(2)}**.`,
              description: `Squad -> ${updated.enabled ? "ON" : "OFF"}`,
              metadata: { source: "abucode.squad" },
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

      editor.add({
        name: "memory",
        description: "view, set, clear, or compact into Pinned Session Memory (/memory [show | clear | compact [keep] [note] | <notes>])",
        execute: (input) =>
          Effect.gen(function* () {
            const raw = input.prompt.text.trim()
            const current = yield* buildSessionSettings(input.sessionID)
            if (!raw || raw.toLowerCase() === "show") {
              return yield* Effect.fail(
                new Error(
                  current.memory.trim()
                    ? `Pinned Session Memory:\n\n${current.memory}\n\nUse '/memory compact' to summarize older turns into memory, '/memory clear' to clear, or '/memory <notes>' to update.`
                    : "No Pinned Session Memory set. Use '/memory <notes>' or '/memory compact' to pin context for every turn in this chat.",
                ),
              )
            }
            if (raw.toLowerCase() === "clear") {
              yield* removeKey(sessionMemKey(input.sessionID))
              const next = yield* buildSessionSettings(input.sessionID)
              yield* emitChanged({ sessionID: input.sessionID, settings: next })
              yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text: "Cleared Pinned Session Memory.",
                description: "Pinned Memory cleared",
                metadata: { source: "abucode.memory" },
                delivery: input.delivery,
              })
              return
            }
            if (raw.toLowerCase() === "compact" || raw.toLowerCase().startsWith("compact ")) {
              const tail = raw.slice("compact".length).trim()
              const firstSpace = tail.indexOf(" ")
              const firstTok = firstSpace === -1 ? tail : tail.slice(0, firstSpace)
              const hasKeepInt = /^\d+$/.test(firstTok)
              const keepLast = hasKeepInt ? Number.parseInt(firstTok, 10) : 4
              const note = hasKeepInt ? (firstSpace === -1 ? "" : tail.slice(firstSpace + 1).trim()) : tail
              const res = yield* runSessionMemoryCompaction({
                sessionID: input.sessionID,
                keepLast,
                note,
              })
              if (!res.compacted) {
                return yield* Effect.fail(new Error("Need at least 2 messages in this session before compacting into memory."))
              }
              yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `🗜️ Compacted **${res.compactedCount}** earlier messages (~**${res.tokensSaved} tok** saved) into **Pinned Session Memory**.`,
                description: `Compacted ${res.compactedCount} msgs -> Memory`,
                metadata: { source: "abucode.memory.compact" },
                delivery: input.delivery,
              })
              return
            }
            yield* writeStr(sessionMemKey(input.sessionID), raw)
            const next = yield* buildSessionSettings(input.sessionID)
            yield* emitChanged({ sessionID: input.sessionID, settings: next })
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Updated Pinned Session Memory (${raw.length} chars).`,
              description: "Pinned Memory updated",
              metadata: { source: "abucode.memory" },
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })

      editor.add({
        name: "archive",
        description: "write this session's GMT+8 Markdown transcript to zzz_local/Chat-History now",
        execute: (input) =>
          Effect.gen(function* () {
            const written = yield* archiveLiveSession(input.sessionID)
            if (written.length === 0) {
              return yield* Effect.fail(
                new Error("No zzz_local/Chat-History directory found (or session has no turns yet)."),
              )
            }
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Archived session Markdown to:\n${written.map((p) => `- \`${p}\``).join("\n")}`,
              description: `Archived to Chat-History (${written.length} target${written.length === 1 ? "" : "s"})`,
              metadata: { source: "abucode.archive" },
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })

      editor.add({
        name: "policy",
        description: "switch command approval policy (/policy [request_review | default | auto | turbo])",
        execute: (input) =>
          Effect.gen(function* () {
            const raw = input.prompt.text.trim().toLowerCase()
            const current = yield* buildSessionSettings(input.sessionID)
            if (!raw) {
              return yield* Effect.fail(
                new Error(
                  `Active approval policy: ${current.policy}\nUsage: /policy <request_review | default | auto | turbo>`,
                ),
              )
            }
            if (!["request_review", "review", "default", "auto", "turbo"].includes(raw)) {
              return yield* Effect.fail(
                new Error("Invalid policy. Choose one of: request_review, default, auto, turbo"),
              )
            }
            const tier = normalizePolicyTier(raw)
            yield* writeStr(sessionPolicyKey(input.sessionID), tier)
            yield* writeStr(KEY_DEFAULT_POLICY, tier)
            const next = yield* buildSessionSettings(input.sessionID)
            const defaultPolicy = yield* getDefaultPolicy()
            yield* emitChanged({ sessionID: input.sessionID, settings: next, defaultPolicy })
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Switched command approval policy to **${tier}**.`,
              description: `Approval policy -> ${tier}`,
              metadata: { source: "abucode.policy", policy: tier },
              delivery: input.delivery,
            })
          }).pipe(Effect.asVoid),
      })
    })
  }),
})

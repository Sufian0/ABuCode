import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  ComposerPill,
  createKeyed,
  SettingsPage,
  type ComposerPillMenuProps,
  type ComposerPillProps,
  type Plugin,
} from "@opencode/plugin/gui"
import {
  ABuCode,
  type CharacterEntry,
  type PolicyTier,
  type ProviderKeyInfo,
  type SessionSettings,
} from "@opencode/schema/abucode"
import { Button } from "@opencode/ui/button"
import { showToast } from "@opencode/ui/toast"
import type ABuCodeDefinition from "./index"

const POLICY_LABELS: Record<PolicyTier, string> = {
  request_review: "Review",
  default: "Default",
  auto: "Auto",
  turbo: "Turbo",
}

const setup: Plugin.Setup<typeof ABuCodeDefinition> = (ctx) => {
  const [sessions, setSessions] = createStore<Record<string, SessionSettings | undefined>>({})
  const [catalogByServer, setCatalogByServer] = createStore<
    Record<string, { characters: readonly CharacterEntry[]; wildcards: readonly CharacterEntry[] } | undefined>
  >({})

  const sessionKey = (serverID: string, sessionID: string) => `${serverID}\u0000${sessionID}`
  const readSession = (input: ComposerPillProps) => sessions[sessionKey(input.session.server.id, input.session.id)]

  // Sync active session settings and catalog with the ABuCode server plugin over RPC.
  createKeyed(
    () => {
      const current = ctx.sessions.current()
      return current?.server.connected ? `${current.server.id}\u0000${current.id}\u0000${current.directory}` : undefined
    },
    () => {
      const current = ctx.sessions.current()
      if (!current) return

      const serverID = current.server.id
      const rpc = current.server.client.rpc(ABuCode.Definition)
      const controller = new AbortController()
      const heard = { value: false }
      onCleanup(() => controller.abort())

      onCleanup(
        rpc.events.on(
          "changed",
          (event) => {
            if (event.data.sessionID && event.data.settings) {
              if (event.data.sessionID === current.id) heard.value = true
              setSessions(sessionKey(serverID, event.data.sessionID), event.data.settings)
            }
          },
          { signal: controller.signal },
        ),
      )

      void rpc
        .getSession(
          { sessionID: current.id },
          { location: { directory: current.directory }, signal: controller.signal },
        )
        .then(
          (next) => {
            if (!controller.signal.aborted && !heard.value) {
              setSessions(sessionKey(serverID, current.id), next)
            }
          },
          () => undefined,
        )

      if (!catalogByServer[serverID]) {
        void rpc.catalog({}, { location: { directory: current.directory }, signal: controller.signal }).then(
          (cat) => {
            if (!controller.signal.aborted) {
              setCatalogByServer(serverID, { characters: cat.characters, wildcards: cat.wildcards })
            }
          },
          () => undefined,
        )
      }
    },
  )

  const reportError = (cause: unknown) =>
    showToast({
      variant: "error",
      title: ctx.t("requestFailed"),
      description: cause instanceof Error ? cause.message : String(cause),
    })

  const updateCharacter = (input: ComposerPillMenuProps, character: string, saveAsDefault = false) => {
    const serverID = input.session.server.id
    const sid = input.session.id
    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setCharacter({ sessionID: sid, character, saveAsDefault }, { location: { directory: input.session.directory } })
      .then((next) => {
        setSessions(sessionKey(serverID, sid), next)
        input.close()
      })
      .catch(reportError)
  }

  const updateMemory = (input: ComposerPillMenuProps, memory: string) => {
    const serverID = input.session.server.id
    const sid = input.session.id
    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setMemory({ sessionID: sid, memory }, { location: { directory: input.session.directory } })
      .then((next) => {
        setSessions(sessionKey(serverID, sid), next)
        input.close()
      })
      .catch(reportError)
  }

  const updatePolicy = (input: ComposerPillProps, policy: PolicyTier, saveAsDefault = true) => {
    const serverID = input.session.server.id
    const sid = input.session.id
    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setPolicy({ sessionID: sid, policy, saveAsDefault }, { location: { directory: input.session.directory } })
      .then((next) => {
        setSessions(sessionKey(serverID, sid), next)
      })
      .catch(reportError)
  }

  // 1. Household 343 + "No Character" Vanilla Pill
  ctx.add(ComposerPill, {
    id: "character",
    order: -30,
    show: (input) => {
      const current = readSession(input)
      const label = current?.characterLabel ?? ctx.t("defaultCortana")
      const vanilla = current?.character === "none"
      return {
        label,
        icon: vanilla ? "code" : "bubble-5",
        tone: vanilla ? undefined : "success",
        title: ctx.t("personaTitle"),
      }
    },
    menu: (input) => {
      const [query, setQuery] = createSignal(readSession(input)?.character ?? "default")
      const [wildDesc, setWildDesc] = createSignal("")
      const catalog = createMemo(() => catalogByServer[input.session.server.id])
      const filtered = createMemo(() => {
        const list = catalog()?.characters ?? []
        const q = query().trim().toLowerCase()
        if (!q || q === "default" || q === "none" || q === "random") return list.slice(0, 40)
        return list
          .filter((item) => item.key.toLowerCase().includes(q) || item.display.toLowerCase().includes(q))
          .slice(0, 40)
      })
      const isWildSlot = createMemo(() => /^other(?:10|[1-9])$/i.test(query().trim()))
      const composedValue = () => {
        const raw = query().trim()
        const desc = wildDesc().trim()
        return isWildSlot() && desc ? `${raw} {${desc}}` : raw || "default"
      }

      return (
        <div class="flex flex-col gap-2 p-1 min-w-[290px] max-w-[360px]">
          <div class="flex flex-wrap gap-1">
            <Button size="small" variant="ghost" icon="code" onClick={() => updateCharacter(input, "none")}>
              {ctx.t("noCharacter")}
            </Button>
            <Button size="small" variant="ghost" icon="bubble-5" onClick={() => updateCharacter(input, "default")}>
              {ctx.t("defaultCortana")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => updateCharacter(input, "random")}>
              {ctx.t("randomCharacter")}
            </Button>
          </div>

          <input
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={ctx.t("filterPlaceholder")}
            class="w-full rounded px-2 py-1 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none"
          />

          <Show when={isWildSlot()}>
            <input
              type="text"
              value={wildDesc()}
              onInput={(e) => setWildDesc(e.currentTarget.value)}
              placeholder={ctx.t("wildcardPlaceholder")}
              class="w-full rounded px-2 py-1 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none"
            />
          </Show>

          <div class="max-h-[160px] overflow-y-auto flex flex-col gap-0.5 border border-v2-border-subtle rounded p-1">
            <For each={filtered()}>
              {(item) => (
                <button
                  type="button"
                  onClick={() => updateCharacter(input, item.key)}
                  class="text-left px-2 py-1 rounded text-[12px] hover:bg-v2-background-bg-subtle text-v2-text-primary truncate"
                >
                  {item.display}
                </button>
              )}
            </For>
            <For each={catalog()?.wildcards ?? []}>
              {(wild) => (
                <button
                  type="button"
                  onClick={() => setQuery(wild.key)}
                  class="text-left px-2 py-1 rounded text-[12px] hover:bg-v2-background-bg-subtle text-v2-text-secondary truncate"
                >
                  {wild.display} (Wildcard)
                </button>
              )}
            </For>
          </div>

          <div class="flex justify-end gap-1 pt-1">
            <Button size="small" variant="ghost" onClick={() => updateCharacter(input, composedValue(), true)}>
              {ctx.t("saveGlobal")}
            </Button>
            <Button size="small" variant="submit" onClick={() => updateCharacter(input, composedValue(), false)}>
              {ctx.t("applyChat")}
            </Button>
          </div>
        </div>
      )
    },
  })

  // 2. Pinned Session Memory Pill
  ctx.add(ComposerPill, {
    id: "memory",
    order: -20,
    show: (input) => {
      const hasMem = Boolean(readSession(input)?.memory.trim())
      return {
        label: hasMem ? ctx.t("memoryActive") : ctx.t("memoryEmpty"),
        icon: "brain",
        tone: hasMem ? "success" : undefined,
        title: ctx.t("memoryTitle"),
      }
    },
    menu: (input) => {
      const [draft, setDraft] = createSignal(readSession(input)?.memory ?? "")
      return (
        <div class="flex flex-col gap-2 p-1 min-w-[300px]">
          <textarea
            rows={5}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            placeholder={ctx.t("memoryPlaceholder")}
            class="w-full rounded p-2 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none resize-y"
          />
          <div class="flex justify-end gap-1">
            <Button size="small" variant="ghost" onClick={() => updateMemory(input, "")}>
              {ctx.t("clearMemory")}
            </Button>
            <Button size="small" variant="submit" onClick={() => updateMemory(input, draft())}>
              {ctx.t("saveMemory")}
            </Button>
          </div>
        </div>
      )
    },
  })

  // 3. 4-Tier Command Approval Policy Quick-Switcher Pill
  ctx.add(ComposerPill, {
    id: "policy",
    order: -10,
    show: (input) => {
      const tier = readSession(input)?.policy ?? "default"
      const tone = tier === "turbo" ? "warning" : tier === "request_review" ? "success" : undefined
      return {
        label: `Policy: ${POLICY_LABELS[tier]}`,
        icon: "lock",
        tone,
        title: ctx.t("policyTitle"),
        rows: [
          {
            id: "request_review",
            label: ctx.t("policyReview"),
            icon: tier === "request_review" ? "check" : undefined,
            run: () => updatePolicy(input, "request_review"),
          },
          {
            id: "default",
            label: ctx.t("policyDefault"),
            icon: tier === "default" ? "check" : undefined,
            run: () => updatePolicy(input, "default"),
          },
          {
            id: "auto",
            label: ctx.t("policyAuto"),
            icon: tier === "auto" ? "check" : undefined,
            run: () => updatePolicy(input, "auto"),
          },
          {
            id: "turbo",
            label: ctx.t("policyTurbo"),
            icon: tier === "turbo" ? "check" : undefined,
            tone: "warning",
            run: () => updatePolicy(input, "turbo"),
          },
        ],
      }
    },
  })

  // 4. ABuCode Settings Page (.env.local Provider Vault & Connection Latency Tester)
  ctx.add(SettingsPage, {
    id: "abucode",
    get title() {
      return ctx.t("settingsTitle")
    },
    icon: "models",
    render: () => {
      const [keyStatuses, setKeyStatuses] = createSignal<readonly ProviderKeyInfo[]>([])
      const [draftKeys, setDraftKeys] = createStore<Record<string, string>>({})
      const [testOutput, setTestOutput] = createSignal("")

      const activeServer = () => ctx.sessions.current()?.server
      createKeyed(
        () => activeServer()?.connected ? activeServer()?.id : undefined,
        () => {
          const srv = activeServer()
          if (!srv) return
          void srv.client
            .rpc(ABuCode.Definition)
            .getKeys({})
            .then((rows) => setKeyStatuses(rows), () => undefined)
        },
      )

      const onSaveKeys = () => {
        const srv = activeServer()
        if (!srv) return
        void srv.client
          .rpc(ABuCode.Definition)
          .saveKeys({ keys: { ...draftKeys } })
          .then((rows) => {
            setKeyStatuses(rows)
            setDraftKeys({ venice: "", "nano-gpt": "", poe: "", runpod: "" })
            showToast({ variant: "success", title: ctx.t("keysSaved") })
          })
          .catch(reportError)
      }

      const onTestProvider = (providerID: string) => {
        const srv = activeServer()
        if (!srv) return
        setTestOutput(`Testing ${providerID}...`)
        void srv.client
          .rpc(ABuCode.Definition)
          .testProvider({ provider: providerID })
          .then((res) => {
            setTestOutput(res.ok ? `✓ ${res.message ?? providerID}` : `✗ ${res.error ?? "Failed"}`)
          })
          .catch((err: unknown) => {
            setTestOutput(`✗ ${err instanceof Error ? err.message : String(err)}`)
          })
      }

      return (
        <div class="flex flex-col gap-4 p-4 max-w-[680px]">
          <div class="flex flex-col gap-1">
            <h3 class="text-[14px] font-semibold text-v2-text-primary">{ctx.t("keysHeading")}</h3>
            <p class="text-[12px] text-v2-text-secondary">{ctx.t("keysSub")}</p>
          </div>

          <div class="flex flex-col gap-3 rounded-lg border border-v2-border-subtle p-3">
            <For each={keyStatuses()}>
              {(prov) => (
                <div class="flex flex-col gap-1">
                  <div class="flex items-center justify-between text-[12px]">
                    <span class="font-medium text-v2-text-primary">
                      {prov.name} ({prov.envKey})
                    </span>
                    <div class="flex items-center gap-2">
                      <span class="text-v2-text-secondary">
                        {prov.hasKey ? `Ready (${prov.maskedKey})` : "Not configured"}
                      </span>
                      <Show when={prov.id !== "runpod"}>
                        <Button size="small" variant="ghost" onClick={() => onTestProvider(prov.id)}>
                          {ctx.t("testBtn")}
                        </Button>
                      </Show>
                    </div>
                  </div>
                  <input
                    type="password"
                    value={draftKeys[prov.id] ?? ""}
                    onInput={(e) => setDraftKeys(prov.id, e.currentTarget.value)}
                    placeholder={`Enter new ${prov.name} API key or leave blank`}
                    class="w-full rounded px-2.5 py-1.5 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none"
                  />
                </div>
              )}
            </For>

            <div class="flex items-center justify-between pt-2">
              <span class="text-[12px] text-v2-text-secondary">{testOutput()}</span>
              <Button size="small" variant="submit" onClick={onSaveKeys}>
                {ctx.t("saveKeysBtn")}
              </Button>
            </div>
          </div>
        </div>
      )
    },
  })
}

export default setup

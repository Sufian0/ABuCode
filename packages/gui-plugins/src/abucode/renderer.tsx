import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  ComposerPill,
  createKeyed,
  SettingsPage,
  Style,
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
import { DesktopSummon, type HotkeyPreset, type SummonState } from "./contract"
import type ABuCodeDefinition from "./index"
import type { BubblePreset, ChatWidth } from "./index"
import styleCss from "./style.css?inline"

const POLICY_LABELS: Record<PolicyTier, string> = {
  request_review: "Review",
  default: "Default",
  auto: "Auto",
  turbo: "Turbo",
}

const BUBBLE_PRESETS: Record<
  Exclude<BubblePreset, "theme" | "custom">,
  { promptBg: string; responseBg: string; thinkingBg: string }
> = {
  multicode: { promptBg: "#8B5A3C", responseBg: "#E8E0D0", thinkingBg: "#EFE7DA" },
  "poe-indigo": { promptBg: "#5B4CE6", responseBg: "#F3F4F6", thinkingBg: "#EDE9FE" },
  "antigravity-blue": { promptBg: "#2563EB", responseBg: "#F8FAFC", thinkingBg: "#EFF6FF" },
}

const HOTKEY_OPTIONS: readonly { value: HotkeyPreset; label: string }[] = [
  { value: "Alt+Space", label: "Alt+Space (Default)" },
  { value: "CommandOrControl+Shift+Space", label: "Ctrl/Cmd+Shift+Space" },
  { value: "CommandOrControl+Alt+M", label: "Ctrl/Cmd+Alt+M" },
  { value: "Alt+Shift+M", label: "Alt+Shift+M" },
  { value: "None", label: "None (Disabled)" },
]

function contrastTextForHex(hex: string): string {
  const clean = hex.replace("#", "")
  if (clean.length !== 6) return "#ffffff"
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.62 ? "#1f1d1a" : "#ffffff"
}

const setup: Plugin.Setup<typeof ABuCodeDefinition> = (ctx) => {
  ctx.add(Style, styleCss)

  const appearance = ctx.stores.appearance

  // Sync bubble custom properties and conversation width attributes onto :root.
  createKeyed(
    () => {
      const v = appearance.value
      return `${v.preset}|${v.promptBg}|${v.responseBg}|${v.thinkingBg}|${v.width}`
    },
    () => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const v = appearance.value
      if (v.preset === "theme") {
        root.removeAttribute("data-abucode-bubbles")
      } else {
        root.setAttribute("data-abucode-bubbles", "active")
        root.style.setProperty("--abucode-prompt-bg", v.promptBg)
        root.style.setProperty("--abucode-prompt-fg", contrastTextForHex(v.promptBg))
        root.style.setProperty("--abucode-response-bg", v.responseBg)
        root.style.setProperty("--abucode-response-fg", contrastTextForHex(v.responseBg))
        root.style.setProperty("--abucode-thinking-bg", v.thinkingBg)
      }
      if (v.width === "default") {
        root.removeAttribute("data-abucode-width")
      } else {
        root.setAttribute("data-abucode-width", v.width)
      }
    },
  )

  onCleanup(() => {
    if (typeof document === "undefined") return
    document.documentElement.removeAttribute("data-abucode-bubbles")
    document.documentElement.removeAttribute("data-abucode-width")
  })

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

  // 4. ABuCode Settings Page (.env.local Vault, Bubble Color Pickers, Width Presets & Desktop Summon)
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
      const [summonState, setSummonState] = createSignal<SummonState | undefined>(undefined)

      const summonIpc = ctx.app.platform === "desktop" ? ctx.main(DesktopSummon) : undefined

      const activeServer = () => ctx.sessions.current()?.server
      createKeyed(
        () => (activeServer()?.connected ? activeServer()?.id : undefined),
        () => {
          const srv = activeServer()
          if (!srv) return
          void srv.client
            .rpc(ABuCode.Definition)
            .getKeys({})
            .then((rows) => setKeyStatuses(rows), () => undefined)
        },
      )

      // Load Desktop Summon IPC state when running inside the Electron shell.
      createKeyed(
        () => (summonIpc ? "desktop" : undefined),
        () => {
          if (!summonIpc) return
          void summonIpc.getState({ signal: ctx.signal }).then(
            (st) => {
              if (!ctx.signal.aborted) setSummonState(st)
            },
            () => undefined,
          )
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

      const applyPreset = (preset: BubblePreset) => {
        if (preset === "theme" || preset === "custom") {
          appearance.update((draft) => {
            draft.preset = preset
          })
          return
        }
        const colors = BUBBLE_PRESETS[preset]
        appearance.update((draft) => {
          draft.preset = preset
          draft.promptBg = colors.promptBg
          draft.responseBg = colors.responseBg
          draft.thinkingBg = colors.thinkingBg
        })
      }

      const setCustomColor = (field: "promptBg" | "responseBg" | "thinkingBg", hex: string) => {
        if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return
        appearance.update((draft) => {
          draft.preset = "custom"
          draft[field] = hex
        })
      }

      const setWidth = (width: ChatWidth) => {
        appearance.update((draft) => {
          draft.width = width
        })
      }

      return (
        <div class="flex flex-col gap-6 p-4 max-w-[700px]">
          {/* Section 1: Provider API Keys */}
          <div class="flex flex-col gap-2">
            <div class="flex flex-col gap-0.5">
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

          {/* Section 2: Per-Bubble Appearance & Conversation Width */}
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <div class="flex flex-col gap-0.5">
                <h3 class="text-[14px] font-semibold text-v2-text-primary">{ctx.t("bubblesHeading")}</h3>
                <p class="text-[12px] text-v2-text-secondary">{ctx.t("bubblesSub")}</p>
              </div>
              <Button size="small" variant="ghost" onClick={() => applyPreset("theme")}>
                {ctx.t("resetThemeBtn")}
              </Button>
            </div>

            <div class="flex flex-col gap-3 rounded-lg border border-v2-border-subtle p-3 text-[12px]">
              <div class="flex items-center justify-between">
                <span class="font-medium text-v2-text-primary">Bubble Style Preset</span>
                <select
                  value={appearance.value.preset}
                  onChange={(e) => applyPreset(e.currentTarget.value as BubblePreset)}
                  class="rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
                >
                  <option value="theme">Match Theme (Default)</option>
                  <option value="multicode">MultiCode Classic</option>
                  <option value="poe-indigo">Poe Indigo &amp; Gray</option>
                  <option value="antigravity-blue">Antigravity Clean</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              <div class="grid grid-cols-3 gap-2">
                <label class="flex flex-col gap-1">
                  <span class="text-v2-text-secondary">Prompt (Input)</span>
                  <div class="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={appearance.value.promptBg}
                      onInput={(e) => setCustomColor("promptBg", e.currentTarget.value)}
                    />
                    <span class="font-mono">{appearance.value.promptBg}</span>
                  </div>
                </label>

                <label class="flex flex-col gap-1">
                  <span class="text-v2-text-secondary">Response (Output)</span>
                  <div class="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={appearance.value.responseBg}
                      onInput={(e) => setCustomColor("responseBg", e.currentTarget.value)}
                    />
                    <span class="font-mono">{appearance.value.responseBg}</span>
                  </div>
                </label>

                <label class="flex flex-col gap-1">
                  <span class="text-v2-text-secondary">Thinking Trace</span>
                  <div class="flex items-center gap-1.5">
                    <input
                      type="color"
                      value={appearance.value.thinkingBg}
                      onInput={(e) => setCustomColor("thinkingBg", e.currentTarget.value)}
                    />
                    <span class="font-mono">{appearance.value.thinkingBg}</span>
                  </div>
                </label>
              </div>

              {/* Live Mini Chat Bubble Preview */}
              <div class="flex flex-col gap-2 rounded p-2.5 border border-v2-border-subtle bg-v2-background-bg-base">
                <div class="flex justify-end">
                  <div
                    class="rounded-lg px-2.5 py-1.5 text-[11px] font-medium"
                    style={{
                      "background-color": appearance.value.promptBg,
                      color: contrastTextForHex(appearance.value.promptBg),
                    }}
                  >
                    Juliet, how do these new ABuCode bubble colors look?
                  </div>
                </div>
                <div
                  class="flex flex-col gap-1.5 rounded-lg p-2 text-[11px]"
                  style={{
                    "background-color": appearance.value.responseBg,
                    color: contrastTextForHex(appearance.value.responseBg),
                  }}
                >
                  <div
                    class="rounded px-2 py-1 text-[10px]"
                    style={{ "background-color": appearance.value.thinkingBg }}
                  >
                    💭 Thinking Trace: Checking pom-poms and strawberry lollipops...
                  </div>
                  <div>
                    <strong>Juliet Starling:</strong> Oh my gosh, Mano, they look <em>totally</em> gorgeous!! ♥
                  </div>
                </div>
              </div>

              <div class="flex items-center justify-between pt-1">
                <span class="font-medium text-v2-text-primary">Conversation Width</span>
                <div class="flex gap-1">
                  <For each={["narrow", "default", "wide", "fill"] as const}>
                    {(w) => (
                      <Button
                        size="small"
                        variant={appearance.value.width === w ? "submit" : "ghost"}
                        onClick={() => setWidth(w)}
                      >
                        {w[0]!.toUpperCase() + w.slice(1)}
                      </Button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Desktop Global Summon & System Tray */}
          <Show when={summonIpc && summonState()}>
            <div class="flex flex-col gap-2">
              <div class="flex flex-col gap-0.5">
                <h3 class="text-[14px] font-semibold text-v2-text-primary">{ctx.t("summonHeading")}</h3>
                <p class="text-[12px] text-v2-text-secondary">{ctx.t("summonSub")}</p>
              </div>

              <div class="flex flex-col gap-3 rounded-lg border border-v2-border-subtle p-3 text-[12px]">
                <div class="flex items-center justify-between">
                  <span class="font-medium text-v2-text-primary">Global Summon Hotkey</span>
                  <select
                    value={summonState()?.hotkey ?? "Alt+Space"}
                    onChange={(e) => {
                      const next = e.currentTarget.value as HotkeyPreset
                      void summonIpc
                        ?.setHotkey(next, { signal: ctx.signal })
                        .then((st) => setSummonState(st))
                        .catch(reportError)
                    }}
                    class="rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
                  >
                    <For each={HOTKEY_OPTIONS}>
                      {(opt) => <option value={opt.value}>{opt.label}</option>}
                    </For>
                  </select>
                </div>

                <label class="flex items-center justify-between cursor-pointer">
                  <span class="font-medium text-v2-text-primary">Close Window to System Tray</span>
                  <input
                    type="checkbox"
                    checked={Boolean(summonState()?.closeToTray)}
                    onChange={(e) => {
                      void summonIpc
                        ?.setCloseToTray(e.currentTarget.checked, { signal: ctx.signal })
                        .then((st) => setSummonState(st))
                        .catch(reportError)
                    }}
                  />
                </label>

                <label class="flex items-center justify-between cursor-pointer">
                  <span class="font-medium text-v2-text-primary">Always on Top</span>
                  <input
                    type="checkbox"
                    checked={Boolean(summonState()?.alwaysOnTop)}
                    onChange={(e) => {
                      void summonIpc
                        ?.setAlwaysOnTop(e.currentTarget.checked, { signal: ctx.signal })
                        .then((st) => setSummonState(st))
                        .catch(reportError)
                    }}
                  />
                </label>
              </div>
            </div>
          </Show>
        </div>
      )
    },
  })
}

export default setup

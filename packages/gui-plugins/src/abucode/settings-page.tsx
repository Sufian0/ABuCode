import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import { ABuCode, type ProviderKeyInfo, type SessionSettings } from "@opencode/schema/abucode"
import { Button } from "@opencode/ui/button"
import { Switch } from "@opencode/ui/switch"
import { useTheme } from "@opencode/ui/theme/context"
import { showToast } from "@opencode/ui/toast"
import { DesktopSummon, type SummonState } from "./contract"
import type ABuCodeDefinition from "./index"
import type { ChatWidth } from "./index"
import {
  BUBBLE_PRESETS,
  cloneSquad,
  contrastTextForHex,
  DEFAULT_SQUAD_UI,
  HOTKEY_OPTIONS,
  IDE_OPTIONS,
  parseBubblePreset,
  parseHotkeyPreset,
  parseIdeTarget,
  SQUAD_ROLE_ROWS,
  type MutableSquadDraft,
} from "./shared"

export interface ABuCodeSettingsProps {
  readonly onSessionUpdated: (serverID: string, sessionID: string, next: SessionSettings, savedGlobal?: boolean) => void
}

const ANTIGRAVITY_THEME_ID = "abucode:antigravity"

export default function ABuCodeSettingsPage(props: ABuCodeSettingsProps) {
  const ctx = usePlugin<typeof ABuCodeDefinition>()
  const theme = useTheme()
  const appearance = ctx.stores.appearance
  const skin = ctx.stores.skin
  const summonIpc = ctx.app.platform === "desktop" ? ctx.main(DesktopSummon) : undefined

  const [keyStatuses, setKeyStatuses] = createSignal<readonly ProviderKeyInfo[]>([])
  const [draftKeys, setDraftKeys] = createStore<Record<string, string>>({})
  const [testOutput, setTestOutput] = createSignal("")
  const [summonState, setSummonState] = createSignal<SummonState | undefined>(undefined)
  const [squadDraft, setSquadDraft] = createStore<MutableSquadDraft>(cloneSquad(DEFAULT_SQUAD_UI))

  const activeSession = () => ctx.sessions.current()

  const activeServer = () => {
    const sessionServer = activeSession()?.server

    if (sessionServer) return sessionServer

    const list = ctx.servers.list().map((id) => ctx.servers.get(id))

    return list.find((srv) => srv?.builtin && srv.connected) ?? list.find((srv) => srv?.connected) ?? list[0]
  }

  const showFailure = (message: string) =>
    showToast({
      variant: "error",
      title: ctx.t("requestFailed"),
      description: message,
    })

  // Load provider key vault statuses and active/default Squad settings whenever the server changes.
  createKeyed(
    () => {
      const srv = activeServer()

      return srv?.connected ? `${srv.id}\u0000${activeSession()?.id ?? ""}` : undefined
    },
    () => {
      const srv = activeServer()
      const cur = activeSession()

      if (!srv) return

      void srv.client
        .rpc(ABuCode.Definition)
        .getKeys({})
        .then(
          (rows) => setKeyStatuses(rows),
          () => undefined,
        )

      if (cur) {
        void srv.client
          .rpc(ABuCode.Definition)
          .getSession({ sessionID: cur.id }, { location: { directory: cur.directory } })
          .then(
            (st) => {
              if (st.squad) setSquadDraft(cloneSquad(st.squad))
            },
            () => undefined,
          )

        return
      }

      void srv.client
        .rpc(ABuCode.Definition)
        .catalog({})
        .then(
          (cat) => {
            if (cat.defaultSquad) setSquadDraft(cloneSquad(cat.defaultSquad))
          },
          () => undefined,
        )
    },
  )

  // Sync desktop tray and hotkey state when running inside the Electron desktop shell.
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
      .then(
        (rows) => {
          setKeyStatuses(rows)
          setDraftKeys({ venice: "", "nano-gpt": "", poe: "", runpod: "" })
          showToast({ variant: "success", title: ctx.t("keysSaved") })
        },
        (err: Error) => showFailure(err.message),
      )
  }

  const onSaveSquadSettings = (saveGlobal: boolean) => {
    const cur = activeSession()
    const srv = activeServer()

    if (!srv) return

    const sid = cur?.id ?? "default"
    const dir = cur?.directory ?? srv.data.project.list()[0]?.canonical
    const saveAsDefault = saveGlobal || !cur

    void srv.client
      .rpc(ABuCode.Definition)
      .setSquad(
        { sessionID: sid, squad: cloneSquad(squadDraft), saveAsDefault },
        dir ? { location: { directory: dir } } : undefined,
      )
      .then(
        (next) => {
          props.onSessionUpdated(srv.id, sid, next, saveAsDefault)
          showToast({
            variant: "success",
            title: saveAsDefault ? "Saved Squad routing as global default" : "Applied Squad routing to session",
          })
        },
        (err: Error) => showFailure(err.message),
      )
  }

  const onTestProvider = (providerID: string) => {
    const srv = activeServer()

    if (!srv) return

    setTestOutput(`Testing ${providerID}...`)

    void srv.client
      .rpc(ABuCode.Definition)
      .testProvider({ provider: providerID })
      .then(
        (res) => {
          setTestOutput(res.ok ? `✓ ${res.message ?? providerID}` : `✗ ${res.error ?? "Failed"}`)
        },
        (err: Error) => {
          setTestOutput(`✗ ${err.message}`)
        },
      )
  }

  const applyPreset = (raw: string) => {
    const preset = parseBubblePreset(raw)

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

  const isAntigravityTheme = () => theme.themeId() === ANTIGRAVITY_THEME_ID

  return (
    <div class="flex flex-col gap-6 p-4 max-w-[760px]">
      {/* Section 0: Antigravity UI Skin & Theme */}
      <div class="flex flex-col gap-2">
        <div class="flex flex-col gap-0.5">
          <h3 class="text-[14px] font-semibold text-v2-text-text-base">{ctx.t("skinHeading")}</h3>
          <p class="text-[12px] text-v2-text-text-muted">{ctx.t("skinSub")}</p>
        </div>

        <div class="flex flex-col divide-y divide-v2-border-border-muted rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base px-4">
          <div class="flex items-center justify-between gap-4 py-3.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("skinToggleLabel")}</span>
              <span class="text-[12px] text-v2-text-text-muted">{ctx.t("skinToggleDesc")}</span>
            </div>
            <Switch
              data-action="abucode-skin-toggle"
              checked={skin.value.enabled}
              onChange={(checked) =>
                skin.update((draft) => {
                  draft.enabled = checked
                })
              }
            />
          </div>

          <div class="flex items-center justify-between gap-4 py-3.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("skinThemeLabel")}</span>
              <span class="text-[12px] text-v2-text-text-muted">{ctx.t("skinThemeDesc")}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <Button
                size="small"
                variant={isAntigravityTheme() ? "submit" : "outline"}
                onClick={() => theme.setTheme(ANTIGRAVITY_THEME_ID)}
              >
                {isAntigravityTheme() ? ctx.t("skinThemeActive") : ctx.t("skinApplyThemeBtn")}
              </Button>
              <For each={["system", "light", "dark"] as const}>
                {(scheme) => (
                  <Button
                    size="small"
                    variant={theme.colorScheme() === scheme ? "submit" : "ghost"}
                    onClick={() => theme.setColorScheme(scheme)}
                  >
                    {scheme[0]!.toUpperCase() + scheme.slice(1)}
                  </Button>
                )}
              </For>
            </div>
          </div>

          <div class="flex items-center justify-between gap-4 py-3.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("skinSidebarLabel")}</span>
              <span class="text-[12px] text-v2-text-text-muted">{ctx.t("skinSidebarDesc")}</span>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <Button size="small" variant="outline" onClick={() => ctx.layout.settings("experimental")}>
                {ctx.t("skinOpenExperimentalBtn")}
              </Button>
              <Button size="small" variant="outline" onClick={() => ctx.layout.settings("general")}>
                {ctx.t("skinOpenPreferencesBtn")}
              </Button>
            </div>
          </div>

          <div class="flex items-center justify-between gap-4 py-3.5">
            <div class="flex flex-col gap-0.5">
              <span class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("skinGreetingLabel")}</span>
              <span class="text-[12px] text-v2-text-text-muted">{ctx.t("skinGreetingDesc")}</span>
            </div>
            <input
              type="text"
              value={skin.value.greeting ?? ""}
              onInput={(e) => {
                const value = e.currentTarget.value

                skin.update((draft) => {
                  draft.greeting = value
                })
              }}
              placeholder={ctx.t("skinGreetingPlaceholder")}
              class="w-[260px] rounded-full px-3 py-1.5 text-[12px] bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base outline-none"
            />
          </div>

          <Show when={ctx.app.platform === "desktop"}>
            <div class="flex items-center justify-between gap-4 py-3.5">
              <div class="flex flex-col gap-0.5">
                <span class="text-[13px] font-medium text-v2-text-text-base">{ctx.t("skinIdeLabel")}</span>
                <span class="text-[12px] text-v2-text-text-muted">{ctx.t("skinIdeDesc")}</span>
              </div>
              <select
                value={skin.value.ide}
                onChange={(e) => {
                  const next = parseIdeTarget(e.currentTarget.value)

                  skin.update((draft) => {
                    draft.ide = next
                  })
                }}
                class="rounded-full px-3 py-1 text-[12px] bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
              >
                <For each={IDE_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
              </select>
            </div>
          </Show>
        </div>
      </div>

      {/* Section 1: Provider API Keys */}
      <div class="flex flex-col gap-2">
        <div class="flex flex-col gap-0.5">
          <h3 class="text-[14px] font-semibold text-v2-text-text-base">{ctx.t("keysHeading")}</h3>
          <p class="text-[12px] text-v2-text-text-muted">{ctx.t("keysSub")}</p>
        </div>

        <div class="flex flex-col gap-3 rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base p-4">
          <For each={keyStatuses()}>
            {(prov) => (
              <div class="flex flex-col gap-1">
                <div class="flex items-center justify-between text-[12px]">
                  <span class="font-medium text-v2-text-text-base">
                    {prov.name} ({prov.envKey})
                  </span>
                  <div class="flex items-center gap-2">
                    <span class="text-v2-text-text-muted">
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
                  class="w-full rounded-[8px] px-2.5 py-1.5 text-[12px] bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base outline-none"
                />
              </div>
            )}
          </For>

          <div class="flex items-center justify-between pt-2">
            <span class="text-[12px] text-v2-text-text-muted">{testOutput()}</span>
            <Button size="small" variant="submit" onClick={onSaveKeys}>
              {ctx.t("saveKeysBtn")}
            </Button>
          </div>
        </div>
      </div>

      {/* Section 2: Squad Orchestration & Subscription Cost-Sharing */}
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-[14px] font-semibold text-v2-text-text-base">{ctx.t("squadHeading")}</h3>
            <p class="text-[12px] text-v2-text-text-muted">{ctx.t("squadSub")}</p>
          </div>
          <div class="flex gap-1">
            <Button
              size="small"
              variant={!squadDraft.enabled ? "submit" : "ghost"}
              onClick={() => setSquadDraft("enabled", false)}
            >
              Off
            </Button>
            <Button
              size="small"
              variant={squadDraft.enabled ? "submit" : "ghost"}
              onClick={() => setSquadDraft("enabled", true)}
            >
              On
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-3 rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base p-4 text-[12px]">
          <div class="grid grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="text-v2-text-text-muted">Max Total Agents per Turn</span>
              <select
                value={squadDraft.maxAgents}
                onChange={(e) => setSquadDraft("maxAgents", e.currentTarget.value)}
                class="rounded-[8px] px-2.5 py-1.5 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
              >
                <option value="auto">Auto (up to 12 agents)</option>
                <option value="4">4 agents (up to 2 lanes)</option>
                <option value="6">6 agents (up to 3 lanes)</option>
                <option value="8">8 agents (up to 4 lanes)</option>
                <option value="10">10 agents (up to 5 lanes)</option>
                <option value="12">12 agents (up to 6 lanes)</option>
              </select>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-v2-text-text-muted">Ask Before Workflow Over (USD)</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={squadDraft.costThresholdUsd}
                onInput={(e) => setSquadDraft("costThresholdUsd", Math.max(0, Number(e.currentTarget.value) || 0))}
                class="rounded-[8px] px-2.5 py-1.5 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base font-mono"
              />
            </label>
          </div>

          <div class="overflow-x-auto rounded-[8px] border border-v2-border-border-muted">
            <table class="w-full text-left text-[12px]">
              <thead class="bg-v2-background-bg-layer-01 text-v2-text-text-muted border-b border-v2-border-border-muted">
                <tr>
                  <th class="p-2 font-medium">Role</th>
                  <th class="p-2 font-medium">Count</th>
                  <th class="p-2 font-medium">Provider</th>
                  <th class="p-2 font-medium">Model ID ("same" = inherit)</th>
                  <th class="p-2 font-medium">Effort</th>
                </tr>
              </thead>
              <tbody>
                <For each={SQUAD_ROLE_ROWS}>
                  {(row) => (
                    <tr class="border-b last:border-b-0 border-v2-border-border-muted">
                      <td class="p-2 font-medium text-v2-text-text-base">
                        <div>{row.label}</div>
                        <div class="text-[10px] text-v2-text-text-muted">{row.sub}</div>
                      </td>
                      <td class="p-2">
                        <select
                          value={squadDraft.roles[row.key].count}
                          onChange={(e) => setSquadDraft("roles", row.key, "count", e.currentTarget.value)}
                          disabled={row.key === "skeptic"}
                          class="rounded-[6px] px-1.5 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
                        >
                          <option value="auto">Auto</option>
                          <Show when={row.key === "scout"}>
                            <option value="0">0 (Off)</option>
                            <option value="1">1</option>
                            <option value="2">2</option>
                          </Show>
                          <Show when={row.key === "investigator" || row.key === "reviewer"}>
                            <option value="1">Max 1</option>
                            <option value="2">Max 2</option>
                            <option value="3">Max 3</option>
                            <option value="4">Max 4</option>
                            <option value="6">Max 6</option>
                          </Show>
                        </select>
                      </td>
                      <td class="p-2">
                        <select
                          value={squadDraft.roles[row.key].provider}
                          onChange={(e) => setSquadDraft("roles", row.key, "provider", e.currentTarget.value)}
                          class="rounded-[6px] px-1.5 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
                        >
                          <option value="same">Same as Main</option>
                          <option value="venice">Venice</option>
                          <option value="nano-gpt">NanoGPT</option>
                          <option value="poe">Poe</option>
                        </select>
                      </td>
                      <td class="p-2">
                        <input
                          type="text"
                          value={squadDraft.roles[row.key].model}
                          onInput={(e) => setSquadDraft("roles", row.key, "model", e.currentTarget.value)}
                          placeholder="same"
                          class="w-full rounded-[6px] px-2 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base font-mono text-[11px]"
                        />
                      </td>
                      <td class="p-2">
                        <select
                          value={squadDraft.roles[row.key].effort}
                          onChange={(e) => setSquadDraft("roles", row.key, "effort", e.currentTarget.value)}
                          class="rounded-[6px] px-1.5 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
                        >
                          <option value="auto">Auto</option>
                          <option value="same">Same</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="xhigh">XHigh</option>
                          <option value="max">Max</option>
                        </select>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <div class="flex justify-end gap-2 pt-1">
            <Button size="small" variant="ghost" onClick={() => setSquadDraft(cloneSquad(DEFAULT_SQUAD_UI))}>
              Reset to Auto
            </Button>
            <Show when={activeSession()}>
              <Button size="small" variant="ghost" onClick={() => onSaveSquadSettings(true)}>
                {ctx.t("saveGlobal")}
              </Button>
              <Button size="small" variant="submit" onClick={() => onSaveSquadSettings(false)}>
                {ctx.t("applyChat")}
              </Button>
            </Show>
          </div>
        </div>
      </div>

      {/* Section 3: Per-Bubble Appearance & Conversation Width */}
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-[14px] font-semibold text-v2-text-text-base">{ctx.t("bubblesHeading")}</h3>
            <p class="text-[12px] text-v2-text-text-muted">{ctx.t("bubblesSub")}</p>
          </div>
          <Button size="small" variant="ghost" onClick={() => applyPreset("theme")}>
            {ctx.t("resetThemeBtn")}
          </Button>
        </div>

        <div class="flex flex-col gap-3 rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base p-4 text-[12px]">
          <div class="flex items-center justify-between">
            <span class="font-medium text-v2-text-text-base">Bubble Style Preset</span>
            <select
              value={appearance.value.preset}
              onChange={(e) => applyPreset(e.currentTarget.value)}
              class="rounded-full px-3 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
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
              <span class="text-v2-text-text-muted">Prompt (Input)</span>
              <div class="flex items-center gap-1.5">
                <input
                  type="color"
                  value={appearance.value.promptBg}
                  onInput={(e) => setCustomColor("promptBg", e.currentTarget.value)}
                />
                <span class="font-mono text-v2-text-text-base">{appearance.value.promptBg}</span>
              </div>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-v2-text-text-muted">Response (Output)</span>
              <div class="flex items-center gap-1.5">
                <input
                  type="color"
                  value={appearance.value.responseBg}
                  onInput={(e) => setCustomColor("responseBg", e.currentTarget.value)}
                />
                <span class="font-mono text-v2-text-text-base">{appearance.value.responseBg}</span>
              </div>
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-v2-text-text-muted">Thinking Trace</span>
              <div class="flex items-center gap-1.5">
                <input
                  type="color"
                  value={appearance.value.thinkingBg}
                  onInput={(e) => setCustomColor("thinkingBg", e.currentTarget.value)}
                />
                <span class="font-mono text-v2-text-text-base">{appearance.value.thinkingBg}</span>
              </div>
            </label>
          </div>

          <div class="flex flex-col gap-2 rounded-[10px] p-3 border border-v2-border-border-muted bg-v2-background-bg-layer-01">
            <div class="flex justify-end">
              <div
                class="rounded-[14px] px-3 py-1.5 text-[11px] font-medium"
                style={{
                  "background-color": appearance.value.promptBg,
                  color: contrastTextForHex(appearance.value.promptBg),
                }}
              >
                Juliet, how do these new ABuCode bubble colors look?
              </div>
            </div>
            <div
              class="flex flex-col gap-1.5 rounded-[12px] p-2.5 text-[11px]"
              style={{
                "background-color": appearance.value.responseBg,
                color: contrastTextForHex(appearance.value.responseBg),
              }}
            >
              <div class="rounded-[8px] px-2 py-1 text-[10px]" style={{ "background-color": appearance.value.thinkingBg }}>
                💭 Thinking Trace: Checking pom-poms and strawberry lollipops...
              </div>
              <div>
                <strong>Juliet Starling:</strong> Oh my gosh, Mano, they look <em>totally</em> gorgeous!! ♥
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between pt-1">
            <span class="font-medium text-v2-text-text-base">Conversation Width</span>
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

      {/* Section 4: Desktop Global Summon & System Tray */}
      <Show when={summonIpc && summonState()}>
        <div class="flex flex-col gap-2">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-[14px] font-semibold text-v2-text-text-base">{ctx.t("summonHeading")}</h3>
            <p class="text-[12px] text-v2-text-text-muted">{ctx.t("summonSub")}</p>
          </div>

          <div class="flex flex-col divide-y divide-v2-border-border-muted rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base px-4 text-[12px]">
            <div class="flex items-center justify-between gap-4 py-3.5">
              <div class="flex flex-col">
                <span class="font-medium text-v2-text-text-base">Global Summon Hotkey</span>
                <Show when={summonState()?.usedFallback && summonState()?.activeAccelerator}>
                  <span class="text-[11px] text-v2-text-text-muted">
                    Preferred shortcut was busy; automatically bound to{" "}
                    <strong class="font-mono">{summonState()?.activeAccelerator}</strong>
                  </span>
                </Show>
              </div>
              <select
                value={summonState()?.hotkey ?? "Alt+Space"}
                onChange={(e) => {
                  const next = parseHotkeyPreset(e.currentTarget.value)

                  void summonIpc
                    ?.setHotkey(next, { signal: ctx.signal })
                    .then(
                      (st) => setSummonState(st),
                      (err: Error) => showFailure(err.message),
                    )
                }}
                class="rounded-full px-3 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
              >
                <For each={HOTKEY_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
              </select>
            </div>

            <div class="flex items-center justify-between gap-4 py-3.5">
              <span class="font-medium text-v2-text-text-base">Close Window to System Tray</span>
              <Switch
                checked={Boolean(summonState()?.closeToTray)}
                onChange={(checked) => {
                  void summonIpc
                    ?.setCloseToTray(checked, { signal: ctx.signal })
                    .then(
                      (st) => setSummonState(st),
                      (err: Error) => showFailure(err.message),
                    )
                }}
              />
            </div>

            <div class="flex items-center justify-between gap-4 py-3.5">
              <span class="font-medium text-v2-text-text-base">Always on Top</span>
              <Switch
                checked={Boolean(summonState()?.alwaysOnTop)}
                onChange={(checked) => {
                  void summonIpc
                    ?.setAlwaysOnTop(checked, { signal: ctx.signal })
                    .then(
                      (st) => setSummonState(st),
                      (err: Error) => showFailure(err.message),
                    )
                }}
              />
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

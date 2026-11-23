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
  type SquadRoleName,
  type SquadSettings,
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

const DEFAULT_SQUAD_UI: SquadSettings = {
  enabled: false,
  maxAgents: "auto",
  costThresholdUsd: 5.0,
  roles: {
    scout: { count: "auto", provider: "same", model: "same", effort: "auto" },
    investigator: { count: "auto", provider: "same", model: "same", effort: "auto" },
    skeptic: { count: "auto", provider: "same", model: "same", effort: "auto" },
    reviewer: { count: "auto", provider: "same", model: "same", effort: "auto" },
  },
}

const SQUAD_ROLE_ROWS: readonly { readonly key: SquadRoleName; readonly label: string; readonly sub: string }[] = [
  { key: "scout", label: "Scout", sub: "Fast repo recon (0–2)" },
  { key: "investigator", label: "Investigator", sub: "Hypothesis & design lanes" },
  { key: "skeptic", label: "Skeptic", sub: "Adversarial citation verifier" },
  { key: "reviewer", label: "Reviewer", sub: "Diff & code review lenses" },
]

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

interface MutableRoleDraft {
  count: string
  provider: string
  model: string
  effort: string
}

interface MutableSquadDraft {
  enabled: boolean
  maxAgents: string
  costThresholdUsd: number
  roles: Record<SquadRoleName, MutableRoleDraft>
}

function cloneSquad(sq?: SquadSettings): MutableSquadDraft {
  const src = sq ?? DEFAULT_SQUAD_UI
  return {
    enabled: src.enabled,
    maxAgents: src.maxAgents,
    costThresholdUsd: src.costThresholdUsd,
    roles: {
      scout: { ...src.roles.scout },
      investigator: { ...src.roles.investigator },
      skeptic: { ...src.roles.skeptic },
      reviewer: { ...src.roles.reviewer },
    },
  }
}

const setup: Plugin.Setup<typeof ABuCodeDefinition> = (ctx) => {
  ctx.add(Style, styleCss)

  const appearance = ctx.stores.appearance
  const summonIpc = ctx.app.platform === "desktop" ? ctx.main(DesktopSummon) : undefined

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
    Record<
      string,
      | {
          characters: readonly CharacterEntry[]
          wildcards: readonly CharacterEntry[]
          defaultSquad?: SquadSettings
        }
      | undefined
    >
  >({})

  const sessionKey = (serverID: string, sessionID: string) => `${serverID}\u0000${sessionID}`
  const readSession = (input: ComposerPillProps) => sessions[sessionKey(input.session.server.id, input.session.id)]

  // Sync active session settings, catalog, and tray approval alerts with the ABuCode server plugin over RPC.
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
            if (event.data.approvalAlert) {
              const alert = event.data.approvalAlert
              if (summonIpc) {
                void summonIpc
                  .notifyApprovalIfHidden({ title: alert.title, body: alert.detail }, { signal: controller.signal })
                  .catch(() => undefined)
              } else if (
                typeof document !== "undefined" &&
                document.hidden &&
                typeof Notification !== "undefined" &&
                Notification.permission === "granted"
              ) {
                new Notification(alert.title, { body: alert.detail })
              }
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
              setCatalogByServer(serverID, {
                characters: cat.characters,
                wildcards: cat.wildcards,
                defaultSquad: cat.defaultSquad,
              })
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

  const updateSquad = (
    input: ComposerPillMenuProps,
    squad: SquadSettings,
    saveAsDefault = false,
    closeAfter = true,
  ) => {
    const serverID = input.session.server.id
    const sid = input.session.id
    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setSquad({ sessionID: sid, squad, saveAsDefault }, { location: { directory: input.session.directory } })
      .then((next) => {
        setSessions(sessionKey(serverID, sid), next)
        if (closeAfter) input.close()
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

  // 1. Household 343 + Vanilla + Visual Multi-Character Checkbox Picker + Multi-Wildcard Slots
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
      const initialRaw = readSession(input)?.character ?? "default"
      const initialParts = initialRaw
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !["default", "none", "random"].includes(p.toLowerCase()))

      const [multiMode, setMultiMode] = createSignal(initialParts.length > 1)
      const [selectedMulti, setSelectedMulti] = createSignal<string[]>(initialParts)
      const [query, setQuery] = createSignal(initialParts.length > 1 ? "" : initialRaw)
      const [wildDescs, setWildDescs] = createStore<Record<string, string>>({})

      const catalog = createMemo(() => catalogByServer[input.session.server.id])
      const filtered = createMemo(() => {
        const list = catalog()?.characters ?? []
        const q = query().trim().toLowerCase()
        if (!q || q === "default" || q === "none" || q === "random") return list.slice(0, 50)
        return list
          .filter((item) => item.key.toLowerCase().includes(q) || item.display.toLowerCase().includes(q))
          .slice(0, 50)
      })

      const activeWildKeys = createMemo(() => {
        if (multiMode()) {
          return selectedMulti().filter((k) => /^other(?:10|[1-9])$/i.test(k))
        }
        const single = query().trim()
        return /^other(?:10|[1-9])$/i.test(single) ? [single] : []
      })

      const toggleMultiItem = (key: string) => {
        const cur = selectedMulti()
        if (cur.includes(key)) {
          setSelectedMulti(cur.filter((k) => k !== key))
        } else {
          setSelectedMulti([...cur, key])
        }
      }

      const formatWildSlot = (key: string) => {
        const desc = (wildDescs[key] ?? "").trim()
        return /^other(?:10|[1-9])$/i.test(key) && desc ? `${key} {${desc}}` : key
      }

      const composedValue = () => {
        if (multiMode()) {
          const list = selectedMulti().map(formatWildSlot)
          return list.length > 0 ? list.join(", ") : "default"
        }
        const raw = query().trim()
        if (!raw) return "default"
        return formatWildSlot(raw)
      }

      return (
        <div class="flex flex-col gap-2 p-1 min-w-[310px] max-w-[380px]">
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
            <Button
              size="small"
              variant={multiMode() ? "submit" : "ghost"}
              onClick={() => {
                const next = !multiMode()
                setMultiMode(next)
                if (next) setQuery("")
              }}
            >
              {multiMode() ? ctx.t("singleModeBtn") : ctx.t("multiModeBtn")}
            </Button>
          </div>

          <input
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder={ctx.t("filterPlaceholder")}
            class="w-full rounded px-2 py-1 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none"
          />

          <Show when={multiMode() && selectedMulti().length > 0}>
            <div class="flex flex-wrap gap-1 p-1 rounded bg-v2-background-bg-subtle border border-v2-border-subtle">
              <For each={selectedMulti()}>
                {(key) => (
                  <button
                    type="button"
                    onClick={() => toggleMultiItem(key)}
                    class="px-1.5 py-0.5 rounded text-[11px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
                  >
                    {key} ×
                  </button>
                )}
              </For>
            </div>
          </Show>

          <For each={activeWildKeys()}>
            {(wKey) => (
              <input
                type="text"
                value={wildDescs[wKey] ?? ""}
                onInput={(e) => setWildDescs(wKey, e.currentTarget.value)}
                placeholder={`${wKey}: ${ctx.t("wildcardPlaceholder")}`}
                class="w-full rounded px-2 py-1 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none"
              />
            )}
          </For>

          <div class="max-h-[165px] overflow-y-auto flex flex-col gap-0.5 border border-v2-border-subtle rounded p-1">
            <For each={filtered()}>
              {(item) => (
                <Show
                  when={multiMode()}
                  fallback={
                    <button
                      type="button"
                      onClick={() => updateCharacter(input, item.key)}
                      class="text-left px-2 py-1 rounded text-[12px] hover:bg-v2-background-bg-subtle text-v2-text-primary truncate"
                    >
                      {item.display}
                    </button>
                  }
                >
                  <label class="flex items-center gap-2 px-2 py-1 rounded text-[12px] hover:bg-v2-background-bg-subtle text-v2-text-primary cursor-pointer truncate">
                    <input
                      type="checkbox"
                      checked={selectedMulti().includes(item.key)}
                      onChange={() => toggleMultiItem(item.key)}
                    />
                    <span class="truncate">{item.display}</span>
                  </label>
                </Show>
              )}
            </For>
            <For each={catalog()?.wildcards ?? []}>
              {(wild) => (
                <Show
                  when={multiMode()}
                  fallback={
                    <button
                      type="button"
                      onClick={() => setQuery(wild.key)}
                      class="text-left px-2 py-1 rounded text-[12px] hover:bg-v2-background-bg-subtle text-v2-text-secondary truncate"
                    >
                      {wild.display} (Wildcard)
                    </button>
                  }
                >
                  <label class="flex items-center gap-2 px-2 py-1 rounded text-[12px] hover:bg-v2-background-bg-subtle text-v2-text-secondary cursor-pointer truncate">
                    <input
                      type="checkbox"
                      checked={selectedMulti().includes(wild.key)}
                      onChange={() => toggleMultiItem(wild.key)}
                    />
                    <span class="truncate">{wild.display} (Wildcard)</span>
                  </label>
                </Show>
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

  // 2. Pinned Session Memory Pill (+ One-Click Compaction into Memory)
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
      const [compacting, setCompacting] = createSignal(false)

      const onCompactNow = () => {
        const serverID = input.session.server.id
        const sid = input.session.id
        setCompacting(true)
        void input.session.server.client
          .rpc(ABuCode.Definition)
          .compactToMemory({ sessionID: sid, keepLast: 4 }, { location: { directory: input.session.directory } })
          .then((res) => {
            setCompacting(false)
            setSessions(sessionKey(serverID, sid), res.settings)
            setDraft(res.settings.memory)
            if (res.compacted) {
              showToast({
                variant: "success",
                title: `Compacted ${res.compactedCount} messages (~${res.tokensSaved} tok) into Pinned Memory`,
              })
            } else {
              showToast({
                variant: "default",
                title: "Need at least 2 messages in this chat before compacting",
              })
            }
          })
          .catch((err) => {
            setCompacting(false)
            reportError(err)
          })
      }

      return (
        <div class="flex flex-col gap-2 p-1 min-w-[320px]">
          <textarea
            rows={5}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            placeholder={ctx.t("memoryPlaceholder")}
            class="w-full rounded p-2 text-[12px] bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary outline-none resize-y"
          />
          <div class="flex items-center justify-between gap-1">
            <Button size="small" variant="ghost" disabled={compacting()} onClick={onCompactNow}>
              {compacting() ? "Compacting..." : ctx.t("compactMemory")}
            </Button>
            <div class="flex gap-1">
              <Button size="small" variant="ghost" onClick={() => updateMemory(input, "")}>
                {ctx.t("clearMemory")}
              </Button>
              <Button size="small" variant="submit" onClick={() => updateMemory(input, draft())}>
                {ctx.t("saveMemory")}
              </Button>
            </div>
          </div>
        </div>
      )
    },
  })

  // 3. Squad Multi-Agent Orchestration & Subscription Routing Pill
  ctx.add(ComposerPill, {
    id: "squad",
    order: -15,
    show: (input) => {
      const enabled = Boolean(readSession(input)?.squad?.enabled)
      return {
        label: enabled ? ctx.t("squadOn") : ctx.t("squadOff"),
        icon: "models",
        tone: enabled ? "success" : undefined,
        title: ctx.t("squadTitle"),
      }
    },
    menu: (input) => {
      const [draft, setDraft] = createStore<MutableSquadDraft>(cloneSquad(readSession(input)?.squad))

      return (
        <div class="flex flex-col gap-2.5 p-1.5 min-w-[360px] max-w-[440px] text-[12px]">
          <div class="flex items-center justify-between gap-2 pb-1 border-b border-v2-border-subtle">
            <span class="font-semibold text-v2-text-primary">{ctx.t("squadTitle")}</span>
            <div class="flex gap-1">
              <Button
                size="small"
                variant={!draft.enabled ? "submit" : "ghost"}
                onClick={() => setDraft("enabled", false)}
              >
                Off
              </Button>
              <Button
                size="small"
                variant={draft.enabled ? "submit" : "ghost"}
                onClick={() => setDraft("enabled", true)}
              >
                On
              </Button>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-0.5">
              <span class="text-v2-text-secondary text-[11px]">Max Agents / Turn</span>
              <select
                value={draft.maxAgents}
                onChange={(e) => setDraft("maxAgents", e.currentTarget.value)}
                class="rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
              >
                <option value="auto">Auto (up to 12)</option>
                <option value="4">4 (2 lanes)</option>
                <option value="6">6 (3 lanes)</option>
                <option value="8">8 (4 lanes)</option>
                <option value="10">10 (5 lanes)</option>
                <option value="12">12 (6 lanes)</option>
              </select>
            </label>

            <label class="flex flex-col gap-0.5">
              <span class="text-v2-text-secondary text-[11px]">Cost Gate (USD)</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={draft.costThresholdUsd}
                onInput={(e) => setDraft("costThresholdUsd", Math.max(0, Number(e.currentTarget.value) || 0))}
                class="rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary font-mono"
              />
            </label>
          </div>

          <div class="flex flex-col gap-1 border border-v2-border-subtle rounded p-1.5">
            <span class="text-[11px] font-medium text-v2-text-secondary">
              Per-Role Subscription Routing (Provider &amp; Effort)
            </span>
            <For each={SQUAD_ROLE_ROWS}>
              {(row) => (
                <div class="grid grid-cols-[96px_1fr_84px] items-center gap-1.5 py-0.5">
                  <span class="font-medium text-v2-text-primary truncate" title={row.sub}>
                    {row.label}
                  </span>
                  <select
                    value={draft.roles[row.key].provider}
                    onChange={(e) => setDraft("roles", row.key, "provider", e.currentTarget.value)}
                    class="rounded px-1.5 py-0.5 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary text-[11px]"
                  >
                    <option value="same">Same as Main</option>
                    <option value="venice">Venice</option>
                    <option value="nano-gpt">NanoGPT</option>
                    <option value="poe">Poe</option>
                  </select>
                  <select
                    value={draft.roles[row.key].effort}
                    onChange={(e) => setDraft("roles", row.key, "effort", e.currentTarget.value)}
                    class="rounded px-1.5 py-0.5 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary text-[11px]"
                  >
                    <option value="auto">Auto</option>
                    <option value="same">Same</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">XHigh</option>
                    <option value="max">Max</option>
                  </select>
                </div>
              )}
            </For>
          </div>

          <div class="flex justify-end gap-1 pt-0.5">
            <Button size="small" variant="ghost" onClick={() => updateSquad(input, cloneSquad(draft), true)}>
              {ctx.t("saveGlobal")}
            </Button>
            <Button size="small" variant="submit" onClick={() => updateSquad(input, cloneSquad(draft), false)}>
              {ctx.t("applyChat")}
            </Button>
          </div>
        </div>
      )
    },
  })

  // 4. 4-Tier Command Approval Policy Quick-Switcher Pill
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

  // 5. ABuCode Settings Page (.env.local Vault, Squad Routing Table, Bubble Colors, Width Presets & Desktop Summon)
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
      const [squadDraft, setSquadDraft] = createStore<MutableSquadDraft>(cloneSquad(DEFAULT_SQUAD_UI))

      const activeSession = () => ctx.sessions.current()
      const activeServer = () => activeSession()?.server

      createKeyed(
        () => (activeServer()?.connected ? `${activeServer()?.id}\u0000${activeSession()?.id ?? ""}` : undefined),
        () => {
          const srv = activeServer()
          const cur = activeSession()
          if (!srv) return
          void srv.client
            .rpc(ABuCode.Definition)
            .getKeys({})
            .then((rows) => setKeyStatuses(rows), () => undefined)

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
          }
        },
      )

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

      const onSaveSquadSettings = (saveGlobal: boolean) => {
        const cur = activeSession()
        if (!cur) return
        void cur.server.client
          .rpc(ABuCode.Definition)
          .setSquad(
            { sessionID: cur.id, squad: cloneSquad(squadDraft), saveAsDefault: saveGlobal },
            { location: { directory: cur.directory } },
          )
          .then((next) => {
            setSessions(sessionKey(cur.server.id, cur.id), next)
            showToast({
              variant: "success",
              title: saveGlobal ? "Saved Squad routing as global default" : "Applied Squad routing to session",
            })
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
        <div class="flex flex-col gap-6 p-4 max-w-[760px]">
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

          {/* Section 2: Squad Orchestration & Subscription Cost-Sharing */}
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <div class="flex flex-col gap-0.5">
                <h3 class="text-[14px] font-semibold text-v2-text-primary">{ctx.t("squadHeading")}</h3>
                <p class="text-[12px] text-v2-text-secondary">{ctx.t("squadSub")}</p>
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

            <div class="flex flex-col gap-3 rounded-lg border border-v2-border-subtle p-3 text-[12px]">
              <div class="grid grid-cols-2 gap-3">
                <label class="flex flex-col gap-1">
                  <span class="text-v2-text-secondary">Max Total Agents per Turn</span>
                  <select
                    value={squadDraft.maxAgents}
                    onChange={(e) => setSquadDraft("maxAgents", e.currentTarget.value)}
                    class="rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
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
                  <span class="text-v2-text-secondary">Ask Before Workflow Over (USD)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={squadDraft.costThresholdUsd}
                    onInput={(e) =>
                      setSquadDraft("costThresholdUsd", Math.max(0, Number(e.currentTarget.value) || 0))
                    }
                    class="rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary font-mono"
                  />
                </label>
              </div>

              <div class="overflow-x-auto rounded border border-v2-border-subtle">
                <table class="w-full text-left text-[12px]">
                  <thead class="bg-v2-background-bg-subtle text-v2-text-secondary border-b border-v2-border-subtle">
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
                        <tr class="border-b last:border-b-0 border-v2-border-subtle">
                          <td class="p-2 font-medium text-v2-text-primary">
                            <div>{row.label}</div>
                            <div class="text-[10px] text-v2-text-secondary">{row.sub}</div>
                          </td>
                          <td class="p-2">
                            <select
                              value={squadDraft.roles[row.key].count}
                              onChange={(e) => setSquadDraft("roles", row.key, "count", e.currentTarget.value)}
                              disabled={row.key === "skeptic"}
                              class="rounded px-1.5 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
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
                              class="rounded px-1.5 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
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
                              class="w-full rounded px-2 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary font-mono text-[11px]"
                            />
                          </td>
                          <td class="p-2">
                            <select
                              value={squadDraft.roles[row.key].effort}
                              onChange={(e) => setSquadDraft("roles", row.key, "effort", e.currentTarget.value)}
                              class="rounded px-1.5 py-1 bg-v2-background-bg-base border border-v2-border-subtle text-v2-text-primary"
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
                <Button size="small" variant="ghost" onClick={() => onSaveSquadSettings(true)}>
                  {ctx.t("saveGlobal")}
                </Button>
                <Button size="small" variant="submit" onClick={() => onSaveSquadSettings(false)}>
                  {ctx.t("applyChat")}
                </Button>
              </div>
            </div>
          </div>

          {/* Section 3: Per-Bubble Appearance & Conversation Width */}
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

          {/* Section 4: Desktop Global Summon & System Tray */}
          <Show when={summonIpc && summonState()}>
            <div class="flex flex-col gap-2">
              <div class="flex flex-col gap-0.5">
                <h3 class="text-[14px] font-semibold text-v2-text-primary">{ctx.t("summonHeading")}</h3>
                <p class="text-[12px] text-v2-text-secondary">{ctx.t("summonSub")}</p>
              </div>

              <div class="flex flex-col gap-3 rounded-lg border border-v2-border-subtle p-3 text-[12px]">
                <div class="flex items-center justify-between">
                  <div class="flex flex-col">
                    <span class="font-medium text-v2-text-primary">Global Summon Hotkey</span>
                    <Show when={summonState()?.usedFallback && summonState()?.activeAccelerator}>
                      <span class="text-[11px] text-v2-text-secondary">
                        Preferred shortcut was busy; automatically bound to{" "}
                        <strong class="font-mono">{summonState()?.activeAccelerator}</strong>
                      </span>
                    </Show>
                  </div>
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

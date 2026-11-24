import { createMemo, createSignal, For, lazy, onCleanup, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { Match } from "effect"
import {
  Command,
  ComposerPill,
  createKeyed,
  SettingsPage,
  Slot,
  Style,
  Theme,
  TitlebarItem,
  type ComposerPillMenuProps,
  type ComposerPillProps,
  type ComposerPillTone,
  type Plugin,
} from "@opencode/plugin/gui"
import { onIdle } from "@opencode/plugin/gui/builtin"
import {
  ABuCode,
  type CharacterEntry,
  type PolicyTier,
  type SessionSettings,
  type SquadSettings,
} from "@opencode/schema/abucode"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { showToast } from "@opencode/ui/toast"
import { DesktopSummon } from "./contract"
import { ABUCODE_BANNER_DATA_URL } from "./brand-banner"
import type ABuCodeDefinition from "./index"
import {
  cloneSquad,
  contrastTextForHex,
  POLICY_ICONS,
  POLICY_LABELS,
  SQUAD_ROLE_ROWS,
  type MutableSquadDraft,
} from "./shared"
import styleCss from "./style.css?inline"
import { antigravityTheme } from "./theme"

const POLICY_ORDER: readonly PolicyTier[] = ["request_review", "default", "auto", "turbo"]

function policyPillTone(tier: PolicyTier): ComposerPillTone | undefined {
  return Match.value(tier).pipe(
    Match.when("turbo", () => "warning" as const),
    Match.when("request_review", () => "success" as const),
    Match.orElse(() => undefined),
  )
}

const setup: Plugin.Setup<typeof ABuCodeDefinition> = (ctx) => {
  ctx.add(Style, styleCss)
  ctx.add(Theme, antigravityTheme)

  const appearance = ctx.stores.appearance
  const skin = ctx.stores.skin
  const summonIpc = ctx.app.platform === "desktop" ? ctx.main(DesktopSummon) : undefined
  const SettingsView = lazy(() => import("./settings-page"))

  onCleanup(onIdle(() => void SettingsView.preload()))

  // Sync Antigravity UI skin attribute, greeting, bubble custom properties, and conversation width onto :root.
  createKeyed(
    () => {
      const v = appearance.value
      const s = skin.value

      return `${s.enabled}|${s.greeting ?? ""}|${v.preset}|${v.promptBg}|${v.responseBg}|${v.thinkingBg}|${v.width}`
    },
    () => {
      if (typeof document === "undefined") return

      const root = document.documentElement
      const v = appearance.value
      const greeting = skin.value.greeting?.trim() || ctx.t("skinGreetingDefault")

      if (skin.value.enabled) {
        root.setAttribute("data-abucode-skin", "antigravity")
        root.style.setProperty("--abucode-greeting", JSON.stringify(greeting))
        root.style.setProperty("--abucode-hero-logo", `url("${ABUCODE_BANNER_DATA_URL}")`)
      } else {
        root.removeAttribute("data-abucode-skin")
        root.style.removeProperty("--abucode-greeting")
        root.style.removeProperty("--abucode-hero-logo")
      }

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

    document.documentElement.removeAttribute("data-abucode-skin")
    document.documentElement.style.removeProperty("--abucode-greeting")
    document.documentElement.style.removeProperty("--abucode-hero-logo")
    document.documentElement.removeAttribute("data-abucode-bubbles")
    document.documentElement.removeAttribute("data-abucode-width")
  })

  // Top-right / sidebar-footer "Open IDE" pill on Home and New Session screens (desktop only).
  ctx.add(TitlebarItem, (): TitlebarItem | undefined => {
    const desktop = ctx.desktop

    if (!desktop || !skin.value.enabled || ctx.sessions.current()) return undefined

    return {
      id: "open-ide",
      icon: "code",
      label: ctx.t("openIde"),
      title: ctx.t("openIdeTooltip"),
      run: () => {
        const srv = ctx.servers
          .list()
          .map((id) => ctx.servers.get(id))
          .find((item) => item?.local && item.connected)

        const dir = srv?.data.project.list()[0]?.canonical

        if (!dir) return

        const app = skin.value.ide === "explorer" ? undefined : skin.value.ide

        void desktop.launch(dir, app)
      },
    }
  })

  // Command Palette: Toggle Between Light/Dark Themes (matches Antigravity palette command).
  ctx.add(
    Command,
    (): Command => ({
      id: "toggle-color-scheme",
      featured: true,
      get title() {
        return ctx.t("cmdToggleScheme")
      },
      get description() {
        return ctx.t("cmdToggleSchemeDesc")
      },
      keywords: "theme light dark mode appearance antigravity",
      run: () => {
        if (typeof window === "undefined") return

        const next = ctx.appearance.mode() === "dark" ? "light" : "dark"

        try {
          localStorage.setItem("opencode-color-scheme", next)
          window.dispatchEvent(new StorageEvent("storage", { key: "opencode-color-scheme", newValue: next }))
        } catch {
          // Storage blocked in restricted contexts
        }
      },
    }),
  )

  // Command Palette: Toggle Antigravity UI Skin geometry on or off.
  ctx.add(
    Command,
    (): Command => ({
      id: "toggle-skin",
      get title() {
        return ctx.t("cmdToggleSkin")
      },
      get description() {
        return ctx.t("cmdToggleSkinDesc")
      },
      keywords: "antigravity skin rounded pill ui look",
      run: () => {
        skin.update((draft) => {
          draft.enabled = !draft.enabled
        })
      },
    }),
  )

  // Session Header "Open IDE" pill (desktop local workspaces).
  ctx.add(Slot, {
    at: "session.header",
    order: 4,
    render: (input) => {
      const visible = () => Boolean(ctx.desktop && input.session.server.local && input.session.directory)

      const launchIde = () => {
        const desktop = ctx.desktop

        if (!desktop) return

        const app = skin.value.ide === "explorer" ? undefined : skin.value.ide

        void desktop.launch(input.session.directory, app)
      }

      return (
        <Show when={visible()}>
          <Show
            when={!input.compact}
            fallback={
              <ctx.ui.Tooltip value={ctx.t("openIdeTooltip")}>
                <ctx.ui.IconButton
                  icon="code"
                  label={ctx.t("openIde")}
                  variant="ghost"
                  size="small"
                  onClick={launchIde}
                />
              </ctx.ui.Tooltip>
            }
          >
            <button
              type="button"
              data-slot="abucode-open-ide-pill"
              title={ctx.t("openIdeTooltip")}
              onClick={launchIde}
              class="inline-flex h-7 items-center gap-1.5 rounded-full border border-v2-border-border-base bg-v2-background-bg-base px-3 text-[12px] font-medium text-v2-text-text-base transition-colors hover:bg-v2-background-bg-layer-01"
            >
              <span>{ctx.t("openIde")}</span>
            </button>
          </Show>
        </Show>
      )
    },
  })

  const [sessions, setSessions] = createStore<Record<string, SessionSettings | undefined>>({})

  const [catalogByServer, setCatalogByServer] = createStore<
    Record<
      string,
      | {
          characters: readonly CharacterEntry[]
          wildcards: readonly CharacterEntry[]
          defaultCharacter?: string
          defaultPolicy?: PolicyTier
          defaultSquad?: SquadSettings
        }
      | undefined
    >
  >({})

  const formatCharacterLabel = (raw: string | undefined, characters: readonly CharacterEntry[]) => {
    const clean = (raw ?? "").trim()

    if (!clean || clean.toLowerCase() === "default" || clean.toLowerCase() === "auto") return ctx.t("defaultCortana")

    if (clean.toLowerCase() === "none") return ctx.t("noCharacter")

    if (clean.toLowerCase() === "random") return ctx.t("randomCharacter")

    const otherMatch = /^(Other(?:10|[1-9]))(?:\s*\{([^}]*)\})?$/i.exec(clean)

    if (otherMatch?.[1]) {
      const slot = `Other ${/\d+/.exec(otherMatch[1])?.[0] ?? "1"}`
      const desc = (otherMatch[2] ?? "").trim()

      return desc ? `${slot}: ${desc.slice(0, 28)}${desc.length > 28 ? "…" : ""}` : slot
    }

    const found = characters.find((item) => item.key.toLowerCase() === clean.toLowerCase())

    return found ? found.display : clean
  }

  const sessionKey = (serverID: string, sessionID: string) => `${serverID}\u0000${sessionID}`

  const readSession = (input: ComposerPillProps): SessionSettings | undefined => {
    const serverID = input.session.server.id
    const stored = sessions[sessionKey(serverID, input.session.id)]

    if (stored) return stored

    const cat = catalogByServer[serverID]

    if (!cat) return undefined

    const character = cat.defaultCharacter ?? "default"

    return {
      sessionID: input.session.id,
      character,
      characterLabel: formatCharacterLabel(character, cat.characters),
      memory: "",
      policy: cat.defaultPolicy ?? "default",
      squad: cat.defaultSquad,
    }
  }

  const activeServer = () =>
    ctx.sessions.current()?.server ??
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((item) => item?.connected)

  // Sync catalog, global defaults, and tray approval alerts whenever a server connects (including on New Session).
  createKeyed(
    () => {
      const srv = activeServer()

      return srv?.connected ? `${srv.id}\u0000${srv.url}` : undefined
    },
    () => {
      const srv = activeServer()

      if (!srv) return

      const serverID = srv.id
      const rpc = srv.client.rpc(ABuCode.Definition)
      const controller = new AbortController()
      const dir = srv.data.project.list()[0]?.canonical

      onCleanup(() => controller.abort())

      onCleanup(
        rpc.events.on(
          "changed",
          (event) => {
            if (event.data.sessionID && event.data.settings) {
              setSessions(sessionKey(serverID, event.data.sessionID), event.data.settings)
            }

            if (
              event.data.defaultCharacter !== undefined ||
              event.data.defaultPolicy !== undefined ||
              event.data.defaultSquad !== undefined
            ) {
              const prev = catalogByServer[serverID]

              if (prev) {
                setCatalogByServer(serverID, {
                  ...prev,
                  defaultCharacter: event.data.defaultCharacter ?? prev.defaultCharacter,
                  defaultPolicy: event.data.defaultPolicy ?? prev.defaultPolicy,
                  defaultSquad: event.data.defaultSquad ?? prev.defaultSquad,
                })
              }
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
        .catalog({}, dir ? { location: { directory: dir }, signal: controller.signal } : { signal: controller.signal })
        .then(
          (cat) => {
            if (!controller.signal.aborted) {
              setCatalogByServer(serverID, {
                characters: cat.characters,
                wildcards: cat.wildcards,
                defaultCharacter: cat.defaultCharacter,
                defaultPolicy: cat.defaultPolicy,
                defaultSquad: cat.defaultSquad,
              })
            }
          },
          () => undefined,
        )
    },
  )

  // Sync active routed session settings with the ABuCode server plugin over RPC.
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

      onCleanup(() => controller.abort())

      void rpc
        .getSession(
          { sessionID: current.id },
          { location: { directory: current.directory }, signal: controller.signal },
        )
        .then(
          (next) => {
            if (!controller.signal.aborted) {
              setSessions(sessionKey(serverID, current.id), next)
            }
          },
          () => undefined,
        )

      if (!catalogByServer[serverID]) {
        void rpc
          .catalog({}, { location: { directory: current.directory }, signal: controller.signal })
          .then(
            (cat) => {
              if (!controller.signal.aborted) {
                setCatalogByServer(serverID, {
                  characters: cat.characters,
                  wildcards: cat.wildcards,
                  defaultCharacter: cat.defaultCharacter,
                  defaultPolicy: cat.defaultPolicy,
                  defaultSquad: cat.defaultSquad,
                })
              }
            },
            () => undefined,
          )
      }
    },
  )

  const reportError = (cause: Error) =>
    showToast({
      variant: "error",
      title: ctx.t("requestFailed"),
      description: cause.message,
    })

  const updateCharacter = (input: ComposerPillMenuProps, character: string, saveAsDefault = false) => {
    const serverID = input.session.server.id
    const sid = input.session.id

    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setCharacter({ sessionID: sid, character, saveAsDefault }, { location: { directory: input.session.directory } })
      .then(
        (next) => {
          setSessions(sessionKey(serverID, sid), next)

          if (saveAsDefault) {
            const prev = catalogByServer[serverID]

            if (prev) setCatalogByServer(serverID, { ...prev, defaultCharacter: next.character })
          }

          input.close()
        },
        (err: Error) => reportError(err),
      )
  }

  const updateMemory = (input: ComposerPillMenuProps, memory: string) => {
    const serverID = input.session.server.id
    const sid = input.session.id

    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setMemory({ sessionID: sid, memory }, { location: { directory: input.session.directory } })
      .then(
        (next) => {
          setSessions(sessionKey(serverID, sid), next)
          input.close()
        },
        (err: Error) => reportError(err),
      )
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
      .then(
        (next) => {
          setSessions(sessionKey(serverID, sid), next)

          if (saveAsDefault && next.squad) {
            const prev = catalogByServer[serverID]

            if (prev) setCatalogByServer(serverID, { ...prev, defaultSquad: next.squad })
          }

          if (closeAfter) input.close()
        },
        (err: Error) => reportError(err),
      )
  }

  const updatePolicy = (input: ComposerPillMenuProps, policy: PolicyTier, saveAsDefault = false, closeAfter = true) => {
    const serverID = input.session.server.id
    const sid = input.session.id

    void input.session.server.client
      .rpc(ABuCode.Definition)
      .setPolicy({ sessionID: sid, policy, saveAsDefault }, { location: { directory: input.session.directory } })
      .then(
        (next) => {
          setSessions(sessionKey(serverID, sid), next)

          if (saveAsDefault) {
            const prev = catalogByServer[serverID]

            if (prev) setCatalogByServer(serverID, { ...prev, defaultPolicy: policy })

            showToast({ variant: "success", title: ctx.t("policyDefaultSaved") })
          }

          if (closeAfter) input.close()
        },
        (err: Error) => reportError(err),
      )
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
        <div class="flex flex-col gap-2 p-1.5 min-w-[310px] max-w-[380px]">
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
            class="w-full rounded-[8px] px-2.5 py-1.5 text-[12px] bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base outline-none"
          />

          <Show when={multiMode() && selectedMulti().length > 0}>
            <div class="flex flex-wrap gap-1 p-1.5 rounded-[8px] bg-v2-background-bg-layer-01 border border-v2-border-border-muted">
              <For each={selectedMulti()}>
                {(key) => (
                  <button
                    type="button"
                    onClick={() => toggleMultiItem(key)}
                    class="px-2 py-0.5 rounded-full text-[11px] bg-v2-background-bg-base border border-v2-border-border-base text-v2-text-text-base"
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
                class="w-full rounded-[8px] px-2.5 py-1.5 text-[12px] bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base outline-none"
              />
            )}
          </For>

          <div class="max-h-[165px] overflow-y-auto flex flex-col gap-0.5 border border-v2-border-border-muted rounded-[8px] p-1">
            <For each={filtered()}>
              {(item) => (
                <Show
                  when={multiMode()}
                  fallback={
                    <button
                      type="button"
                      onClick={() => updateCharacter(input, item.key)}
                      class="text-left px-2 py-1 rounded-[6px] text-[12px] hover:bg-v2-background-bg-layer-01 text-v2-text-text-base truncate"
                    >
                      {item.display}
                    </button>
                  }
                >
                  <label class="flex items-center gap-2 px-2 py-1 rounded-[6px] text-[12px] hover:bg-v2-background-bg-layer-01 text-v2-text-text-base cursor-pointer truncate">
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
                      class="text-left px-2 py-1 rounded-[6px] text-[12px] hover:bg-v2-background-bg-layer-01 text-v2-text-text-muted truncate"
                    >
                      {wild.display} (Wildcard)
                    </button>
                  }
                >
                  <label class="flex items-center gap-2 px-2 py-1 rounded-[6px] text-[12px] hover:bg-v2-background-bg-layer-01 text-v2-text-text-muted cursor-pointer truncate">
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
          .then(
            (res) => {
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
            },
            (err: Error) => {
              setCompacting(false)
              reportError(err)
            },
          )
      }

      return (
        <div class="flex flex-col gap-2 p-1.5 min-w-[320px]">
          <textarea
            rows={5}
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            placeholder={ctx.t("memoryPlaceholder")}
            class="w-full rounded-[8px] p-2.5 text-[12px] bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base outline-none resize-y"
          />
          <div class="flex items-center justify-between gap-1">
            <Button size="small" variant="ghost" disabled={compacting()} onClick={onCompactNow}>
              {compacting() ? ctx.t("compactingBtn") : ctx.t("compactMemory")}
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
          <div class="flex items-center justify-between gap-2 pb-1.5 border-b border-v2-border-border-muted">
            <span class="font-semibold text-v2-text-text-base">{ctx.t("squadTitle")}</span>
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
              <span class="text-v2-text-text-muted text-[11px]">Max Agents / Turn</span>
              <select
                value={draft.maxAgents}
                onChange={(e) => setDraft("maxAgents", e.currentTarget.value)}
                class="rounded-[6px] px-2 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base"
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
              <span class="text-v2-text-text-muted text-[11px]">Cost Gate (USD)</span>
              <input
                type="number"
                min="0"
                step="0.5"
                value={draft.costThresholdUsd}
                onInput={(e) => setDraft("costThresholdUsd", Math.max(0, Number(e.currentTarget.value) || 0))}
                class="rounded-[6px] px-2 py-1 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base font-mono"
              />
            </label>
          </div>

          <div class="flex flex-col gap-1 border border-v2-border-border-muted rounded-[8px] p-2">
            <span class="text-[11px] font-medium text-v2-text-text-muted">
              Per-Role Subscription Routing (Provider &amp; Effort)
            </span>
            <For each={SQUAD_ROLE_ROWS}>
              {(row) => (
                <div class="grid grid-cols-[96px_1fr_84px] items-center gap-1.5 py-0.5">
                  <span class="font-medium text-v2-text-text-base truncate" title={row.sub}>
                    {row.label}
                  </span>
                  <select
                    value={draft.roles[row.key].provider}
                    onChange={(e) => setDraft("roles", row.key, "provider", e.currentTarget.value)}
                    class="rounded-[6px] px-1.5 py-0.5 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base text-[11px]"
                  >
                    <option value="same">Same as Main</option>
                    <option value="venice">Venice</option>
                    <option value="nano-gpt">NanoGPT</option>
                    <option value="poe">Poe</option>
                  </select>
                  <select
                    value={draft.roles[row.key].effort}
                    onChange={(e) => setDraft("roles", row.key, "effort", e.currentTarget.value)}
                    class="rounded-[6px] px-1.5 py-0.5 bg-v2-background-bg-layer-01 border border-v2-border-border-base text-v2-text-text-base text-[11px]"
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

  // 4. Antigravity-style "Local Permissions" 4-Tier Quick-Switcher Pill
  ctx.add(ComposerPill, {
    id: "policy",
    order: -10,
    show: (input) => {
      const tier = readSession(input)?.policy ?? "default"

      return {
        label: POLICY_LABELS[tier],
        icon: "shield",
        tone: policyPillTone(tier),
        title: ctx.t("policyTitle"),
      }
    },
    menu: (input) => {
      const currentTier = () => readSession(input)?.policy ?? "default"
      const defaultTier = () => catalogByServer[input.session.server.id]?.defaultPolicy ?? "default"

      const tierTitle = (tier: PolicyTier) =>
        Match.value(tier).pipe(
          Match.when("request_review", () => ctx.t("policyReviewLabel")),
          Match.when("default", () => ctx.t("policyDefaultLabel")),
          Match.when("auto", () => ctx.t("policyAutoLabel")),
          Match.when("turbo", () => ctx.t("policyTurboLabel")),
          Match.exhaustive,
        )

      const tierDesc = (tier: PolicyTier) =>
        Match.value(tier).pipe(
          Match.when("request_review", () => ctx.t("policyReviewDesc")),
          Match.when("default", () => ctx.t("policyDefaultDesc")),
          Match.when("auto", () => ctx.t("policyAutoDesc")),
          Match.when("turbo", () => ctx.t("policyTurboDesc")),
          Match.exhaustive,
        )

      return (
        <div class="flex flex-col gap-1 p-1.5 min-w-[300px] max-w-[340px]">
          <div class="px-2.5 pt-1 pb-1 text-[12px] font-medium text-v2-text-text-muted">{ctx.t("policyTitle")}</div>

          <For each={POLICY_ORDER}>
            {(tier) => {
              const selected = () => currentTier() === tier
              const isDefault = () => defaultTier() === tier

              return (
                <button
                  type="button"
                  data-action={`abucode-policy-${tier}`}
                  onClick={() => updatePolicy(input, tier, false, true)}
                  class="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors hover:bg-v2-background-bg-layer-01"
                >
                  <span class="flex size-5 shrink-0 items-center justify-center text-v2-icon-icon-muted">
                    <Icon name={POLICY_ICONS[tier]} size="small" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="flex items-center gap-1.5">
                      <span class="text-[13px] font-medium text-v2-text-text-base">{tierTitle(tier)}</span>
                      <Show when={isDefault()}>
                        <span class="rounded-full bg-v2-background-bg-layer-02 px-2 py-0.5 text-[11px] font-normal text-v2-text-text-muted">
                          {ctx.t("policyDefaultBadge")}
                        </span>
                      </Show>
                    </span>
                    <span class="text-[12px] leading-4 text-v2-text-text-muted">{tierDesc(tier)}</span>
                  </span>
                  <span class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-base">
                    <Show when={selected()}>
                      <Icon name="check" size="small" />
                    </Show>
                  </span>
                </button>
              )
            }}
          </For>

          <Show when={currentTier() !== defaultTier()}>
            <div class="mt-1 border-t border-v2-border-border-muted pt-1.5 flex justify-end px-1">
              <Button
                size="small"
                variant="ghost"
                onClick={() => updatePolicy(input, currentTier(), true, false)}
              >
                {ctx.t("policySetDefaultBtn")}
              </Button>
            </div>
          </Show>
        </div>
      )
    },
  })

  // 5. ABuCode Settings Page (.env.local Vault, Squad Routing, Antigravity Skin, Bubble Colors & Desktop Summon)
  ctx.add(SettingsPage, {
    id: "abucode",
    get title() {
      return ctx.t("settingsTitle")
    },
    icon: "models",
    render: () => (
      <Suspense>
        <SettingsView
          onSessionUpdated={(serverID, sessionID, next, savedGlobal) => {
            setSessions(sessionKey(serverID, sessionID), next)

            if (savedGlobal && next.squad) {
              const prev = catalogByServer[serverID]

              if (prev) setCatalogByServer(serverID, { ...prev, defaultSquad: next.squad })
            }
          }}
        />
      </Suspense>
    ),
  })
}

export default setup

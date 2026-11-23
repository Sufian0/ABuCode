import { app, type BrowserWindow, globalShortcut, Menu, nativeImage, Notification, Tray } from "electron"
import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin/gui/main"
import { DesktopSummon, HotkeyPreset, type SummonState } from "./contract"

const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGAWDEaiqqv7PwMDAwMjIyICPjU1dXR27JrACXBqxGcLIyIjNEFxm4DKEmZkZThMwg4GBgYGRkREuA+IzBF0DNgNQNcA0YDOEmM2DmIEYBgYAvfcR8d5vNdcAAAAASUVORK5CYII="

const FALLBACK_ACCELERATORS: readonly Exclude<HotkeyPreset, "None">[] = [
  "CommandOrControl+Shift+Space",
  "Alt+Shift+M",
  "CommandOrControl+Alt+M",
]

const StoredPrefs = Schema.Struct({
  hotkey: HotkeyPreset,
  closeToTray: Schema.Boolean,
  alwaysOnTop: Schema.Boolean,
})

const FOCUS_COMPOSER_SCRIPT = `(() => {
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
  const candidate = document.querySelector('[data-slot="composer-input"], [contenteditable="true"], textarea:not([disabled])');
  if (candidate && typeof candidate.focus === 'function') candidate.focus();
})()`

const setup: Plugin.MainSetup = (ctx) => {
  const prefs = ctx.storage.store("summonPrefs", {
    schema: StoredPrefs,
    initial: {
      hotkey: "Alt+Space",
      closeToTray: true,
      alwaysOnTop: false,
    },
  })

  const runtime = {
    quitting: false,
    activeAccelerator: "" as string,
    usedFallback: false,
    registered: false,
    lastAlertSignature: "" as string,
    tray: undefined as Tray | undefined,
  }

  const pickTargetWindow = (): BrowserWindow | undefined => ctx.windows.focused() ?? ctx.windows.list()[0]

  const focusComposerInWindow = (win: BrowserWindow) => {
    try {
      win.webContents.focus()
      void win.webContents.executeJavaScript(FOCUS_COMPOSER_SCRIPT, true).catch(() => undefined)
    } catch {
      // Safe ignore while page is navigating
    }
  }

  const summonWindow = (): boolean => {
    const win = pickTargetWindow()
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    focusComposerInWindow(win)
    return true
  }

  const toggleSummon = () => {
    const win = pickTargetWindow()
    if (!win || win.isDestroyed()) return
    if (win.isVisible() && win.isFocused() && !win.isMinimized()) {
      if (prefs.value.closeToTray) win.hide()
      else win.minimize()
      return
    }
    summonWindow()
  }

  const unregisterHotkey = () => {
    if (runtime.activeAccelerator) {
      try {
        globalShortcut.unregister(runtime.activeAccelerator)
      } catch {
        // Ignore teardown race
      }
      runtime.activeAccelerator = ""
      runtime.usedFallback = false
      runtime.registered = false
    }
  }

  const applyHotkey = (preset: HotkeyPreset) => {
    unregisterHotkey()
    if (preset === "None") return

    try {
      if (globalShortcut.register(preset, toggleSummon)) {
        runtime.activeAccelerator = preset
        runtime.usedFallback = false
        runtime.registered = true
        return
      }
    } catch {
      // Proceed to fallback chain
    }

    // Automatic MultiCode-style fallback chain when Alt+Space is held by PowerToys Run / ChatGPT
    for (const candidate of FALLBACK_ACCELERATORS) {
      if (candidate === preset) continue
      try {
        if (globalShortcut.register(candidate, toggleSummon)) {
          runtime.activeAccelerator = candidate
          runtime.usedFallback = true
          runtime.registered = true
          return
        }
      } catch {
        continue
      }
    }

    runtime.registered = false
  }

  const applyAlwaysOnTopAll = (enabled: boolean) => {
    for (const win of ctx.windows.list()) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(enabled)
    }
  }

  const rebuildTrayMenu = () => {
    if (!runtime.tray) return
    const boundLabel = runtime.activeAccelerator || (prefs.value.hotkey === "None" ? "None" : "Unavailable")
    const menu = Menu.buildFromTemplate([
      {
        label:
          prefs.value.hotkey === "None"
            ? "Summon ABuCode"
            : `Summon / Hide (${boundLabel}${runtime.usedFallback ? " · fallback" : ""})`,
        click: () => summonWindow(),
      },
      { type: "separator" },
      {
        label: "Always on Top",
        type: "checkbox",
        checked: prefs.value.alwaysOnTop,
        click: (item) => {
          prefs.update((draft) => {
            draft.alwaysOnTop = item.checked
          })
          applyAlwaysOnTopAll(item.checked)
          rebuildTrayMenu()
        },
      },
      {
        label: "Close Window to System Tray",
        type: "checkbox",
        checked: prefs.value.closeToTray,
        click: (item) => {
          prefs.update((draft) => {
            draft.closeToTray = item.checked
          })
          rebuildTrayMenu()
        },
      },
      { type: "separator" },
      {
        label: "Quit ABuCode",
        click: () => {
          runtime.quitting = true
          app.quit()
        },
      },
    ])
    runtime.tray.setToolTip(`ABuCode${runtime.activeAccelerator ? ` (${runtime.activeAccelerator})` : ""}`)
    runtime.tray.setContextMenu(menu)
  }

  const notifyApprovalIfHidden = (title: string, body: string): boolean => {
    const win = pickTargetWindow()
    const isHiddenOrUnfocused = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()
    if (!isHiddenOrUnfocused) return false

    const sig = `${title}|${body}`
    if (runtime.lastAlertSignature === sig) return false
    runtime.lastAlertSignature = sig

    const hkHint = runtime.activeAccelerator ? ` (Press ${runtime.activeAccelerator} or click to review)` : ""
    const fullBody = `${body}${hkHint}`

    if (process.platform === "win32" && runtime.tray) {
      try {
        runtime.tray.displayBalloon({
          title,
          content: fullBody,
          iconType: "info",
        })
        return true
      } catch {
        // Fall back to Electron Notification below
      }
    }

    try {
      if (Notification.isSupported()) {
        const notif = new Notification({ title, body: fullBody })
        notif.on("click", () => {
          summonWindow()
        })
        notif.show()
        return true
      }
    } catch {
      // Ignore unsupported headless environments
    }
    return false
  }

  const attachWindowHooks = (win: BrowserWindow) => {
    if (win.isDestroyed()) return
    win.setAlwaysOnTop(prefs.value.alwaysOnTop)
    const onFocus = () => {
      runtime.lastAlertSignature = ""
    }
    const onClose = (event: Electron.Event) => {
      if (!runtime.quitting && prefs.value.closeToTray) {
        event.preventDefault()
        win.hide()
      }
    }
    win.on("focus", onFocus)
    win.on("close", onClose)
    ctx.onCleanup(() => {
      if (!win.isDestroyed()) {
        win.removeListener("focus", onFocus)
        win.removeListener("close", onClose)
      }
    })
  }

  const onBeforeQuit = () => {
    runtime.quitting = true
  }
  app.on("before-quit", onBeforeQuit)

  try {
    const img = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
    runtime.tray = new Tray(img)
    runtime.tray.on("click", () => toggleSummon())
    runtime.tray.on("balloon-click", () => summonWindow())
    rebuildTrayMenu()
  } catch {
    // Headless test environments without a system tray continue gracefully
  }

  for (const existing of ctx.windows.list()) {
    attachWindowHooks(existing)
  }
  ctx.windows.on("open", (win) => attachWindowHooks(win))

  if (process.argv.some((arg) => arg === "--minimized" || arg === "--tray" || arg === "--background")) {
    for (const win of ctx.windows.list()) {
      if (!win.isDestroyed()) win.hide()
    }
  }

  applyHotkey(prefs.value.hotkey)
  rebuildTrayMenu()

  ctx.onCleanup(() => {
    app.removeListener("before-quit", onBeforeQuit)
    unregisterHotkey()
    if (runtime.tray) {
      runtime.tray.destroy()
      runtime.tray = undefined
    }
  })

  const currentState = (): SummonState => ({
    hotkey: prefs.value.hotkey,
    activeAccelerator: runtime.activeAccelerator,
    usedFallback: runtime.usedFallback,
    registered: runtime.registered,
    closeToTray: prefs.value.closeToTray,
    alwaysOnTop: prefs.value.alwaysOnTop,
  })

  ctx.provide(DesktopSummon, {
    getState: () => currentState(),
    setHotkey: (next) => {
      prefs.update((draft) => {
        draft.hotkey = next
      })
      applyHotkey(next)
      rebuildTrayMenu()
      return currentState()
    },
    setCloseToTray: (enabled) => {
      prefs.update((draft) => {
        draft.closeToTray = enabled
      })
      rebuildTrayMenu()
      return currentState()
    },
    setAlwaysOnTop: (enabled) => {
      prefs.update((draft) => {
        draft.alwaysOnTop = enabled
      })
      applyAlwaysOnTopAll(enabled)
      rebuildTrayMenu()
      return currentState()
    },
    summonNow: () => summonWindow(),
    notifyApprovalIfHidden: (input) => notifyApprovalIfHidden(input.title, input.body),
  })
}

export default setup

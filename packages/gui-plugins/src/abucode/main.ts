import { app, type BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from "electron"
import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin/gui/main"
import { DesktopSummon, HotkeyPreset, type SummonState } from "./contract"

// Crisp 16x16 sapphire/violet diamond tray icon encoded inline so dev and packaged builds always have a valid tray image.
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGAWDEaiqqv7PwMDAwMjIyICPjU1dXR27JrACXBqxGcLIyIjNEFxm4DKEmZkZThMwg4GBgYGRkREuA+IzBF0DNgNQNcA0YDOEmM2DmIEYBgYAvfcR8d5vNdcAAAAASUVORK5CYII="

const StoredPrefs = Schema.Struct({
  hotkey: HotkeyPreset,
  closeToTray: Schema.Boolean,
  alwaysOnTop: Schema.Boolean,
})

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
    registered: false,
    tray: undefined as Tray | undefined,
  }

  const pickTargetWindow = (): BrowserWindow | undefined => ctx.windows.focused() ?? ctx.windows.list()[0]

  const summonWindow = (): boolean => {
    const win = pickTargetWindow()
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
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
        // Ignore if app already tore down shortcuts
      }
      runtime.activeAccelerator = ""
      runtime.registered = false
    }
  }

  const applyHotkey = (preset: HotkeyPreset) => {
    unregisterHotkey()
    if (preset === "None") return
    try {
      const ok = globalShortcut.register(preset, toggleSummon)
      runtime.registered = ok
      if (ok) runtime.activeAccelerator = preset
    } catch {
      runtime.registered = false
    }
  }

  const applyAlwaysOnTopAll = (enabled: boolean) => {
    for (const win of ctx.windows.list()) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(enabled)
    }
  }

  const rebuildTrayMenu = () => {
    if (!runtime.tray) return
    const hk = prefs.value.hotkey
    const menu = Menu.buildFromTemplate([
      {
        label: hk === "None" ? "Summon ABuCode" : `Summon / Hide (${hk})`,
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
    runtime.tray.setToolTip(`ABuCode${hk !== "None" ? ` (${hk})` : ""}`)
    runtime.tray.setContextMenu(menu)
  }

  const attachWindowHooks = (win: BrowserWindow) => {
    if (win.isDestroyed()) return
    win.setAlwaysOnTop(prefs.value.alwaysOnTop)
    const onClose = (event: Electron.Event) => {
      if (!runtime.quitting && prefs.value.closeToTray) {
        event.preventDefault()
        win.hide()
      }
    }
    win.on("close", onClose)
    ctx.onCleanup(() => {
      if (!win.isDestroyed()) win.removeListener("close", onClose)
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
  })
}

export default setup

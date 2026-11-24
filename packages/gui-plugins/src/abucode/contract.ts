import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

export const HotkeyPreset = Schema.Literals([
  "Alt+Space",
  "CommandOrControl+Shift+Space",
  "CommandOrControl+Alt+M",
  "Alt+Shift+M",
  "None",
])

export type HotkeyPreset = typeof HotkeyPreset.Type

export const SummonState = Schema.Struct({
  hotkey: HotkeyPreset,
  activeAccelerator: Schema.String,
  usedFallback: Schema.Boolean,
  registered: Schema.Boolean,
  closeToTray: Schema.Boolean,
  alwaysOnTop: Schema.Boolean,
})

export type SummonState = typeof SummonState.Type

export const ApprovalNotifyInput = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})

export type ApprovalNotifyInput = typeof ApprovalNotifyInput.Type

export const DesktopSummon = Ipc.define({
  id: "abucode.summon",
  methods: {
    getState: { output: SummonState },
    setHotkey: { input: HotkeyPreset, output: SummonState },
    setCloseToTray: { input: Schema.Boolean, output: SummonState },
    setAlwaysOnTop: { input: Schema.Boolean, output: SummonState },
    summonNow: { output: Schema.Boolean },
    notifyApprovalIfHidden: { input: ApprovalNotifyInput, output: Schema.Boolean },
  },
})

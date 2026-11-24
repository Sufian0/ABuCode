import type { PolicyTier, SquadRoleName, SquadSettings } from "@opencode/schema/abucode"
import type { IconName } from "@opencode/plugin/gui"
import type { HotkeyPreset } from "./contract"
import type { BubblePreset, IdeTarget } from "./index"

export const POLICY_LABELS: Record<PolicyTier, string> = {
  request_review: "Request Review",
  default: "Default",
  auto: "Auto",
  turbo: "Turbo",
}

export const POLICY_ICONS: Record<PolicyTier, IconName> = {
  request_review: "eye",
  default: "lock",
  auto: "shield",
  turbo: "warning",
}

export const DEFAULT_SQUAD_UI: SquadSettings = {
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

export const SQUAD_ROLE_ROWS: readonly { readonly key: SquadRoleName; readonly label: string; readonly sub: string }[] =
  [
    { key: "scout", label: "Scout", sub: "Fast repo recon (0–2)" },
    { key: "investigator", label: "Investigator", sub: "Hypothesis & design lanes" },
    { key: "skeptic", label: "Skeptic", sub: "Adversarial citation verifier" },
    { key: "reviewer", label: "Reviewer", sub: "Diff & code review lenses" },
  ]

export const BUBBLE_PRESETS: Record<
  Exclude<BubblePreset, "theme" | "custom">,
  { promptBg: string; responseBg: string; thinkingBg: string }
> = {
  multicode: { promptBg: "#8B5A3C", responseBg: "#E8E0D0", thinkingBg: "#EFE7DA" },
  "poe-indigo": { promptBg: "#5B4CE6", responseBg: "#F3F4F6", thinkingBg: "#EDE9FE" },
  "antigravity-blue": { promptBg: "#2F75C3", responseBg: "#F7F7F8", thinkingBg: "#EEF4FB" },
}

export const HOTKEY_OPTIONS: readonly { readonly value: HotkeyPreset; readonly label: string }[] = [
  { value: "Alt+Space", label: "Alt+Space (Default)" },
  { value: "CommandOrControl+Shift+Space", label: "Ctrl/Cmd+Shift+Space" },
  { value: "CommandOrControl+Alt+M", label: "Ctrl/Cmd+Alt+M" },
  { value: "Alt+Shift+M", label: "Alt+Shift+M" },
  { value: "None", label: "None (Disabled)" },
]

export const IDE_OPTIONS: readonly { readonly value: IdeTarget; readonly label: string }[] = [
  { value: "code", label: "VS Code" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "explorer", label: "File Explorer" },
]

export interface MutableRoleDraft {
  count: string
  provider: string
  model: string
  effort: string
}

export interface MutableSquadDraft {
  enabled: boolean
  maxAgents: string
  costThresholdUsd: number
  roles: Record<SquadRoleName, MutableRoleDraft>
}

export function contrastTextForHex(hex: string): string {
  const clean = hex.replace("#", "")

  if (clean.length !== 6) return "#ffffff"

  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255

  return lum > 0.62 ? "#1f1d1a" : "#ffffff"
}

export function cloneSquad(sq?: SquadSettings): MutableSquadDraft {
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

export function parseBubblePreset(value: string): BubblePreset {
  if (value === "multicode" || value === "poe-indigo" || value === "antigravity-blue" || value === "custom") {
    return value
  }

  return "theme"
}

export function parseHotkeyPreset(value: string): HotkeyPreset {
  const match = HOTKEY_OPTIONS.find((item) => item.value === value)

  return match ? match.value : "Alt+Space"
}

export function parseIdeTarget(value: string): IdeTarget {
  const match = IDE_OPTIONS.find((item) => item.value === value)

  return match ? match.value : "code"
}

export function formatFailureMessage(cause: Error | string): string {
  return cause instanceof Error ? cause.message : cause
}

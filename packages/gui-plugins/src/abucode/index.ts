import { Schema } from "effect"
import { Plugin, Store } from "@opencode/plugin/gui"
import en from "./i18n/en"

export const BubblePreset = Schema.Literals([
  "theme",
  "multicode",
  "poe-indigo",
  "antigravity-blue",
  "custom",
])

export type BubblePreset = typeof BubblePreset.Type

export const ChatWidth = Schema.Literals(["narrow", "default", "wide", "fill"])

export type ChatWidth = typeof ChatWidth.Type

export const IdeTarget = Schema.Literals(["code", "cursor", "zed", "explorer"])

export type IdeTarget = typeof IdeTarget.Type

export const AppearanceStore = Schema.Struct({
  preset: BubblePreset,
  promptBg: Schema.String,
  responseBg: Schema.String,
  thinkingBg: Schema.String,
  width: ChatWidth,
})

export type AppearanceStore = typeof AppearanceStore.Type

export const SkinStore = Schema.Struct({
  enabled: Schema.Boolean,
  ide: IdeTarget,
  greeting: Schema.optional(Schema.String),
})

export type SkinStore = typeof SkinStore.Type

export default Plugin.define({
  i18n: { en },
  stores: {
    appearance: Store.global(AppearanceStore, {
      preset: "theme",
      promptBg: "#8B5A3C",
      responseBg: "#E8E0D0",
      thinkingBg: "#EFE7DA",
      width: "default",
    }),
    skin: Store.global(SkinStore, {
      enabled: true,
      ide: "code",
    }),
  },
})

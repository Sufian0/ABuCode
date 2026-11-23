export * as ABuCode from "./abucode.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

export const PolicyTier = Schema.Literals(["request_review", "default", "auto", "turbo"])
export type PolicyTier = typeof PolicyTier.Type

export const SquadRoleName = Schema.Literals(["scout", "investigator", "skeptic", "reviewer"])
export type SquadRoleName = typeof SquadRoleName.Type

export const SquadRoleRouting = Schema.Struct({
  /** "auto" or integer string "0".."6" */
  count: Schema.String,
  /** "same" | "venice" | "nano-gpt" | "poe" */
  provider: Schema.String,
  /** "same" or explicit model ID */
  model: Schema.String,
  /** "auto" | "same" | "low" | "medium" | "high" | "xhigh" | "max" */
  effort: Schema.String,
})
export type SquadRoleRouting = typeof SquadRoleRouting.Type

export const SquadSettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** "auto" (up to 12) or "4" | "6" | "8" | "10" | "12" */
  maxAgents: Schema.String,
  costThresholdUsd: Schema.Number,
  roles: Schema.Struct({
    scout: SquadRoleRouting,
    investigator: SquadRoleRouting,
    skeptic: SquadRoleRouting,
    reviewer: SquadRoleRouting,
  }),
})
export type SquadSettings = typeof SquadSettings.Type

export const CharacterEntry = Schema.Struct({
  key: Schema.String,
  display: Schema.String,
  wildcard: optional(Schema.Boolean),
})
export type CharacterEntry = typeof CharacterEntry.Type

export const SessionSettings = Schema.Struct({
  sessionID: Schema.String,
  /** "none" = No Character (Vanilla), "default" = Auto (Cortana), "random", "<Name>", "<N1, N2>", or "Other1 {desc}" */
  character: Schema.String,
  characterLabel: Schema.String,
  memory: Schema.String,
  policy: PolicyTier,
  squad: optional(SquadSettings),
})
export type SessionSettings = typeof SessionSettings.Type

export const ProviderKeyInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  envKey: Schema.String,
  hasKey: Schema.Boolean,
  maskedKey: Schema.String,
})
export type ProviderKeyInfo = typeof ProviderKeyInfo.Type

export const Catalog = Schema.Struct({
  characters: Schema.Array(CharacterEntry),
  wildcards: Schema.Array(CharacterEntry),
  defaultCharacter: Schema.String,
  defaultPolicy: PolicyTier,
  defaultSquad: optional(SquadSettings),
  contentRoot: Schema.String,
})
export type Catalog = typeof Catalog.Type

export const ConnectionTestResult = Schema.Struct({
  ok: Schema.Boolean,
  provider: Schema.String,
  latencyMs: optional(Schema.Number),
  message: optional(Schema.String),
  error: optional(Schema.String),
})
export type ConnectionTestResult = typeof ConnectionTestResult.Type

export const CompactionSummaryResult = Schema.Struct({
  compacted: Schema.Boolean,
  compactedCount: Schema.Number,
  tokensSaved: Schema.Number,
  summary: Schema.String,
  settings: SessionSettings,
})
export type CompactionSummaryResult = typeof CompactionSummaryResult.Type

export const ApprovalAlert = Schema.Struct({
  sessionID: Schema.String,
  title: Schema.String,
  detail: Schema.String,
})
export type ApprovalAlert = typeof ApprovalAlert.Type

export const Definition = Rpc.define({
  id: "abucode.control",
  methods: {
    catalog: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Catalog),
    },
    getSession: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(SessionSettings),
    },
    setCharacter: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          character: Schema.String,
          saveAsDefault: optional(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(SessionSettings),
    },
    setMemory: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          memory: Schema.String,
        }),
      ),
      output: Schema.toStandardSchemaV1(SessionSettings),
    },
    compactToMemory: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          keepLast: optional(Schema.Number),
          note: optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(CompactionSummaryResult),
    },
    setPolicy: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          policy: PolicyTier,
          saveAsDefault: optional(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(SessionSettings),
    },
    setSquad: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          squad: SquadSettings,
          saveAsDefault: optional(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(SessionSettings),
    },
    getKeys: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Array(ProviderKeyInfo)),
    },
    saveKeys: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          keys: Schema.Record(Schema.String, Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Array(ProviderKeyInfo)),
    },
    testProvider: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          provider: Schema.String,
          model: optional(Schema.String),
          effort: optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(ConnectionTestResult),
    },
  },
  events: {
    changed: {
      schema: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: optional(Schema.String),
          settings: optional(SessionSettings),
          defaultCharacter: optional(Schema.String),
          defaultPolicy: optional(PolicyTier),
          defaultSquad: optional(SquadSettings),
          approvalAlert: optional(ApprovalAlert),
        }),
      ),
    },
  },
})

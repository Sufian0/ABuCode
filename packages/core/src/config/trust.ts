export * as ConfigTrust from "./trust.js"

import path from "path"
import { Effect, Option, Record, Schema } from "effect"
import { Config } from "@opencode/schema/config"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { AbsolutePath } from "@opencode/schema/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { ProjectTrust } from "@opencode/util/project-trust"
import { FlagResolve } from "../flag/resolve.js"

// ABuCode: project trust. While the `project_trust` flag is on, a repository's own config applies in full only once its
// folder is listed in the global config folder's trusted-projects.json; until then it runs nothing.

/** A config file from a repository folder that is not trusted. It keeps only the keys `restrict` lists. */
export class Document extends Config.Document.extend<Document>("Config.UntrustedDocument")({}) {}

/** The `.opencode` folder of a repository folder that is not trusted. Its agents and skills load; its plugins and commands do not. */
export class Directory extends Config.Directory.extend<Directory>("Config.UntrustedDirectory")({}) {}

/**
 * The trust list as a config entry, present while project trust is on. It records what config loading decided, so no
 * reader decides again: `trusted` tells whether the location's own folder is trusted, and the held-back entries say
 * which files and folders were held. Clients see it in config.get as an empty document at the list's path.
 */
export class State extends Config.Document.extend<State>("Config.TrustState")({
  trusted: Schema.Boolean,
}) {}

/** The trust state among a location's config entries; none while project trust is off. */
export function state(entries: readonly Config.Entry[]) {
  return entries.find((entry): entry is State => entry instanceof State)
}

/** Whether the location's own folder is held back: project trust is on and the folder is not trusted. */
export function untrusted(entries: readonly Config.Entry[]) {
  return state(entries)?.trusted === false
}

/**
 * Decides which folders among `directories` have their own config held back, and whether `location` is trusted. Nothing
 * is held back unless the owner turned project trust on, which is read from `owner` alone: the documents a repository
 * cannot write, so a repository cannot turn it off.
 */
export const decide = Effect.fn("ConfigTrust.decide")(function* (input: {
  readonly owner: readonly Config.Entry[]
  readonly global: string | undefined
  readonly channel: string
  readonly overrides: string | undefined
  readonly references: Set<string>
  readonly location: string
  readonly directories: readonly string[]
}) {
  const flags = FlagResolve.resolve({ entries: input.owner, channel: input.channel, overrides: input.overrides })
  if (!flags.project_trust.enabled) return { held: new Set<string>(), state: undefined }
  const fs = yield* FSUtil.Service
  const file = input.global === undefined ? undefined : path.join(input.global, ProjectTrust.file)
  // As a config input, the list reloads config when /trust, or an edit by hand, changes it.
  if (file) input.references.add(file)
  const listed = file
    ? Option.getOrElse(
        ProjectTrust.parse(yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))),
        () => [],
      )
    : []
  // Only absolute entries count: a relative one would resolve against wherever the engine runs.
  const trusted = yield* Effect.forEach(
    listed.filter((folder) => path.isAbsolute(folder)),
    (folder) => fs.resolve(folder),
  )
  const covered = (directory: string) =>
    fs.resolve(directory).pipe(Effect.map((real) => ProjectTrust.covering(trusted, real) !== undefined))
  const held = new Set(
    yield* Effect.filter(input.directories, (directory) => covered(directory).pipe(Effect.map((yes) => !yes))),
  )
  return {
    held,
    state: new State({
      type: "document",
      path: file === undefined ? undefined : AbsolutePath.make(file),
      info: new Config.Info({}),
      trusted: yield* covered(input.location),
    }),
  }
})

/**
 * What a held-back repository file keeps: settings that run nothing, contact nothing and loosen nothing. Every other
 * key, including any that a later OpenCode adds, waits until the folder is trusted; so does `default_agent`, so a
 * repository cannot pick the agent you start with.
 */
export function restrict(info: Config.Info) {
  return new Config.Info({
    $schema: info.$schema,
    model: info.model,
    // An agent's own permission rules are applied after every top-level rule, so they could turn an ask into an allow.
    // Removing an agent and defining one with its ID would drop the rules the agent had, so no agent can be removed.
    agents:
      info.agents &&
      Record.map(
        info.agents,
        (agent) => new ConfigAgent.Info({ ...agent, permissions: undefined, request: undefined, disabled: undefined }),
      ),
    // A deny can only restrict. An allow could outrank a deny in a document loaded after this one, such as
    // OPENCODE_CONFIG_CONTENT or the project overlay.
    policies: info.policies?.filter((policy) => policy.effect === "deny"),
    compaction: info.compaction,
    tool_output: info.tool_output,
    watcher: info.watcher,
    media: info.media,
    timezone: info.timezone,
    username: info.username,
  })
}

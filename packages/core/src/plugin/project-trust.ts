export * as ProjectTrustPlugin from "./project-trust.js"

import path from "path"
import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { ProjectTrust } from "@opencode/util/project-trust"
import { Effect, Option } from "effect"
import { Config } from "../config.js"
import { ConfigTrust } from "../config/trust.js"
import { Location } from "../location.js"

// ABuCode: /trust shows whether this project's own config may run code, and adds its folder to the owner's list or
// takes it off. The list is a config input, so a change applies in the background, without a restart.
export const Plugin = define({
  id: "abucode.trust",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const file = path.join(global.config, ProjectTrust.file)

    yield* ctx.command.transform((editor) =>
      editor.add({
        name: "trust",
        description: "show or change whether this project's own config may run code (/trust [status | yes | no])",
        execute: (input) =>
          Effect.gen(function* () {
            const choice = input.prompt.text.trim().toLowerCase()
            const parsed = ProjectTrust.parse(
              yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined)),
            )
            // A list that does not parse trusts nothing, and /trust leaves it for the owner to fix instead of losing it.
            if (Option.isNone(parsed) && (choice === "yes" || choice === "no"))
              return yield* Effect.fail(
                new Error(`${file} is not a list of trusted folders, so /trust leaves it alone. Fix it by hand.`),
              )
            const listed = Option.getOrElse(parsed, () => [])
            // Matched as config loading matches them: absolute entries, by real path. Kept index for index with `listed`.
            const resolved = yield* Effect.forEach(listed, (item) =>
              path.isAbsolute(item) ? fs.resolve(item) : Effect.succeed(undefined),
            )
            const trusted = resolved.filter((item) => item !== undefined)
            // The folder that holds the `.git` or `.hg` entry, or the opened folder: not Git's worktree root, which the
            // repository's own Git settings can move to a parent folder.
            const root = yield* fs.up({ targets: [".git", ".hg"], start: location.directory, mode: "first" }).pipe(
              Effect.map((matches) => matches[0]),
              Effect.orElseSucceed(() => undefined),
            )
            const folder = yield* fs.resolve(root ? path.dirname(root) : location.directory)
            const through = ProjectTrust.covering(trusted, folder)
            const reply = (text: string, description: string) =>
              ctx.session.synthetic({
                sessionID: input.sessionID,
                text,
                description,
                metadata: { source: "abucode.trust" },
                delivery: input.delivery,
              })

            if (choice === "" || choice === "status") {
              const entries = yield* config.entries()
              const held = entries.flatMap((entry) =>
                (entry instanceof ConfigTrust.Document || entry instanceof ConfigTrust.Directory) && entry.path
                  ? [entry.path]
                  : [],
              )
              return yield* Effect.fail(
                new Error(
                  status({
                    on: ConfigTrust.state(entries) !== undefined,
                    folder,
                    through,
                    held,
                    file,
                    global: global.config,
                  }),
                ),
              )
            }

            if (choice === "yes") {
              if (through) return yield* Effect.fail(new Error(`${folder} is already trusted${via(folder, through)}.`))
              if (FSUtil.contains(folder, yield* fs.resolve(global.home)) || path.dirname(folder) === folder)
                return yield* Effect.fail(
                  new Error(
                    `/trust does not trust ${folder}: that would trust your home folder or every project below it. To do so anyway, add it to ${file} by hand.`,
                  ),
                )
              yield* fs.writeWithDirs(file, ProjectTrust.format([...listed, folder]))
              return yield* reply(
                `Trusted **${folder}**. Its own plugins, MCP servers, commands and settings load in the background; restart the terminal to load its terminal plugins too.`,
                `Trusted ${folder}`,
              )
            }

            if (choice === "no") {
              const remaining = listed.filter((_, index) => resolved[index] !== folder)
              if (remaining.length === listed.length)
                return yield* Effect.fail(
                  new Error(
                    through
                      ? `${folder} is trusted through ${through}. /trust no removes only the folder itself; to stop trusting it, remove ${through} from ${file} by hand.`
                      : `${folder} is not trusted.`,
                  ),
                )
              yield* fs.writeWithDirs(file, ProjectTrust.format(remaining))
              const still = ProjectTrust.covering(
                trusted.filter((item) => item !== folder),
                folder,
              )
              return yield* reply(
                still
                  ? `Removed **${folder}** from the trusted folders; it is still trusted through ${still}.`
                  : `**${folder}** is no longer trusted. Its own config is held back again from the next reload; anything one of its plugins already started keeps running until the engine restarts, and its terminal plugins until the terminal restarts.`,
                `No longer trusted: ${folder}`,
              )
            }

            return yield* Effect.fail(new Error("Usage: /trust [status | yes | no]"))
          }),
      }),
    )
  }),
})

function via(folder: string, through: string) {
  return through === folder ? "" : ` through ${through}`
}

function status(input: {
  readonly on: boolean
  readonly folder: string
  readonly through: string | undefined
  readonly held: readonly string[]
  readonly file: string
  readonly global: string
}) {
  if (!input.on)
    return [
      "Project trust is off: every project's own config applies in full, as in stock OpenCode.",
      `To hold back a repository's code until you trust it, set "experimental": { "project_trust": true } in ${path.join(input.global, "opencode.json")}.`,
      ...(input.through ? [`${input.folder} is already listed as trusted${via(input.folder, input.through)}.`] : []),
    ].join("\n")
  const held = input.held.map((item) => `  ${item}`)
  if (input.through)
    return [
      `${input.folder} is trusted${via(input.folder, input.through)}: its own config applies in full.`,
      ...(held.length ? ["Held back, from folders above it that are not trusted:", ...held] : []),
      input.through === input.folder
        ? `/trust no takes it off ${input.file}.`
        : `To stop trusting it, remove ${input.through} from ${input.file} by hand.`,
    ].join("\n")
  return [
    `${input.folder} is not trusted, so its own config runs nothing: plugins, MCP servers, commands, formatters, the shell setting, providers, permission rules and other settings wait. Its instructions, agents and skills apply.`,
    ...(held.length ? ["Held back:", ...held] : ["It has no config of its own to hold back."]),
    "/trust yes trusts it.",
  ].join("\n")
}

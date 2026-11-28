import { afterAll, describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "path"
import { Duration, Effect, Layer, LayerMap, Schedule } from "effect"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { Config } from "@opencode/core/config"
import { ConfigTrust } from "@opencode/core/config/trust"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Formatter } from "@opencode/core/formatter"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Mcp } from "@opencode/core/mcp/index"
import { Plugin } from "@opencode/core/plugin"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { ProjectTrust } from "@opencode/util/project-trust"
import { Bus } from "../../src/bus"
import { Database } from "../../src/database/database"
import { withEnv } from "../fixture/env"
import { initGit } from "../fixture/git"
import { offlineModels } from "../fixture/models"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// One global config folder for the file, so each case can write the owner's config before its project boots. Every
// case rewrites it first, and each boots a project folder of its own.
const root = await tmpdir()
afterAll(() => root[Symbol.asyncDispose]())
const config = path.join(root.path, "config")
const markers = path.join(root.path, "markers")
const list = path.join(config, ProjectTrust.file)
const globalLayer = Global.layerWith({
  home: path.join(root.path, "home"),
  data: path.join(root.path, "data"),
  cache: path.join(root.path, "cache"),
  config,
  state: path.join(root.path, "state"),
  tmp: path.join(root.path, "tmp"),
  bin: path.join(root.path, "cache", "bin"),
  log: path.join(root.path, "data", "log"),
  repos: path.join(root.path, "data", "repos"),
})

const unexpected = (pkg: string) =>
  Effect.fail(new Npm.InstallFailedError({ add: [pkg], dir: "", cause: new Error(`Unexpected Npm call: ${pkg}`) }))

// A real Location boot with config discovery, so each case is the files a repository would ship.
const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const map = yield* LayerMap.make((ref: Location.Ref) => Instance.layer(ref, { replacements: bindings }), {
      idleTimeToLive: Duration.infinity,
    })
    const bindings: LayerNode.Replacements = [
      Global.node.replace(globalLayer),
      offlineModels,
      Npm.node.replace(
        Layer.succeed(
          Npm.Service,
          Npm.Service.of({
            add: unexpected,
            resolve: (name) => Effect.succeed({ directory: "", name }),
            check: () => Effect.succeed(false),
            update: unexpected,
            follows: () => Effect.succeed(false),
            reject: () => Effect.succeed(false),
            which: () => Effect.undefined,
          }),
        ),
      ),
      Watcher.node.replace(Layer.succeed(Watcher.Service, watcher)),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, { provide: (session) => Effect.provide(map.get(session.location)) }),
      ),
    ]

    return map
  }),
).pipe(Layer.provide(Watcher.testLayer))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
    Global.node.replace(globalLayer),
    offlineModels,
    LocationServiceMap.node.replace(instances),
  ]).pipe(Layer.provideMerge(Watcher.testLayer)),
)

// Each plugin adds a command named after itself and leaves a marker when imported; each MCP command leaves one when run.
const plugin = (id: string) =>
  `await Bun.write(${JSON.stringify(path.join(markers, id))}, "")
export default { id: ${JSON.stringify(id)}, async setup(ctx) {
  await ctx.command.transform((editor) => editor.add({ name: ${JSON.stringify(id)}, execute: async () => {} }))
} }`
const marked = (id: string) => [
  process.execPath,
  "-e",
  `require("fs").writeFileSync(${JSON.stringify(path.join(markers, id))}, "")`,
]
const ran = (id: string) => existsSync(path.join(markers, id))

// The owner's own config: one plugin in the global plugin folder, one MCP server, a formatter, and whatever `info`
// adds. The shell's OPENCODE_FLAGS is kept out, so only these files decide the flag.
const owner = (info: Record<string, unknown>) =>
  Effect.promise(async () => {
    await rm(markers, { recursive: true, force: true })
    await rm(list, { force: true })
    await Bun.write(path.join(config, "plugins", "owner-plugin.ts"), plugin("owner-plugin"))
    await Bun.write(
      path.join(config, "opencode.json"),
      JSON.stringify({
        mcp: { servers: { mine: { type: "local", command: marked("owner-mine") } } },
        formatter: { probe: { command: [...marked("formatted"), "$FILE"], extensions: [".probe"] } },
        ...info,
      }),
    )
  })
const trustOn = { experimental: { project_trust: true } }

// A repository that would run code, loosen rules or take over an agent in every way a project's config can.
const repository = (directory: string, extra: Record<string, unknown> = {}) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries({
        ".opencode/plugins/repo-plugin.ts": plugin("repo-plugin"),
        "external/repo-entry/index.ts": plugin("repo-entry"),
        ".opencode/command/repo-command.md": "---\ndescription: repo command\n---\nSay hello.\n",
        ".opencode/agent/repo-agent.md": `---\ndescription: repo agent\npermissions:\n  - action: repo-probe\n    resource: "*"\n    effect: allow\n---\nYou help.\n`,
        "opencode.json": JSON.stringify({
          plugins: [path.join(directory, "external", "repo-entry")],
          mcp: {
            servers: {
              mine: { type: "local", command: marked("repo-mine") },
              theirs: { type: "local", command: marked("repo-theirs") },
            },
          },
          commands: { "repo-key-command": { template: "Say hello." } },
          default_agent: "repo-agent",
          agents: {
            plan: { disabled: true },
            "repo-config-agent": {
              description: "{env:ABUCODE_TRUST_PROBE}",
              permissions: [{ action: "repo-probe", resource: "*", effect: "allow" }],
            },
          },
          policies: [
            { action: "tool.use", resource: "shell:*", effect: "allow" },
            { action: "tool.use", resource: "webfetch:*", effect: "deny" },
          ],
          ...extra,
        }),
      }).map(([file, text]) => Bun.write(path.join(directory, file), text)),
    ),
  )

const inspect = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const commands = yield* Command.Service
  const agents = yield* Agent.Service
  const mcp = yield* Mcp.Service
  const config = yield* Config.Service
  yield* plugins.awaitActivation
  const entries = yield* config.entries()
  const listed = yield* agents.list()
  return {
    commands: (yield* commands.list()).map((command) => command.name),
    agents: listed.map((agent) => String(agent.id)),
    // The agents whose permission rules include the repository's probe rule.
    probed: listed
      .filter((agent) => agent.permissions.some((rule) => rule.action === "repo-probe"))
      .map((agent) => String(agent.id)),
    servers: (yield* mcp.servers()).map((item) => String(item.name)),
    untrusted: entries.flatMap((entry) =>
      entry instanceof ConfigTrust.Document || entry instanceof ConfigTrust.Directory ? [entry] : [],
    ),
    state: ConfigTrust.state(entries),
  }
})

// Runs `effect` in the Location of `directory`, with the shell's OPENCODE_FLAGS kept out.
const inLocation = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
  withEnv({ OPENCODE_FLAGS: undefined }, () =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      return yield* effect.pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )
    }),
  )

// Polls against a real-time deadline: reloads and child processes do work the test clock cannot advance.
const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>, check: (value: A) => boolean) =>
  effect.pipe(Effect.filterOrFail(check), Effect.retry(Schedule.spaced("25 millis")), Effect.timeout("15 seconds"))

// By the time the owner's MCP server ran, a repository server would have run as well.
const serversStarted = eventually(
  Effect.sync(() => ran("owner-mine")),
  (started) => started,
)

describe("project trust", () => {
  it.live("holds back a repository's code-running config until its folder is trusted", () =>
    withEnv({ ABUCODE_TRUST_PROBE: "substituted" }, () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        yield* owner(trustOn)
        yield* repository(directory)
        const state = yield* inLocation(directory, inspect.pipe(Effect.tap(() => serversStarted)))

        // Code from the repository: none of it was imported, run or offered.
        expect(["repo-plugin", "repo-entry"].filter(ran)).toEqual([])
        expect(state.commands).not.toContain("repo-plugin")
        expect(state.commands).not.toContain("repo-entry")
        expect(state.commands).not.toContain("repo-command")
        expect(state.commands).not.toContain("repo-key-command")
        expect(state.servers).not.toContain("theirs")
        // The owner's plugin and MCP server work, and the repository did not replace the owner's server of the same name.
        expect(state.commands).toContain("owner-plugin")
        expect(state.servers).toContain("mine")
        expect(["owner-mine", "repo-mine", "repo-theirs"].filter(ran)).toEqual(["owner-mine"])
        // What runs nothing still applies: the repository's agents, from its folder and from its config file. It cannot
        // remove an agent, and neither its agent file's nor its config file's agent rules apply.
        expect(state.agents).toContain("repo-agent")
        expect(state.agents).toContain("repo-config-agent")
        expect(state.agents).toContain("plan")
        expect(state.probed).toEqual([])
        // The decision is recorded once, for every reader.
        expect(state.state).toMatchObject({ path: list, trusted: false })

        const file = state.untrusted.find((entry) => entry instanceof ConfigTrust.Document)
        expect(file?.path).toBe(AbsolutePath.make(path.join(directory, "opencode.json")))
        expect(state.untrusted.find((entry) => entry instanceof ConfigTrust.Directory)?.path).toBe(
          AbsolutePath.make(path.join(directory, ".opencode")),
        )
        const info = file instanceof ConfigTrust.Document ? file.info : undefined
        expect(info?.plugins).toBeUndefined()
        expect(info?.mcp).toBeUndefined()
        expect(info?.commands).toBeUndefined()
        expect(info?.default_agent).toBeUndefined()
        // A deny can only restrict; the repository's allow is dropped.
        expect(info?.policies).toEqual([{ action: "tool.use", resource: "webfetch:*", effect: "deny" }])
        // {env:} is not substituted into a held-back file.
        expect(info?.agents?.["repo-config-agent"]?.description).toBe("{env:ABUCODE_TRUST_PROBE}")
      }),
    ),
  )

  it.live("applies a repository's config in full once its folder is trusted, and holds it back again after", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* owner(trustOn)
      yield* repository(directory)
      const watcher = yield* Watcher.Test
      const changed = (trusted: readonly string[]) =>
        Effect.promise(() => Bun.write(list, ProjectTrust.format(trusted))).pipe(
          Effect.andThen(watcher.emit({ path: list, type: "update" })),
        )
      const states = yield* inLocation(
        directory,
        Effect.gen(function* () {
          const before = yield* inspect
          yield* changed([directory])
          const trusted = yield* eventually(
            inspect,
            (state) =>
              state.servers.includes("theirs") &&
              ["repo-plugin", "repo-entry", "repo-command", "repo-key-command"].every((name) =>
                state.commands.includes(name),
              ),
          )
          yield* changed([])
          const after = yield* eventually(
            inspect,
            (state) => !state.commands.includes("repo-plugin") && !state.servers.includes("theirs"),
          )
          return { before, trusted, after }
        }),
      )

      expect(states.before.commands).not.toContain("repo-plugin")
      expect(states.trusted.probed.toSorted()).toEqual(["repo-agent", "repo-config-agent"])
      expect(states.trusted.untrusted).toEqual([])
      expect(states.trusted.state).toMatchObject({ trusted: true })
      expect(states.after.commands).not.toContain("repo-command")
      expect(states.after.state).toMatchObject({ trusted: false })
    }),
  )

  it.live("cannot be turned off by the repository's own config", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* owner(trustOn)
      yield* repository(directory, { experimental: { project_trust: false, all_flags: false } })
      const state = yield* inLocation(directory, inspect)

      expect(ran("repo-plugin")).toBe(false)
      expect(state.commands).not.toContain("repo-command")
    }),
  )

  it.live("trusts a folder and those below it, not the folders above it", () =>
    Effect.gen(function* () {
      const outer = (yield* tmpdirScoped()).path
      const inner = path.join(outer, "inner")
      yield* owner(trustOn)
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(outer, ".opencode", "plugins", "outer-plugin.ts"), plugin("outer-plugin")),
          Bun.write(path.join(inner, ".opencode", "plugins", "inner-plugin.ts"), plugin("inner-plugin")),
          Bun.write(path.join(inner, "sub", "README.md"), "A folder inside the trusted one.\n"),
          // An entry that is not absolute trusts nothing, wherever the engine runs.
          Bun.write(list, ProjectTrust.format([inner, "outer"])),
        ]),
      )
      const state = yield* inLocation(path.join(inner, "sub"), inspect)

      expect(["outer-plugin", "inner-plugin"].filter(ran)).toEqual(["inner-plugin"])
      expect(state.untrusted.map((entry) => entry.path)).toEqual([AbsolutePath.make(path.join(outer, ".opencode"))])
      expect(state.state).toMatchObject({ trusted: true })
    }),
  )

  // Built-in formatters run the repository's own tools, and a formatter can load the repository's config files.
  it.live("runs no formatter in a project that is not trusted", () =>
    Effect.gen(function* () {
      const untrusted = (yield* tmpdirScoped()).path
      const trusted = (yield* tmpdirScoped()).path
      yield* owner(trustOn)
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(untrusted, "note.probe"), "text\n"),
          Bun.write(path.join(trusted, "note.probe"), "text\n"),
          Bun.write(list, ProjectTrust.format([trusted])),
        ]),
      )
      const format = (directory: string) =>
        inLocation(
          directory,
          Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const formatter = yield* Formatter.Service
            const access = yield* FileAccess.Service
            yield* plugins.awaitActivation
            return yield* formatter.file(yield* access.resolve({ path: path.join(directory, "note.probe") }))
          }),
        )

      yield* format(untrusted)
      expect(ran("formatted")).toBe(false)
      yield* format(trusted)
      expect(ran("formatted")).toBe(true)
    }),
  )

  // A project ID can come from the repository itself (`.git/opencode` in a checkout without an origin remote), and the
  // project overlay folder is named after it.
  it.live("takes no project overlay from a project ID that leads out of the overlay folder", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* owner({ experimental: { project_trust: true, project_overlay: true } })
      yield* Effect.promise(async () => {
        await initGit(directory)
        await Bun.write(
          path.join(directory, ".git", "opencode"),
          path.relative(path.join(config, "project"), path.join(directory, "overlay")),
        )
        await Bun.write(path.join(directory, "overlay", "plugins", "overlay-plugin.ts"), plugin("overlay-plugin"))
      })
      const state = yield* inLocation(directory, inspect)

      expect(ran("overlay-plugin")).toBe(false)
      expect(state.commands).not.toContain("overlay-plugin")
    }),
  )

  it.live("changes nothing while the flag is off", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* owner({})
      yield* repository(directory)
      const state = yield* inLocation(directory, inspect)

      expect(["repo-plugin", "repo-entry"].filter(ran)).toEqual(["repo-plugin", "repo-entry"])
      expect(state.commands).toContain("repo-command")
      expect(state.untrusted).toEqual([])
      expect(state.state).toBeUndefined()
    }),
  )
})

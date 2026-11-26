import { describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "path"
import { Duration, Effect, Layer, LayerMap, Schedule } from "effect"
import { Command } from "@opencode/core/command"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { Plugin } from "@opencode/core/plugin"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Npm } from "@opencode/util/npm"
import { Bus } from "../../src/bus"
import { Database } from "../../src/database/database"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const id = Plugin.ID.make("abucode.core")

const unexpected = (pkg: string) =>
  Effect.fail(new Npm.InstallFailedError({ add: [pkg], dir: "", cause: new Error(`Unexpected Npm call: ${pkg}`) }))

// A real Location boot with config discovery, so each case is the files a repository, or the agent, would write.
const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const map = yield* LayerMap.make((ref: Location.Ref) => Instance.layer(ref, { replacements: bindings }), {
      idleTimeToLive: Duration.infinity,
    })
    const bindings: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
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
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    LocationServiceMap.node.replace(instances),
  ]).pipe(Layer.provideMerge(Watcher.testLayer)),
)

const project = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      Promise.all(Object.entries(files).map(([file, text]) => Bun.write(path.join(directory.path, file), text))),
    )

    return Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
  })

describe("ABuCode plugin guard", () => {
  // The plugin enforces the fork's policy tiers and its secret-file and network guards, and the agent can write a
  // repository's opencode.json. Before the plugin was guarded, each of these entries unloaded it.
  for (const target of ["abucode.core", "abucode.*", "*"]) {
    it.live(`keeps the ABuCode plugin active through "-${target}"`, () =>
      Effect.gen(function* () {
        const ref = yield* project({
          "opencode.json": JSON.stringify({ plugins: [`-${target}`, `-${ConfigAgentPlugin.Plugin.id}`] }),
        })
        const locations = yield* LocationServiceMap.Service
        const inventory = yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation

          return yield* plugins.list()
        }).pipe(Effect.scoped, Effect.provide(locations.get(ref)))
        const status = (plugin: string) => inventory.find((item) => item.id === plugin)?.state.status

        expect(status(id)).toBe("active")
        // The removals did apply: a built-in that is not guarded is gone.
        expect(status(ConfigAgentPlugin.Plugin.id)).toBeUndefined()
      }),
    )
  }

  it.live("keeps the built-in ABuCode plugin when a project plugin declares its ID", () =>
    Effect.gen(function* () {
      const ref = yield* project({
        ".opencode/plugin/impostor.ts": `export default { id: "${id}", async setup() {} }`,
      })
      const locations = yield* LocationServiceMap.Service
      const state = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation

        return { inventory: yield* plugins.list(), policy: yield* commands.get("policy") }
      }).pipe(Effect.scoped, Effect.provide(locations.get(ref)))

      expect(state.inventory.filter((plugin) => plugin.id === id).map((plugin) => plugin.source.type)).toEqual([
        "builtin",
      ])
      expect(state.inventory.find((plugin) => plugin.source.type === "local")?.state).toEqual({
        status: "failed",
        error: `Plugin ID ${id} is reserved for a built-in plugin`,
      })
      // The built-in's commands are registered, so its hooks are too.
      expect(state.policy).toBeDefined()
    }),
  )

  // A command file's shell snippets run without a permission request, a Policy tier or the environment scrub, so a
  // repository's /policy must not answer in place of the fork's.
  it.live("keeps the ABuCode plugin's commands when a project command file takes the same name", () =>
    Effect.gen(function* () {
      const names = ["character", "squad", "keys", "memory", "archive", "policy"]
      const files = (description: string) =>
        Object.fromEntries(
          [...names, "hello"].map((name) => [
            `.opencode/command/${name}.md`,
            `---\ndescription: ${description}\n---\nSay hello.`,
          ]),
        )
      const ref = yield* project(files("project command"))
      const watcher = yield* Watcher.Test
      const locations = yield* LocationServiceMap.Service
      const listed = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation
        const boot = yield* commands.list()

        // A command file that changes mid-session reloads the commands; the fork's must still win afterwards.
        yield* Effect.forEach(Object.entries(files("changed command")), ([file, text]) =>
          Effect.promise(() => Bun.write(path.join(ref.directory, file), text)).pipe(
            Effect.andThen(watcher.emit({ path: path.join(ref.directory, file), type: "update" })),
          ),
        )
        const reloaded = yield* commands.list().pipe(
          Effect.filterOrFail((list) => list.some((command) => command.description === "changed command")),
          Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
        )

        return { boot, reloaded }
      }).pipe(Effect.scoped, Effect.provide(locations.get(ref)))
      const replaced = (list: readonly Command.Info[], description: string) =>
        names.filter((name) => list.find((command) => command.name === name)?.description === description)

      // The project's command files do load: one with a name of its own is listed.
      expect(listed.boot.find((command) => command.name === "hello")?.description).toBe("project command")
      expect(replaced(listed.boot, "project command")).toEqual([])
      expect(listed.reloaded.find((command) => command.name === "hello")?.description).toBe("changed command")
      expect(replaced(listed.reloaded, "changed command")).toEqual([])
    }),
  )
})

describe("plugin.use policies", () => {
  // ABUCODE.md's stop-gap denies every plugin from config except the owner's own plugin folder, allowed by path. A
  // plugin path is compared once its `..` segments are resolved, so a path that starts in an allowed folder and leaves
  // it is not allowed.
  it.live("matches a plugin path against an allowed folder after resolving `..`", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const allowed = path.join(directory, "allowed")
      const marker = (name: string) => path.join(directory, `${name}.imported`)
      const source = (name: string) =>
        `await Bun.write(${JSON.stringify(marker(name))}, ""); export default { id: "${name}", async setup() {} }`
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(allowed, "inside", "index.ts"), source("inside")),
          Bun.write(path.join(directory, "outside", "index.ts"), source("outside")),
          Bun.write(
            path.join(directory, "opencode.json"),
            JSON.stringify({
              plugins: [path.join(allowed, "inside"), `${allowed}/../outside`],
              policies: [
                { action: "plugin.use", resource: "*", effect: "deny" },
                { action: "plugin.use", resource: `${allowed}/*`, effect: "allow" },
              ],
            }),
          ),
        ]),
      )
      const locations = yield* LocationServiceMap.Service
      const inventory = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation

        return yield* plugins.list()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      )

      expect(inventory.filter((plugin) => plugin.source.type !== "builtin").map((plugin) => plugin.id)).toEqual([
        Plugin.ID.make("inside"),
      ])
      expect(existsSync(marker("inside"))).toBe(true)
      expect(existsSync(marker("outside"))).toBe(false)
    }),
  )
})

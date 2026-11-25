import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap, Stream } from "effect"
import { ConfigAgentPlugin } from "@opencode/core/config/plugin/agent"
import { ConfigPluginSource } from "@opencode/core/config/plugin/source"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
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

const unexpected = (pkg: string) =>
  Effect.fail(new Npm.InstallFailedError({ add: [pkg], dir: "", cause: new Error(`Unexpected Npm call: ${pkg}`) }))

// A server whose config removes `targets`, the way `"plugins": ["-<target>"]` in a repository's opencode.json does.
const removing = (targets: readonly string[]) => {
  const instances = Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* LayerMap.make(
        (ref: Location.Ref) => Instance.layer(ref, { discovery: false, replacements: bindings }),
        { idleTimeToLive: Duration.infinity },
      )
      const bindings: LayerNode.Replacements = [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        ConfigPluginSource.node.replace(
          Layer.succeed(
            ConfigPluginSource.Service,
            ConfigPluginSource.Service.of({
              operations: () =>
                Effect.succeed(targets.map((target): ConfigPluginSource.Operation => ({ type: "remove", target }))),
              changes: () => Stream.never,
            }),
          ),
        ),
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
        LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
        Instance.node.replace(
          Layer.succeed(Instance.Service, { provide: (session) => Effect.provide(map.get(session.location)) }),
        ),
      ]

      return map
    }),
  )

  return testEffect(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      LocationServiceMap.node.replace(instances),
    ]),
  )
}

describe("ABuCode plugin guard", () => {
  // The plugin enforces the fork's policy tiers and its secret-file and network guards, and the agent can write a
  // repository's opencode.json. Before the plugin was guarded, each of these entries unloaded it.
  for (const target of ["abucode.core", "abucode.*", "*"]) {
    removing([target, ConfigAgentPlugin.Plugin.id]).effect(`keeps the ABuCode plugin active through "-${target}"`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const locations = yield* LocationServiceMap.Service
        const inventory = yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation

          return yield* plugins.list()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
        const status = (id: string) => inventory.find((plugin) => plugin.id === id)?.state.status

        expect(status("abucode.core")).toBe("active")
        // The removals did apply: a built-in that is not guarded is gone.
        expect(status(ConfigAgentPlugin.Plugin.id)).toBeUndefined()
      }),
    )
  }
})

import { describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { Bus } from "@opencode/core/bus"
import { Command } from "@opencode/core/command"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance/service"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { ProjectTrust } from "@opencode/util/project-trust"
import { Cause, Effect, Exit, Layer } from "effect"
import { initGit } from "../fixture/git"
import { offlineModels } from "../fixture/models"
import { disabledPersistentPtyLayer } from "../fixture/persistent-pty"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Each case gets its own home and global config folder, so the list it writes cannot reach another case.
const isolatedGlobal = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const data = path.join(tmp.path, "data")
      const cache = path.join(tmp.path, "cache")
      return Global.layerWith({
        home: path.join(tmp.path, "home"),
        data,
        cache,
        config: path.join(tmp.path, "config"),
        state: path.join(tmp.path, "state"),
        tmp: path.join(tmp.path, "tmp"),
        bin: path.join(cache, "bin"),
        log: path.join(data, "log"),
        repos: path.join(data, "repos"),
      })
    }),
  ),
)

// Real sessions, because /trust answers in the session it was typed in.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Bus.node, Database.node, Global.node, Instance.node, Session.node]), [
    Global.node.replace(isolatedGlobal),
    offlineModels,
    PersistentPty.node.replace(disabledPersistentPtyLayer),
    SessionExecution.node.replace(Layer.mock(SessionExecution.Service, { wake: () => Effect.void })),
  ]),
)

// Opens a session in `directory`, waits for its plugins and runs `effect` there.
const inSession = <A, E, R>(directory: string, effect: (sessionID: Session.ID) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* Instance.Service
    const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      return yield* effect(session.id)
    }).pipe(instances.provide(session))
  })

const trust = (directory: string, text: string) =>
  inSession(directory, (sessionID) =>
    Command.Service.use((commands) =>
      commands.execute({ name: "trust", invocation: { sessionID, prompt: { text }, delivery: "steer" } }),
    ).pipe(Effect.exit),
  )

// What /trust answered with when it refused, or showed a status: the fork's commands report those as failures.
const message = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "")

// The owner turns project trust on; the project ships one plugin that leaves a marker when it is imported.
const setup = Effect.gen(function* () {
  const global = yield* Global.Service
  const directory = (yield* tmpdirScoped()).path
  const marker = path.join(directory, "imported")
  yield* Effect.promise(() =>
    Promise.all([
      Bun.write(path.join(global.config, "opencode.json"), JSON.stringify({ experimental: { project_trust: true } })),
      Bun.write(
        path.join(directory, ".opencode", "plugins", "repo.ts"),
        `await Bun.write(${JSON.stringify(marker)}, ""); export default { id: "repo", async setup() {} }`,
      ),
      Bun.write(path.join(directory, "sub", "README.md"), "A folder of the project.\n"),
    ]),
  )
  return { directory, marker, list: path.join(global.config, ProjectTrust.file), home: global.home }
})

const listed = (file: string) =>
  Effect.promise(() =>
    Bun.file(file)
      .text()
      .catch(() => undefined),
  )

describe("/trust", () => {
  it.live("reports a project that is not trusted and what it holds back", () =>
    Effect.gen(function* () {
      const project = yield* setup
      const exit = yield* trust(project.directory, "")

      expect(message(exit)).toContain(`${project.directory} is not trusted`)
      expect(message(exit)).toContain(path.join(project.directory, ".opencode"))
      expect(existsSync(project.marker)).toBe(false)
    }),
  )

  it.live("trusts the project's folder, which a later boot applies, and takes it off again", () =>
    Effect.gen(function* () {
      const project = yield* setup
      const yes = yield* trust(project.directory, "yes")

      expect(yes._tag).toBe("Success")
      expect(yield* listed(project.list)).toBe(ProjectTrust.format([project.directory]))
      // A location booted after the change reads the list: the project's plugin is active there.
      const active = yield* inSession(path.join(project.directory, "sub"), () =>
        Plugin.Service.use((plugins) => plugins.list()).pipe(
          Effect.map((list) => list.some((plugin) => String(plugin.id) === "repo" && plugin.state.status === "active")),
        ),
      )
      expect(active).toBe(true)

      const again = yield* trust(project.directory, "yes")
      expect(message(again)).toContain("already trusted")

      const no = yield* trust(project.directory, "no")
      expect(no._tag).toBe("Success")
      expect(yield* listed(project.list)).toBe(ProjectTrust.format([]))
    }),
  )

  it.live("does not trust the home folder or a folder above it", () =>
    Effect.gen(function* () {
      const project = yield* setup
      yield* Effect.promise(() => mkdir(project.home, { recursive: true }))
      const home = yield* trust(project.home, "yes")
      const above = yield* trust(path.dirname(project.home), "yes")

      expect(message(home)).toContain("does not trust")
      expect(message(above)).toContain("does not trust")
      expect(yield* listed(project.list)).toBeUndefined()
    }),
  )

  it.live("keeps the entries it does not use when it adds a folder", () =>
    Effect.gen(function* () {
      const project = yield* setup
      yield* Effect.promise(() => Bun.write(project.list, ProjectTrust.format(["relative/entry"])))
      const yes = yield* trust(project.directory, "yes")

      expect(yes._tag).toBe("Success")
      expect(yield* listed(project.list)).toBe(ProjectTrust.format(["relative/entry", project.directory]))
    }),
  )

  // Git reports a checkout's root from the repository's own settings, which can name a parent folder.
  it.live("trusts the folder that holds the .git entry, not a root the repository's Git settings name", () =>
    Effect.gen(function* () {
      const project = yield* setup
      yield* Effect.promise(async () => {
        await initGit(project.directory)
        await appendFile(path.join(project.directory, ".git", "config"), "[core]\n\tworktree = ../..\n")
      })
      const yes = yield* trust(project.directory, "yes")

      expect(yes._tag).toBe("Success")
      expect(yield* listed(project.list)).toBe(ProjectTrust.format([project.directory]))
    }),
  )

  // The status reports what config loading decided from the owner's files, whatever the repository's own file says.
  it.live("reports the owner's decision, not the repository's experimental settings", () =>
    Effect.gen(function* () {
      const project = yield* setup
      const global = yield* Global.Service
      const projectConfig = path.join(project.directory, "opencode.json")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(projectConfig, JSON.stringify({ experimental: { part_rows: false } })),
          Bun.write(project.list, ProjectTrust.format([project.directory])),
        ]),
      )
      const trusted = yield* trust(project.directory, "")
      // A location booted after these writes reads them: the owner's flag is off, and the repository claims it is on.
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(global.config, "opencode.json"), "{}"),
          Bun.write(projectConfig, JSON.stringify({ experimental: { project_trust: true } })),
        ]),
      )
      const off = yield* trust(path.join(project.directory, "sub"), "")

      // On, and trusted: the project's own experimental block does not turn it off.
      expect(message(trusted)).toContain(`${project.directory} is trusted`)
      // Off for the owner: the repository's own project_trust: true does not turn it on.
      expect(message(off)).toContain("Project trust is off")
    }),
  )

  // A list the owner edited by hand into something that does not parse trusts nothing, and is not overwritten.
  it.live("leaves a list it cannot read as it is", () =>
    Effect.gen(function* () {
      const project = yield* setup
      const broken = '{ "trusted": ["/somewhere",] }\n'
      yield* Effect.promise(() => Bun.write(project.list, broken))
      const exit = yield* trust(project.directory, "yes")

      expect(message(exit)).toContain("is not a list of trusted folders")
      expect(yield* listed(project.list)).toBe(broken)
      expect(existsSync(project.marker)).toBe(false)
    }),
  )
})

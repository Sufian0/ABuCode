import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { FileWrite } from "@opencode/core/file-write"
import { Instance } from "@opencode/core/instance/service"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { systemConfigDirectory } from "@opencode/plugin-abucode/security"
import { AbsolutePath } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Effect, Exit, Fiber, Layer, Option, Schedule } from "effect"
import { offlineModels } from "../fixture/models"
import { disabledPersistentPtyLayer } from "../fixture/persistent-pty"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Each test gets its own home and config folders, so a regression cannot leave a plugin in the run's shared config folder,
// or in a real one that ABUCODE_CONFIG_DIR points at.
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

// A real Location and session, so a write goes through FileWrite, the permission service and the ABuCode plugin's hook.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Bus.node, Database.node, Global.node, Instance.node, Session.node]), [
    Global.node.replace(isolatedGlobal),
    offlineModels,
    PersistentPty.node.replace(disabledPersistentPtyLayer),
    SessionExecution.node.replace(Layer.mock(SessionExecution.Service, { wake: () => Effect.void })),
  ]),
)

// Runs `write` in a session opened in `directory`, after the plugins have activated.
const inSession = <A, E>(
  directory: string,
  write: (
    files: FileWrite.Interface,
    context: FileAccess.Invocation,
  ) => Effect.Effect<A, E, Permission.Service | Global.Service | PluginHooks.Service>,
  agent = Agent.defaultID,
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
    const instances = yield* Instance.Service

    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const files = yield* FileWrite.Service
      const context = {
        sessionID: session.id,
        agent,
        messageID: SessionMessage.ID.make("msg_abucode_config_edit"),
        id: Tool.CallID.make("call_abucode_config_edit"),
      }

      return yield* write(files, context)
    }).pipe(instances.provide(session))
  })

const writeProbe = (files: FileWrite.Interface, context: FileAccess.Invocation, file: string) =>
  files.write({ path: file, content: "export default {}\n" }, context)

// Runs the plugin's tool hook as the shell tool does before it starts a command; the command itself never runs.
const shellHook = (context: FileAccess.Invocation, input: { readonly command: string; readonly workdir?: string }) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.trigger("tool", "execute.before", {
      tool: "shell",
      codemode: false,
      sessionID: context.sessionID,
      agent: context.agent,
      messageID: context.messageID,
      id: context.id,
      input,
    })
  })

// Starts `attempt`, waits for its permission requests, rejects them, and reports what happened to `file`.
const rejectRequests = <A, E, R>(context: FileAccess.Invocation, file: string, attempt: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* attempt.pipe(Effect.exit, Effect.forkChild)
    const asks = yield* permission
      .forSession(context.sessionID)
      .pipe(
        Effect.repeat({ until: (list) => list.length > 0, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("10 seconds"),
      )
    const writtenWhileAsking = existsSync(file)
    yield* Effect.forEach(asks, (ask) => permission.reply({ requestID: ask.id, reply: "reject" }), { discard: true })
    const exit = yield* Fiber.join(fiber)

    return {
      asks: asks.map((ask) => ({ action: ask.action, message: ask.message })),
      writtenWhileAsking,
      rejected: Exit.isFailure(exit),
    }
  })

const asked = {
  asks: [{ action: "edit", message: expect.stringMatching(/^ABuCode asks before any edit to engine config/) }],
  writtenWhileAsking: false,
  rejected: true,
}

describe("ABuCode config edit guard", () => {
  // The plugin keeps a copy of core's system config folder, because plugins cannot import core.
  test("guards the same system config folder as core on every platform", () => {
    const platforms = ["darwin", "linux", "win32"] as const
    const env = { ProgramData: "D:\\Data" }

    expect(platforms.map((platform) => systemConfigDirectory(platform, env))).toEqual(
      platforms.map((platform) => ConfigDiscovery.systemDirectory(platform, env)),
    )
  })

  it.live("asks before a write to engine config and writes nothing until it is approved", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const code = yield* files.write({ path: "src/app.ts", content: "export {}\n" }, context).pipe(Effect.exit)
          const afterCode = yield* permission.forSession(context.sessionID)
          const file = path.join(directory, ".opencode/plugin/probe.ts")
          const config = yield* rejectRequests(context, file, writeProbe(files, context, file))

          return { code: Exit.isSuccess(code), afterCode: afterCode.length, config }
        }),
      )

      expect(result).toEqual({ code: true, afterCode: 0, config: asked })
      expect(existsSync(path.join(directory, ".opencode/plugin/probe.ts"))).toBe(false)
    }),
  )

  it.live("asks for engine config reached from a session inside a .opencode folder", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* Effect.promise(() => mkdir(path.join(directory, ".opencode"), { recursive: true }))
      const file = path.join(directory, ".opencode/plugins/probe.ts")
      const result = yield* inSession(path.join(directory, ".opencode"), (files, context) =>
        rejectRequests(context, file, writeProbe(files, context, file)),
      )

      expect(result).toEqual(asked)
    }),
  )

  it.live("asks before a write to the global config folder", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const file = path.join(global.config, "plugin", "probe.ts")

          return yield* rejectRequests(context, file, writeProbe(files, context, file))
        }),
      )

      expect(result).toEqual(asked)
    }),
  )

  // The plugin's tool hook recognizes the shell tool by these names.
  test("matches the shell tool's name and input fields", () => {
    expect(ShellTool.name).toBe("shell")
    expect(Object.keys(ShellTool.Input.fields)).toEqual(expect.arrayContaining(["command", "workdir"]))
  })

  it.live("asks before a shell command writes engine config, also through its working folder", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, ".opencode/plugins/probe.ts")
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const code = yield* shellHook(context, { command: "echo hi > notes.txt" }).pipe(Effect.exit)
          const afterCode = yield* permission.forSession(context.sessionID)
          const redirect = yield* rejectRequests(
            context,
            file,
            shellHook(context, { command: "echo x > .opencode/plugins/probe.ts" }),
          )
          const workdir = yield* rejectRequests(
            context,
            file,
            shellHook(context, { command: "cp /tmp/probe.ts probe.ts", workdir: ".opencode/plugins" }),
          )

          return { code: Exit.isSuccess(code), afterCode: afterCode.length, redirect, workdir }
        }),
      )

      expect(result).toEqual({ code: true, afterCode: 0, redirect: asked, workdir: asked })
    }),
  )

  // The shell check names files the way the file tools do, so a project-relative deny rule refuses the write outright.
  it.live("lets a project's deny rule refuse a shell command's config write without asking", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({ permission: { edit: { ".opencode/*": "deny" } } }),
        ),
      )
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          // A prompt instead of the refusal would wait forever; the deadline turns that into a failure.
          const exit = yield* shellHook(context, { command: "echo x > .opencode/plugins/probe.ts" }).pipe(
            Effect.timeout("5 seconds"),
            Effect.exit,
          )

          return {
            error: Option.getOrUndefined(Exit.findErrorOption(exit)),
            pending: (yield* permission.forSession(context.sessionID)).length,
          }
        }),
      )

      expect(result.error).toMatchObject({ error: expect.any(Permission.BlockedError) })
      expect(result.pending).toBe(0)
    }),
  )

  it.live("refuses a shell command that writes engine config in unattended work", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const exit = yield* shellHook(context, { command: "echo '{}' > opencode.json" }).pipe(
            Effect.provideService(Permission.Unattended, [{ action: "*", resource: "*", effect: "allow" }]),
            Effect.timeout("5 seconds"),
            Effect.exit,
          )

          return {
            error: Option.getOrUndefined(Exit.findErrorOption(exit)),
            pending: (yield* permission.forSession(context.sessionID)).length,
          }
        }),
      )

      expect(result.error).toMatchObject({ error: expect.any(Permission.BlockedError) })
      expect(result.error).toMatchObject({
        message: expect.stringMatching(/^ABuCode refuses edits to engine config in unattended work/),
      })
      expect(result.pending).toBe(0)
    }),
  )

  // An automation run approves whole actions such as `edit *`; core would settle the plugin's ask from that grant.
  it.live("refuses a write to engine config in unattended work", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "opencode.json")
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const exit = yield* files
            .write({ path: file, content: "{}\n" }, context)
            .pipe(
              Effect.provideService(Permission.Unattended, [{ action: "edit", resource: "*", effect: "allow" }]),
              Effect.exit,
            )

          return {
            error: Option.getOrUndefined(Exit.findErrorOption(exit)),
            pending: (yield* permission.forSession(context.sessionID)).length,
          }
        }),
      )

      expect(result.error).toBeInstanceOf(Permission.BlockedError)
      expect(result.error).toMatchObject({
        reason: expect.stringMatching(/^ABuCode refuses edits to engine config in unattended work/),
      })
      expect(result.pending).toBe(0)
      expect(existsSync(file)).toBe(false)
    }),
  )

  it.live("lets the Plan agent write its plans without asking", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(
        directory,
        (files, context) =>
          Effect.gen(function* () {
            const global = yield* Global.Service
            const permission = yield* Permission.Service
            const plan = path.join(global.home, ".opencode", "plan", "abucode-config-edit.md")
            const exit = yield* files.write({ path: plan, content: "# Plan\n" }, context).pipe(Effect.exit)

            return { written: Exit.isSuccess(exit), pending: (yield* permission.forSession(context.sessionID)).length }
          }),
        Agent.ID.make("plan"),
      )

      expect(result).toEqual({ written: true, pending: 0 })
    }),
  )
})

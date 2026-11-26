import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, rename, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { ConfigDiscovery } from "@opencode/core/config/discovery"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { FileWrite } from "@opencode/core/file-write"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { ShellTool } from "@opencode/core/tool/plugin/shell"
import { WorktreeStrategies } from "@opencode/core/worktree/strategies"
import { sessionMoveDestination, systemConfigDirectory } from "@opencode/plugin-abucode/security"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { Effect, Exit, Fiber, Layer, Option, Schedule } from "effect"
import { initGit } from "../fixture/git"
import { offlineModels } from "../fixture/models"
import { disabledPersistentPtyLayer } from "../fixture/persistent-pty"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

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
  ) => Effect.Effect<
    A,
    E,
    | FileAccess.Service
    | Global.Service
    | Location.Service
    | Permission.Service
    | PluginHooks.Service
    | Tool.Service
    | WorktreeStrategies.Service
  >,
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

// Runs the plugins' tool hooks as core does before it runs a tool; the tool itself never runs.
const toolHook = (context: FileAccess.Invocation, tool: string, input: unknown) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.trigger("tool", "execute.before", {
      tool,
      codemode: false,
      sessionID: context.sessionID,
      agent: context.agent,
      messageID: context.messageID,
      id: context.id,
      input,
    })
  })

const shellHook = (context: FileAccess.Invocation, input: { readonly command: string; readonly workdir?: string }) =>
  toolHook(context, "shell", input)

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

  // The plugin keeps a copy of how core's session move tool reads the folder it is given.
  test("reads a session move's folder as core's move tool does", () => {
    const base = path.resolve("/work/repo")
    const home = path.resolve("/home/user")
    const folders = ["~", "~/other", "../sibling", "sub/folder", "/elsewhere", "~user", "C:/work", "/c/work"]

    expect(folders.map((folder) => sessionMoveDestination(base, folder, home))).toEqual(
      folders.map((folder) => FileAccess.resolvePath(base, folder, home)),
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

const outsideAsked = {
  asks: [{ action: "edit", message: expect.stringMatching(/^ABuCode asks before any edit outside this project/) }],
  writtenWhileAsking: false,
  rejected: true,
}

const moveAsked = {
  asks: [
    {
      action: "session-move",
      message: expect.stringMatching(/^ABuCode asks before a session moves out of its project/),
    },
  ],
  writtenWhileAsking: false,
  rejected: true,
}

// Creating links needs extra rights on Windows.
const withLinks = process.platform === "win32" ? it.live.skip : it.live

describe("ABuCode outside-project edit guard", () => {
  it.live("asks before a write outside the project and writes nothing until it is approved", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const file = path.join(global.home, ".zshenv")

          return yield* rejectRequests(context, file, writeProbe(files, context, file))
        }),
      )

      expect(result).toEqual(outsideAsked)
    }),
  )

  it.live("does not ask for edits elsewhere in the session's repository, or for reads outside it", () =>
    Effect.gen(function* () {
      const repository = (yield* tmpdirScoped()).path
      yield* Effect.promise(() => initGit(repository))
      const directory = path.join(repository, "packages", "app")
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const global = yield* Global.Service
          const permission = yield* Permission.Service
          const outsideFile = path.join(global.home, "notes.txt")
          yield* Effect.promise(() => mkdir(global.home, { recursive: true }))
          yield* Effect.promise(() => writeFile(outsideFile, "notes\n"))
          // A prompt instead would wait forever; the deadline turns that into a failure.
          const edits = yield* Effect.all([
            files.write({ path: "src/app.ts", content: "export {}\n" }, context),
            files.write({ path: path.join(repository, "README.md"), content: "# App\n" }, context),
          ]).pipe(Effect.timeout("5 seconds"), Effect.exit)
          const read = yield* access.authorizeRead(outsideFile, context).pipe(Effect.timeout("5 seconds"), Effect.exit)

          return {
            edits: Exit.isSuccess(edits),
            read: Exit.isSuccess(read),
            pending: (yield* permission.forSession(context.sessionID)).length,
          }
        }),
      )

      expect(result).toEqual({ edits: true, read: true, pending: 0 })
    }),
  )

  // An automation run approves whole actions such as `edit *`; core would settle the plugin's ask from that grant.
  it.live("refuses a write outside the project in unattended work", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const permission = yield* Permission.Service
          const file = path.join(global.home, ".gitconfig")
          const exit = yield* writeProbe(files, context, file).pipe(
            Effect.provideService(Permission.Unattended, [{ action: "edit", resource: "*", effect: "allow" }]),
            Effect.exit,
          )

          return {
            error: Option.getOrUndefined(Exit.findErrorOption(exit)),
            pending: (yield* permission.forSession(context.sessionID)).length,
            written: existsSync(file),
          }
        }),
      )

      expect(result.error).toBeInstanceOf(Permission.BlockedError)
      expect(result.error).toMatchObject({
        reason: expect.stringMatching(/^ABuCode refuses edits outside the project in unattended work/),
      })
      expect(result).toMatchObject({ pending: 0, written: false })
    }),
  )

  withLinks("asks before a write that a link in the project leads outside it", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          yield* Effect.promise(() => mkdir(global.home, { recursive: true }))
          yield* Effect.promise(() => symlink(global.home, path.join(directory, "linked")))
          // A write through a link whose target does not exist yet creates that target.
          yield* Effect.promise(() => symlink(path.join(global.home, ".gitconfig"), path.join(directory, "notes.md")))
          const throughFolder = yield* rejectRequests(
            context,
            path.join(global.home, ".zshenv"),
            writeProbe(files, context, "linked/.zshenv"),
          )
          const throughFile = yield* rejectRequests(
            context,
            path.join(global.home, ".gitconfig"),
            writeProbe(files, context, "notes.md"),
          )

          return { throughFolder, throughFile }
        }),
      )

      expect(result).toEqual({ throughFolder: outsideAsked, throughFile: outsideAsked })
    }),
  )

  it.live("asks once for a patch that also changes a file outside the project, and names only that file", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const registry = yield* Tool.Service
          const file = path.join(global.home, ".zshenv")
          const patchText = [
            "*** Begin Patch",
            "*** Add File: src/app.ts",
            "+export {}",
            `*** Add File: ${file}`,
            "+export PATH=/tmp/probe:$PATH",
            "*** End Patch",
          ].join("\n")

          return yield* rejectRequests(
            context,
            file,
            executeTool(registry, {
              sessionID: context.sessionID,
              agent: context.agent,
              messageID: context.messageID,
              call: { type: "tool-call", id: context.id, name: "patch", input: { patchText } },
            }),
          )
        }),
      )

      expect(result).toEqual({
        ...outsideAsked,
        asks: [
          {
            action: "edit",
            message: expect.stringMatching(/^ABuCode asks before any edit outside this project,.*: \S+\/\.zshenv$/),
          },
        ],
      })
      expect(existsSync(path.join(directory, "src/app.ts"))).toBe(false)
    }),
  )

  it.live("names the files outside the project in the config prompt of a patch that also edits config", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const registry = yield* Tool.Service
          const file = path.join(global.home, ".zshenv")
          const patchText = [
            "*** Begin Patch",
            "*** Add File: opencode.json",
            "+{}",
            `*** Add File: ${file}`,
            "+export PATH=/tmp/probe:$PATH",
            "*** End Patch",
          ].join("\n")

          return yield* rejectRequests(
            context,
            file,
            executeTool(registry, {
              sessionID: context.sessionID,
              agent: context.agent,
              messageID: context.messageID,
              call: { type: "tool-call", id: context.id, name: "patch", input: { patchText } },
            }),
          )
        }),
      )

      expect(result).toEqual({
        ...asked,
        asks: [
          {
            action: "edit",
            message: expect.stringMatching(
              /^ABuCode asks before any edit to engine config,.*: opencode\.json It also edits outside this project: \S+\/\.zshenv$/,
            ),
          },
        ],
      })
    }),
  )

  it.live(
    "lets edits reach the engine's temp folder and the plan folder, and asks for the rest of the temp folder",
    () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        const elsewhere = (yield* tmpdirScoped()).path
        const result = yield* inSession(directory, (files, context) =>
          Effect.gen(function* () {
            const global = yield* Global.Service
            const permission = yield* Permission.Service
            const open = yield* Effect.all([
              files.write({ path: path.join(global.tmp, "scratch", "probe.ts"), content: "export {}\n" }, context),
              files.write(
                { path: path.join(global.home, ".opencode", "plan", "probe.md"), content: "# Plan\n" },
                context,
              ),
            ]).pipe(Effect.timeout("5 seconds"), Effect.exit)
            const pending = (yield* permission.forSession(context.sessionID)).length
            const file = path.join(elsewhere, "probe.ts")
            const system = yield* rejectRequests(context, file, writeProbe(files, context, file))

            return { open: Exit.isSuccess(open), pending, system }
          }),
        )

        expect(result).toEqual({ open: true, pending: 0, system: outsideAsked })
      }),
  )

  // The engine reads the real paths of the folders it lets edits reach once, before the agent can relink one.
  withLinks("asks when the engine's temp folder has since been replaced by a link to elsewhere", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (files, context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          yield* Effect.promise(() => mkdir(global.home, { recursive: true }))
          yield* Effect.promise(() => rename(global.tmp, `${global.tmp}-before`))
          yield* Effect.promise(() => symlink(global.home, global.tmp))

          return yield* rejectRequests(
            context,
            path.join(global.home, ".zshenv"),
            writeProbe(files, context, path.join(global.tmp, ".zshenv")),
          )
        }),
      )

      expect(result).toEqual(outsideAsked)
    }),
  )

  // The plugin's tool hook recognizes the session move tool by these names.
  it.live("matches the session move tool's name and input fields", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const names = yield* inSession(directory, () =>
        Effect.gen(function* () {
          const tools = yield* Tool.Service
          return (yield* tools.list()).map((tool) => tool.id)
        }),
      )

      expect(names).toContain("opencode_session_move")
      expect(Object.keys(OpenCodeTools.MoveInput.fields)).toEqual(expect.arrayContaining(["sessionID", "directory"]))
    }),
  )

  it.live("asks before a session moves out of its project, but not into the engine's worktree folder", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const strategies = yield* WorktreeStrategies.Service
          const worktree = path.join(strategies.get().directory, "task")
          yield* Effect.promise(() => mkdir(worktree, { recursive: true }))
          const into = yield* toolHook(context, "opencode_session_move", { directory: worktree }).pipe(
            Effect.timeout("5 seconds"),
            Effect.exit,
          )
          const pending = (yield* permission.forSession(context.sessionID)).length
          // `~` is the engine's home, which holds this test's folders but lies outside the session's project.
          const away = yield* rejectRequests(
            context,
            path.join(directory, "never-written"),
            toolHook(context, "opencode_session_move", { directory: "~" }),
          )

          return { into: Exit.isSuccess(into), pending, away }
        }),
      )

      expect(result).toEqual({ into: true, pending: 0, away: moveAsked })
    }),
  )

  // Plan's rules deny edits outside its plan folder; a move is its own permission, so Plan is asked, not refused.
  it.live("asks the Plan agent too before it moves a session out of its project", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(
        directory,
        (_files, context) =>
          rejectRequests(
            context,
            path.join(directory, "never-written"),
            toolHook(context, "opencode_session_move", { directory: "~" }),
          ),
        Agent.ID.make("plan"),
      )

      expect(result).toEqual(moveAsked)
    }),
  )

  // The tool's input is checked after the plugins' hooks run, so the hook sees whatever the model sent.
  it.live("leaves a move with an invalid session id to the tool's own input check", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const exit = yield* toolHook(context, "opencode_session_move", { sessionID: "abc", directory: "~" }).pipe(
            Effect.timeout("5 seconds"),
            Effect.exit,
          )

          return { passedOn: Exit.isSuccess(exit), pending: (yield* permission.forSession(context.sessionID)).length }
        }),
      )

      expect(result).toEqual({ passedOn: true, pending: 0 })
    }),
  )

  it.live("asks before a Code Mode program moves the session out of its project", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const asks = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const registry = yield* Tool.Service
          const outcome = yield* rejectRequests(
            context,
            path.join(directory, "never-written"),
            executeTool(registry, {
              sessionID: context.sessionID,
              agent: context.agent,
              messageID: context.messageID,
              call: {
                type: "tool-call",
                id: context.id,
                name: "execute",
                input: { code: `return await tools.opencode.session.move({ directory: "~" })` },
              },
            }),
          )

          // The program sees the refusal as a failed call, so the execute call itself completes.
          return outcome.asks
        }),
      )

      expect(asks).toEqual(moveAsked.asks)
    }),
  )

  it.live("refuses to move a session out of its project in unattended work", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const elsewhere = (yield* tmpdirScoped()).path
      const result = yield* inSession(directory, (_files, context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          // An automation's program names the tool by its Code Mode path.
          const exit = yield* toolHook(context, "opencode.session.move", { directory: elsewhere }).pipe(
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

      expect(result.error).toMatchObject({
        message: expect.stringMatching(/^ABuCode refuses to move a session out of its project in unattended work/),
      })
      expect(result.pending).toBe(0)
    }),
  )
})

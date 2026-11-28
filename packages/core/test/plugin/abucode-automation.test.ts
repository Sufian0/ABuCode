import { describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Automation } from "@opencode/core/automation"
import { AutomationTable } from "@opencode/core/automation/sql"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Instance } from "@opencode/core/instance/service"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { Rpc } from "@opencode/core/rpc"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import type { SessionSchema } from "@opencode/core/session/schema"
import { Tool } from "@opencode/core/tool"
import { ABuCode } from "@opencode/schema/abucode"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { eq } from "drizzle-orm"
import { Clock, Effect, Exit, Fiber, Layer, Option, Schedule } from "effect"
import { offlineModels } from "../fixture/models"
import { disabledPersistentPtyLayer } from "../fixture/persistent-pty"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

// Each test gets its own home, config and data folders, so the Policy tier or config one test saves does not reach the
// next.
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

// The real automation service, tool registry, permission service and plugins, so a request passes through the ABuCode
// plugin's hooks exactly as core raises it.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Automation.node, Bus.node, Database.node, Global.node, Instance.node, Session.node]),
    [
      Global.node.replace(isolatedGlobal),
      offlineModels,
      PersistentPty.node.replace(disabledPersistentPtyLayer),
      SessionExecution.node.replace(Layer.mock(SessionExecution.Service, { wake: () => Effect.void })),
    ],
  ),
)

const plugin = Plugin.ID.make("abucode.core")
const tiers = ["request_review", "default", "auto", "turbo"] as const
const trigger = { type: "every", every: "1 hour" } as const
const messageID = SessionMessage.ID.make("msg_abucode_automation")
const callID = Tool.CallID.make("call_abucode_automation")
const shell = (command: string) => ({ type: "shell" as const, command })
const code = (text: string) => ({ type: "code" as const, code: text })

interface Setup {
  /** The session's Policy tier; a new session is in the Default tier. */
  readonly tier?: (typeof tiers)[number]
  /** The session's own permission rules; without any, every action is allowed. */
  readonly permissions?: Permission.Ruleset
  /** The user's global config file. */
  readonly config?: unknown
}

// A session in a new folder. `body` runs in the session's Location once the plugins are active.
const inSession = <A, E>(
  body: (
    session: SessionSchema.Info,
  ) => Effect.Effect<A, E, Automation.Service | Database.Service | Permission.Service | Rpc.Service | Tool.Service>,
  setup?: Setup,
) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    if (setup?.config)
      yield* Effect.promise(() => Bun.write(path.join(global.config, "opencode.json"), JSON.stringify(setup.config)))
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      location: { directory: AbsolutePath.make((yield* tmpdirScoped()).path) },
      permissions: setup?.permissions,
    })
    const instances = yield* Instance.Service

    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      // A case that expects nothing to be asked would pass with the plugin missing too.
      expect((yield* plugins.list()).find((item) => item.id === plugin)?.state.status).toBe("active")
      const control = (yield* Rpc.Service).client(ABuCode.Definition)
      if (setup?.tier) yield* control.setPolicy({ sessionID: session.id, policy: setup.tier })
      expect((yield* control.getSession({ sessionID: session.id })).policy).toBe(setup?.tier ?? "default")

      return yield* body(session)
    }).pipe(instances.provide(session))
  })

// The agent's automation tool, called as a model calls it: by its name in the tool list, by its Code Mode path, or from
// inside a Code Mode program.
const callTool = (
  session: SessionSchema.Info,
  action: Automation.ActionInput,
  how: "automation_create" | "automation.create" | "execute" = "automation_create",
) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const request = { name: "nightly", trigger, action }
    const result = yield* executeTool(registry, {
      sessionID: session.id,
      agent: Agent.defaultID,
      messageID,
      call: {
        type: "tool-call",
        id: callID,
        name: how,
        input:
          how === "execute" ? { code: `return await tools.automation.create(${JSON.stringify(request)})` } : request,
      },
    })

    return result.status === "error" ? result.error?.message : "created"
  })

// Core's own creation call without the tool in front of it. `asked` is how the tool makes it; without it nobody is there
// to answer, as on core's HTTP route, and core settles an ask from the rules alone.
const create = (session: SessionSchema.Info, action: Automation.ActionInput, asked = true) =>
  Effect.gen(function* () {
    const automations = yield* Automation.Service
    const input = { name: "nightly", sessionID: session.id, trigger, action }
    if (!asked) return yield* automations.create(input).pipe(Effect.provideService(Permission.Unattended, []))

    return yield* automations.create(
      input,
      Permission.invocation({ sessionID: session.id, agent: Agent.defaultID, messageID, id: callID }),
    )
  })

// Starts `attempt`, answers each thing it asks until it ends, and reports what it asked, how it ended and how many
// automations exist afterwards.
const answered = <A, E, R>(
  session: SessionSchema.Info,
  reply: "once" | "always" | "reject",
  attempt: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const automations = yield* Automation.Service
    const fiber = yield* attempt.pipe(Effect.exit, Effect.forkChild)
    const asked: Permission.Request[] = []
    yield* permission.forSession(session.id).pipe(
      Effect.tap((asks) =>
        Effect.forEach(
          asks,
          (ask) =>
            Effect.sync(() => asked.push(ask)).pipe(Effect.andThen(permission.reply({ requestID: ask.id, reply }))),
          { discard: true },
        ),
      ),
      Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined, schedule: Schedule.spaced("10 millis") }),
      // Fails the test if it never ends, instead of waiting for the test's own timeout.
      Effect.timeout("10 seconds"),
    )
    const exit = yield* Fiber.join(fiber)

    return {
      asks: asked.map((ask) => ({
        action: ask.action,
        resources: ask.resources,
        message: ask.message,
        save: ask.save,
        source: ask.source,
      })),
      value: Option.getOrUndefined(Exit.getSuccess(exit)),
      error: Option.getOrUndefined(Exit.findErrorOption(exit)),
      stored: (yield* automations.list()).length,
    }
  })

// Makes the automation due now, runs the scheduler once and waits for the run's result.
const runNow = (id: Automation.ID) =>
  Effect.gen(function* () {
    const automations = yield* Automation.Service
    const database = yield* Database.Service
    yield* database.db
      .update(AutomationTable)
      .set({ next_due_at: yield* Clock.currentTimeMillis })
      .where(eq(AutomationTable.id, id))
      .run()
    // A script runs inside the tick; one that waits for an answer would otherwise hang until the test's own timeout.
    yield* automations.tick.pipe(Effect.timeout("10 seconds"))

    return yield* automations
      .get(id)
      .pipe(
        Effect.repeat({ until: (row) => row.lastOutcome !== undefined, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("10 seconds"),
      )
  })

// A shell request as a script's shell call raises it while it runs: core's unattended marker carries the approval
// given when the automation was made. Without `call` it is core's own check that the script may use the shell tool.
const unattendedShell = (session: SessionSchema.Info, command: string, call?: Permission.Source) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const exit = yield* permission
      .assert({ action: "shell", resources: [command], sessionID: session.id, agent: Agent.defaultID, source: call })
      .pipe(
        Effect.provideService(Permission.Unattended, [{ action: "shell", resource: "*", effect: "allow" }]),
        Effect.timeout("10 seconds"),
        Effect.exit,
      )

    return Exit.isSuccess(exit) ? "runs" : Option.getOrUndefined(Exit.findErrorOption(exit))
  })

const creationAsk = expect.stringMatching(/^ABuCode asks before an automation is created/)
// The plugin's prompt names the calling message but no tool call of it; core's names the tool call.
const ownSource = expect.objectContaining({ type: "tool", messageID, id: expect.stringMatching(/:abucode-automation$/) })
const coreSource = { type: "tool" as const, messageID, id: callID }
const blocked = (reason: RegExp) =>
  expect.objectContaining({ _tag: "Permission.BlockedError", reason: expect.stringMatching(reason) })
const tierRefusal = blocked(/^ABuCode refuses a shell command in unattended work/)

describe("ABuCode automation guard", () => {
  // Permission rules allow every action by default, so without the plugin none of these would ask. The prompt's
  // resource is the whole command or script; core's own requests name only a command's parts, or `*` for a script.
  for (const tier of tiers) {
    it.live(`shows a shell automation's whole command and asks, in the ${tier} tier`, () =>
      Effect.gen(function* () {
        const command = "cd . && echo tidy | cat"
        const result = yield* inSession(
          (session) => answered(session, "reject", callTool(session, shell(command))),
          { tier },
        )

        expect(result.asks).toEqual([
          { action: "shell", resources: [command], message: creationAsk, save: undefined, source: ownSource },
        ])
        expect(result.stored).toBe(0)
      }),
    )

    it.live(`shows a script automation's script and asks, in the ${tier} tier`, () =>
      Effect.gen(function* () {
        const script = "const text = await (await fetch(args)).text()\nreturn { state: text }"
        const result = yield* inSession((session) => answered(session, "reject", callTool(session, code(script))), {
          tier,
        })

        expect(result.asks).toEqual([
          { action: "execute", resources: [script], message: creationAsk, save: undefined, source: ownSource },
        ])
        expect(result.stored).toBe(0)
      }),
    )
  }

  it.live("creates the automation after that one approval, and it runs", () =>
    Effect.gen(function* () {
      const result = yield* inSession((session) =>
        Effect.gen(function* () {
          const automations = yield* Automation.Service
          const outcome = yield* answered(session, "once", callTool(session, shell("echo automation-output")))
          const created = yield* automations.list()

          return {
            asks: outcome.asks.map((ask) => ask.action),
            value: outcome.value,
            ran: yield* Effect.forEach(created, (item) => runNow(item.id)),
          }
        }),
      )

      expect(result).toMatchObject({
        asks: ["shell"],
        value: "created",
        ran: [{ lastOutcome: "fired", lastOutput: expect.stringContaining("automation-output") }],
      })
    }),
  )

  // Core takes a call under either name, and a Code Mode program reaches the tool without a call of its own. The one
  // approval also answers core's request that follows inside the same call.
  for (const how of ["automation.create", "execute"] as const) {
    it.live(`asks once when the tool is called as ${how}`, () =>
      Effect.gen(function* () {
        const result = yield* inSession((session) => answered(session, "once", callTool(session, shell("echo tidy"), how)))

        expect(result).toMatchObject({
          asks: [{ action: "shell", resources: ["echo tidy"], message: creationAsk, save: undefined, source: ownSource }],
          value: "created",
          stored: 1,
        })
      }),
    )
  }

  it.live("asks again for a second automation with the same command, also after Always", () =>
    Effect.gen(function* () {
      const result = yield* inSession((session) =>
        Effect.gen(function* () {
          const first = yield* answered(session, "always", callTool(session, shell("echo tidy")))
          const second = yield* answered(session, "reject", callTool(session, shell("echo tidy")))

          return { first: first.asks.length, second: second.asks.length, stored: second.stored }
        }),
      )

      expect(result).toEqual({ first: 1, second: 1, stored: 1 })
    }),
  )

  // The terminal prints a request's resource as it is; only the app's dock spells such characters out itself.
  it.live("spells out characters in the command that would not show", () =>
    Effect.gen(function* () {
      const result = yield* inSession((session) =>
        answered(session, "reject", callTool(session, shell("echo tidy‮ # not what it seems"))),
      )

      expect(result.asks.map((ask) => ask.resources)).toEqual([["echo tidy⟦U+202E⟧ # not what it seems"]])
    }),
  )

  // Core's request is then the Policy tier's own question, as for any command, and keeps the tier's message; the prompt
  // before it already said that this is an automation.
  it.live("shows the Policy tier's reason when it flags the command, and its own prompt follows", () =>
    Effect.gen(function* () {
      const command = "rm -f abucode-automation-gone.txt"
      const result = yield* inSession((session) => answered(session, "once", callTool(session, shell(command))))

      expect(result).toMatchObject({
        asks: [
          {
            action: "shell",
            resources: [command],
            message: expect.stringMatching(/^ABuCode asks before an automation is created.+deletes files or directories/),
            source: ownSource,
          },
          {
            action: "shell",
            resources: [command],
            message: "Default policy: deletes files or directories (rm).",
            source: coreSource,
          },
        ],
        value: "created",
        stored: 1,
      })
    }),
  )

  // A person who declines one prompt of a step declines the step, so the automation's prompt goes with the others.
  it.live("goes with the step's other prompts when one of them is declined", () =>
    Effect.gen(function* () {
      const result = yield* inSession((session) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const automations = yield* Automation.Service
          const creating = yield* callTool(session, shell("echo tidy")).pipe(Effect.exit, Effect.forkChild)
          // Another call of the same step, which the Default tier asks about.
          const other = yield* permission
            .assert({
              action: "shell",
              resources: ["rm -f abucode-automation-gone.txt"],
              sessionID: session.id,
              agent: Agent.defaultID,
              source: { type: "tool", messageID, id: "call_abucode_other" },
            })
            .pipe(Effect.exit, Effect.forkChild)
          const asks = yield* permission.forSession(session.id).pipe(
            Effect.repeat({ until: (list) => list.length === 2, schedule: Schedule.spaced("10 millis") }),
            Effect.timeout("10 seconds"),
          )
          yield* Effect.forEach(
            asks.filter((ask) => ask.source?.id === "call_abucode_other"),
            (ask) => permission.reply({ requestID: ask.id, reply: "reject" }),
            { discard: true },
          )
          // A prompt left waiting would keep its call from ending; the deadline turns that into a failure.
          const exits = yield* Effect.all([Fiber.join(creating), Fiber.join(other)]).pipe(Effect.timeout("10 seconds"))

          return {
            failed: [Exit.isFailure(exits[0]), Exit.isFailure(exits[1])],
            pending: (yield* permission.forSession(session.id)).length,
            stored: (yield* automations.list()).length,
          }
        }),
      )

      expect(result).toEqual({ failed: [true, true], pending: 0, stored: 0 })
    }),
  )

  it.live("lets a rule that denies shell commands refuse the automation without asking", () =>
    Effect.gen(function* () {
      const result = yield* inSession((session) => answered(session, "reject", callTool(session, shell("echo tidy"))), {
        permissions: [{ action: "shell", resource: "*", effect: "deny" }],
      })

      expect(result).toMatchObject({ asks: [], value: expect.stringContaining("Permission denied"), stored: 0 })
    }),
  )

  it.live("refuses a shell automation whose command is on the never-permitted list", () =>
    Effect.gen(function* () {
      // The list reads the raw text, so this harmless command is on it.
      const result = yield* inSession((session) => answered(session, "reject", callTool(session, shell("echo mkfs"))), {
        tier: "turbo",
      })

      expect(result).toMatchObject({ asks: [], value: expect.stringMatching(/^Blocked: /), stored: 0 })
    }),
  )

  it.live("refuses a shell automation whose command writes engine config", () =>
    Effect.gen(function* () {
      const result = yield* inSession(
        (session) => answered(session, "reject", callTool(session, shell("echo '{}' > opencode.json"))),
        { tier: "turbo" },
      )

      expect(result).toMatchObject({
        asks: [],
        value: expect.stringMatching(/^ABuCode refuses an automation whose command writes engine config/),
        stored: 0,
      })
    }),
  )

  it.live("leaves an automation that sends a prompt alone", () =>
    Effect.gen(function* () {
      const prompt = { type: "prompt" as const, prompt: "Check the build" }
      const result = yield* inSession((session) =>
        Effect.gen(function* () {
          const tool = yield* answered(session, "reject", callTool(session, prompt))
          const unasked = yield* answered(session, "reject", create(session, prompt, false))

          return { asks: tool.asks.length, created: [tool.value, unasked.error], stored: unasked.stored }
        }),
      )

      expect(result).toEqual({ asks: 0, created: ["created", undefined], stored: 2 })
    }),
  )

  // Core's own requests for an automation ask as well when the tool's prompt did not come first. They show less: the
  // command's parts, or `*` for a script.
  for (const action of [shell("echo tidy"), code("return")]) {
    it.live(`asks about a ${action.type} automation that does not come through the tool`, () =>
      Effect.gen(function* () {
        const result = yield* inSession((session) => answered(session, "reject", create(session, action)), {
          tier: "turbo",
        })

        expect(result.asks).toEqual([
          {
            action: action.type === "shell" ? "shell" : "execute",
            resources: action.type === "shell" ? ["echo tidy"] : ["*"],
            message: creationAsk,
            save: undefined,
            source: coreSource,
          },
        ])
        expect(result.stored).toBe(0)
      }),
    )
  }

  it.live("refuses a command that writes engine config also when it does not come through the tool", () =>
    Effect.gen(function* () {
      const result = yield* inSession(
        (session) => answered(session, "reject", create(session, shell("echo '{}' > opencode.json"))),
        { tier: "turbo" },
      )

      expect(result).toMatchObject({
        asks: [],
        error: blocked(/^ABuCode refuses an automation whose command writes engine config/),
        stored: 0,
      })
    }),
  )

  // Core's HTTP route cannot ask anyone and settles an ask from the rules alone, so the prompt cannot reach it. A command
  // that writes engine config, or that the Policy tier would ask about, is refused there; the rest stays with the rules.
  it.live("where nobody can be asked, refuses a command that writes engine config or that the tier flags", () =>
    Effect.gen(function* () {
      const result = yield* inSession((session) =>
        Effect.gen(function* () {
          const config = yield* answered(session, "reject", create(session, shell("echo '{}' > opencode.json"), false))
          const flagged = yield* answered(
            session,
            "reject",
            create(session, shell("rm -f abucode-automation-gone.txt"), false),
          )
          const plain = yield* answered(session, "reject", create(session, shell("echo tidy"), false))

          return { config: config.error, flagged: flagged.error, plain: plain.error, stored: plain.stored }
        }),
      )

      expect(result).toEqual({
        config: blocked(/^ABuCode refuses an automation whose command writes engine config/),
        flagged: tierRefusal,
        plain: undefined,
        stored: 1,
      })
    }),
  )

  // `rm` is asked about in the Default and Auto tiers, a dev server in the Default tier only, `echo` and `*` in neither.
  // Core's own check that a script may use the shell tool names `*` and no tool call, and is left to core.
  it.live("refuses, in unattended work, a shell command the Policy tier would ask about", () =>
    Effect.gen(function* () {
      const call = { type: "tool" as const, messageID, id: callID }
      const rate = (tier: (typeof tiers)[number]) =>
        inSession(
          (session) =>
            Effect.all({
              remove: unattendedShell(session, "rm -f abucode-automation-gone.txt", call),
              serve: unattendedShell(session, "npm run dev", call),
              print: unattendedShell(session, "echo ok", call),
              star: unattendedShell(session, "*", call),
              capability: unattendedShell(session, "*"),
            }),
          { tier },
        )

      expect(yield* rate("request_review")).toEqual({
        remove: tierRefusal,
        serve: tierRefusal,
        print: tierRefusal,
        star: tierRefusal,
        capability: "runs",
      })
      expect(yield* rate("default")).toEqual({
        remove: tierRefusal,
        serve: tierRefusal,
        print: "runs",
        star: "runs",
        capability: "runs",
      })
      expect(yield* rate("auto")).toEqual({
        remove: tierRefusal,
        serve: "runs",
        print: "runs",
        star: "runs",
        capability: "runs",
      })
      expect(yield* rate("turbo")).toEqual({
        remove: "runs",
        serve: "runs",
        print: "runs",
        star: "runs",
        capability: "runs",
      })
    }),
  )

  // The approval given at creation still answers a permission rule that asks about every shell command, which is what
  // it is for.
  it.live("lets unattended work run a command that only a catch-all permission rule asks about", () =>
    Effect.gen(function* () {
      const result = yield* inSession(
        (session) => unattendedShell(session, "echo ok", { type: "tool", messageID, id: callID }),
        { permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
      )

      expect(result).toBe("runs")
    }),
  )

  // The whole path: the script's call reaches the shell tool while core's unattended marker is set.
  it.live("pauses a script automation at a shell command the Policy tier would ask about", () =>
    Effect.gen(function* () {
      const result = yield* inSession(
        (session) =>
          Effect.gen(function* () {
            const automations = yield* Automation.Service
            const kept = path.join(session.location.directory, "abucode-automation-kept.txt")
            yield* Effect.promise(() => Bun.write(kept, "kept"))
            const script = `await tools.shell({ command: "rm -f abucode-automation-kept.txt", description: "Remove a file" })\nreturn { done: true }`
            const outcome = yield* answered(session, "once", callTool(session, code(script)))
            const created = yield* automations.list()

            return {
              value: outcome.value,
              ran: yield* Effect.forEach(created, (item) => runNow(item.id)),
              kept: existsSync(kept),
            }
          }),
        // The shell tool is callable from a script only with Full Code Mode on.
        { config: { experimental: { full_codemode: true } } },
      )

      expect(result).toMatchObject({
        value: "created",
        ran: [
          {
            status: "paused",
            lastOutcome: "failed",
            lastOutput: expect.stringContaining("ABuCode refuses a shell command in unattended work"),
          },
        ],
        kept: true,
      })
    }),
  )

  // Request Review asks about every command, so a script stops at its first one; one that runs none is not stopped.
  it.live("in Request Review, pauses a script at its first shell command and leaves one that runs none alone", () =>
    Effect.gen(function* () {
      const run = (script: string) =>
        inSession(
          (session) =>
            Effect.gen(function* () {
              const automations = yield* Automation.Service
              yield* answered(session, "once", callTool(session, code(script)))
              const created = yield* automations.list({ sessionID: session.id })

              return yield* Effect.forEach(created, (item) => runNow(item.id))
            }),
          { tier: "request_review", config: { experimental: { full_codemode: true } } },
        )
      const call = `await tools.shell({ command: "echo tidy", description: "Print a line" })`

      expect(yield* run(`${call}\nreturn { done: true }`)).toMatchObject([
        {
          status: "paused",
          lastOutcome: "failed",
          lastOutput: expect.stringContaining("ABuCode refuses a shell command in unattended work"),
        },
      ])
      expect(yield* run(`if (args === "never") ${call}\nreturn { state: "started", done: true }`)).toMatchObject([
        { status: "done", lastOutcome: "fired", state: "started" },
      ])
    }),
  )

  // A script is not read when its automation is made, so the config guard has to hold when it runs.
  it.live("refuses an engine config write from a script automation's run", () =>
    Effect.gen(function* () {
      const result = yield* inSession(
        (session) =>
          Effect.gen(function* () {
            const automations = yield* Automation.Service
            const script = `await tools.shell({ command: "echo '{}' > opencode.json", description: "Write config" })\nreturn { done: true }`
            yield* answered(session, "once", callTool(session, code(script)))
            const created = yield* automations.list()

            return {
              ran: yield* Effect.forEach(created, (item) => runNow(item.id)),
              written: existsSync(path.join(session.location.directory, "opencode.json")),
            }
          }),
        { config: { experimental: { full_codemode: true } } },
      )

      expect(result).toMatchObject({
        ran: [
          {
            status: "paused",
            lastOutcome: "failed",
            lastOutput: expect.stringContaining("ABuCode refuses edits to engine config in unattended work"),
          },
        ],
        written: false,
      })
    }),
  )
})

import { describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Message, SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { FileAccess } from "@opencode/core/file-access"
import { FileWrite } from "@opencode/core/file-write"
import { Instance } from "@opencode/core/instance/service"
import { Permission } from "@opencode/core/permission"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { ServerAddress } from "@opencode/util/server-address"
import { Effect, Exit, Fiber, Layer, Option, Schedule } from "effect"
import { offlineModels } from "../fixture/models"
import { disabledPersistentPtyLayer } from "../fixture/persistent-pty"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

// Each test gets its own home with the usual layout, so `~/.config/abucode` and `~/.local/state/abucode` are the
// engine's config and state folders, as on a real machine.
const isolatedGlobal = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const home = path.join(tmp.path, "home")
      const data = path.join(home, ".local", "share", "abucode")
      const cache = path.join(home, ".cache", "abucode")
      return Global.layerWith({
        home,
        data,
        cache,
        config: path.join(home, ".config", "abucode"),
        state: path.join(home, ".local", "state", "abucode"),
        tmp: path.join(tmp.path, "tmp"),
        bin: path.join(cache, "bin"),
        log: path.join(data, "log"),
        repos: path.join(data, "repos"),
      })
    }),
  ),
)

// A real Location and session, so each request goes through the permission service and the ABuCode plugin's hooks.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Bus.node, Database.node, Global.node, Instance.node, Session.node]), [
    Global.node.replace(isolatedGlobal),
    offlineModels,
    PersistentPty.node.replace(disabledPersistentPtyLayer),
    SessionExecution.node.replace(Layer.mock(SessionExecution.Service, { wake: () => Effect.void })),
  ]),
)

type Services =
  | FileAccess.Service
  | FileWrite.Service
  | Global.Service
  | Permission.Service
  | PluginHooks.Service
  | Tool.Service

// Runs `use` after the plugins have activated, in a session opened in a fresh project folder or in the home folder,
// with a probe password in the state folder's service file, written as the CLI writes it.
const inSession = <A, E>(
  use: (context: FileAccess.Invocation) => Effect.Effect<A, E, Services>,
  at?: "home",
  secret = "probe-password-0f3a",
) =>
  Effect.gen(function* () {
    const project = (yield* tmpdirScoped()).path
    const sessions = yield* Session.Service
    const global = yield* Global.Service
    yield* Effect.promise(() =>
      writeFile(path.join(global.state, "service-local.json"), JSON.stringify({ password: secret })),
    )
    const directory = at === "home" ? global.home : project
    const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
    const instances = yield* Instance.Service

    return yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      return yield* use({
        sessionID: session.id,
        agent: Agent.defaultID,
        messageID: SessionMessage.ID.make("msg_abucode_engine_self"),
        id: Tool.CallID.make("call_abucode_engine_self"),
      })
    }).pipe(instances.provide(session))
  })

// A stand-in for the engine's own server, recorded as the real server records itself, that counts what reaches it.
const ownServer = Effect.acquireRelease(
  Effect.sync(() => {
    const hits: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        hits.push(`${request.method} ${new URL(request.url).pathname}`)
        return new Response("engine", { headers: { "content-type": "text/plain" } })
      },
    })
    const url = `http://127.0.0.1:${server.port}`
    return { server, hits, url, unregister: ServerAddress.register(() => [url]) }
  }),
  (own) => Effect.promise(() => own.server.stop(true)).pipe(Effect.andThen(Effect.sync(own.unregister))),
)

// A dev server that is not the engine's, counting what reaches it. Its form answers a POST with a 303 to another page.
const devServer = Effect.acquireRelease(
  Effect.sync(() => {
    const hits: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        hits.push(`${request.method} ${pathname}`)
        if (pathname === "/form") return new Response("", { status: 303, headers: { location: "/done" } })
        return new Response("dev server", { headers: { "content-type": "text/plain" } })
      },
    })
    return { server, hits, url: `http://127.0.0.1:${server.port}` }
  }),
  (dev) => Effect.promise(() => dev.server.stop(true)),
)

const localServer = (fetch: (request: Request) => Response) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })),
    (server) => Effect.promise(() => server.stop(true)),
  )

// The request the webfetch tool makes for a URL; Code Mode's fetch names its method in the metadata.
const webfetch = (
  context: FileAccess.Invocation,
  url: string,
  metadata: Record<string, unknown> = { url, format: "text" },
) => ({ action: "webfetch", resources: [url], save: ["*"], metadata, ...Permission.invocation(context) })

const call = (context: FileAccess.Invocation, name: string, input: Record<string, unknown>) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  messageID: context.messageID,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

const codeMode = (context: FileAccess.Invocation, code: string) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* executeTool(registry, call(context, "execute", { code }))
  })

const failure = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

// Starts `attempt`, waits for the permission requests it raises, answers them, and reports what was asked and how the
// attempt ended. An attempt that never asks fails at the deadline.
const askAndAnswer = <A, E, R>(
  context: FileAccess.Invocation,
  attempt: Effect.Effect<A, E, R>,
  reply: Permission.Reply = "reject",
) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* attempt.pipe(Effect.exit, Effect.forkChild)
    const asks = yield* permission
      .forSession(context.sessionID)
      .pipe(
        Effect.repeat({ until: (list) => list.length > 0, schedule: Schedule.spaced("10 millis") }),
        Effect.timeout("10 seconds"),
      )
    yield* Effect.forEach(asks, (ask) => permission.reply({ requestID: ask.id, reply }), { discard: true })
    const exit = yield* Fiber.join(fiber)
    return { asks: asks.map((ask) => ask.message), ran: Exit.isSuccess(exit), output: JSON.stringify(exit) }
  })

const ownServerRefusal = { reason: expect.stringMatching(/^Blocked request to this ABuCode engine's own server/) }
const stateAsk = expect.stringMatching(/^ABuCode asks: this command reads or changes the engine's own state/)

describe("ABuCode engine self-access guard", () => {
  it.live("refuses the engine's own server to the webfetch tool, Code Mode's fetch and redirect hops", () =>
    Effect.gen(function* () {
      const own = yield* ownServer
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const shell = `${own.url}/api/shell`
          const reply = `${own.url}/api/session/ses_x/permission/per_y/reply`
          return {
            tool: failure(yield* permission.assert(webfetch(context, shell)).pipe(Effect.exit)),
            codeMode: failure(
              yield* permission.assert(webfetch(context, reply, { method: "POST", url: reply })).pipe(Effect.exit),
            ),
            hop: failure(
              yield* permission
                .assertNotDenied(webfetch(context, `http://localhost:${own.server.port}/`))
                .pipe(Effect.exit),
            ),
            metadataHop: failure(
              yield* permission
                .assertNotDenied(webfetch(context, "http://169.254.169.254/latest/meta-data/"))
                .pipe(Effect.exit),
            ),
            pending: (yield* permission.forSession(context.sessionID)).length,
          }
        }),
      )

      expect(result.tool).toBeInstanceOf(Permission.BlockedError)
      expect(result.tool).toMatchObject(ownServerRefusal)
      expect(result.codeMode).toMatchObject(ownServerRefusal)
      expect(result.hop).toMatchObject(ownServerRefusal)
      expect(result.metadataHop).toMatchObject({ reason: expect.stringMatching(/cloud-metadata/) })
      expect(result.pending).toBe(0)
      expect(own.hits).toEqual([])
    }),
  )

  it.live("follows no redirect to the engine's own server", () =>
    Effect.gen(function* () {
      const own = yield* ownServer
      const redirector = yield* localServer(
        () => new Response("", { status: 302, headers: { location: `${own.url}/api/shell` } }),
      )
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const registry = yield* Tool.Service
          return yield* executeTool(
            registry,
            call(context, "webfetch", { url: `http://127.0.0.1:${redirector.port}/start`, format: "text" }),
          )
        }),
      )

      expect(result).toMatchObject({
        status: "error",
        error: { message: expect.stringMatching(/^Blocked request to this ABuCode engine's own server/) },
      })
      expect(own.hits).toEqual([])
    }),
  )

  it.live("keeps Code Mode's fetch off the engine's own server, however the request is written", () =>
    Effect.gen(function* () {
      const own = yield* ownServer
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const target = JSON.stringify(`${own.url}/api/shell`)
          // Bun's fetch reads a URL without a scheme as http, and honors its own `proxy` option.
          const bare = JSON.stringify(`localhost:${own.server.port}/api/shell`)
          return {
            post: yield* codeMode(context, `return (await fetch(${target}, { method: "POST", body: "{}" })).status`),
            bare: yield* codeMode(context, `return (await fetch(${bare}, { method: "POST", body: "{}" })).status`),
            proxy: yield* codeMode(
              context,
              `try { return (await fetch("http://127.0.0.1:1/api/session", { proxy: ${JSON.stringify(own.url)} })).status } catch (e) { return String(e) }`,
            ),
          }
        }),
      )

      expect(own.hits).toEqual([])
      expect(JSON.stringify(result.post)).toContain("Blocked request to this ABuCode engine's own server")
      expect(JSON.stringify(result.bare)).toContain("ABuCode lets the agent fetch only http:// and https:// URLs.")
    }),
  )

  it.live("asks before Code Mode's fetch sends anything but GET to a local server", () =>
    Effect.gen(function* () {
      const dev = yield* devServer
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const target = JSON.stringify(`${dev.url}/api/items`)
          const post = (url: string, method: string) =>
            codeMode(context, `return await (await fetch(${url}, { method: ${method}, body: "x" })).text()`)
          return {
            post: yield* askAndAnswer(context, post(target, `"POST"`)),
            // A method that is not a string is sent as its text, so it is checked as that too.
            array: yield* askAndAnswer(context, post(target, `["POST"]`)),
            get: yield* codeMode(context, `return await (await fetch(${target})).text()`),
            // Approved, the form's 303 leads to a GET, which is what its hop is checked as.
            form: yield* askAndAnswer(context, post(JSON.stringify(`${dev.url}/form`), `"POST"`), "once"),
          }
        }),
      )

      const asked = [expect.stringMatching(/^ABuCode asks before a POST request to this machine or the local network/)]
      expect(result.post.asks).toEqual(asked)
      expect(result.array.asks).toEqual(asked)
      expect(JSON.stringify(result.get)).toContain("dev server")
      expect(result.form.output).toContain("dev server")
      expect(dev.hits).toEqual(["GET /api/items", "POST /form", "GET /done"])
    }),
  )

  it.live("still fetches public sites and dev servers on other loopback ports", () =>
    Effect.gen(function* () {
      const own = yield* ownServer
      const dev = yield* devServer
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          const registry = yield* Tool.Service
          // An address, not a name, so the guard looks nothing up.
          const site = yield* permission.assert(webfetch(context, "http://93.184.216.34/docs")).pipe(Effect.exit)
          // An automation asks for `webfetch` on "*" and on its rules' patterns, which name no fetched URL.
          const automation = yield* permission
            .assertNotDenied({
              action: "webfetch",
              resources: ["*", "https://*.amazonaws.com/*"],
              ...Permission.invocation(context),
            })
            .pipe(Effect.exit)
          const fetched = yield* executeTool(registry, call(context, "webfetch", { url: `${dev.url}/`, format: "text" }))
          return { site: Exit.isSuccess(site), automation: Exit.isSuccess(automation), fetched }
        }),
      )

      expect(result).toMatchObject({
        site: true,
        automation: true,
        fetched: { status: "completed", content: [{ type: "text", text: "dev server" }] },
      })
      expect(own.hits).toEqual([])
    }),
  )

  it.live("refuses the file tools the engine's state files, and a search that would read them", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const access = yield* FileAccess.Service
          const files = yield* FileWrite.Service
          const hooks = yield* PluginHooks.Service
          const database = path.join(global.data, "opencode-local.db")
          // The plugin's tool hook, run as a tool call runs it; the tool itself never runs.
          const hook = (tool: string, input: Record<string, unknown>) =>
            hooks
              .trigger("tool", "execute.before", { tool, codemode: false, ...context, input })
              .pipe(Effect.exit, Effect.map((exit) => failure(exit)?.message ?? "ran"))

          return {
            read: failure(yield* access.authorizeRead(path.join(global.state, "service-local.json"), context).pipe(Effect.exit)),
            write: failure(yield* files.write({ path: `${database}-wal`, content: "x" }, context).pipe(Effect.exit)),
            readTool: yield* hook("read", { path: "~/.local/state/abucode/service-local.json" }),
            editTool: yield* hook("edit", { path: database, oldString: "a", newString: "b" }),
            // The grep tool reads hidden folders, so a search of the home folder reaches the state folders.
            grepConfig: yield* hook("grep", { pattern: "password", path: "~/.config" }),
            grepHome: yield* hook("grep", { pattern: "password", path: "~" }),
            grepProject: yield* hook("grep", { pattern: "password", path: "." }),
            readProject: yield* hook("read", { path: "README.md" }),
            written: existsSync(`${database}-wal`),
          }
        }),
      )

      expect(result.read).toBeInstanceOf(Permission.BlockedError)
      expect(result.read).toMatchObject({ reason: expect.stringMatching(/^ABuCode refuses the agent the engine's own/) })
      expect(result.write).toBeInstanceOf(Permission.BlockedError)
      expect(result.readTool).toMatch(/`service-local\.json` is the ABuCode engine's own state/)
      expect(result.editTool).toMatch(/`opencode-local\.db` is the ABuCode engine's own state/)
      expect(result.grepConfig).toMatch(/^A search of `~\/\.config` would read the ABuCode engine's own state/)
      expect(result.grepHome).toMatch(/^A search of `~` would read the ABuCode engine's own state/)
      expect(result).toMatchObject({ grepProject: "ran", readProject: "ran", written: false })
    }),
  )

  it.live("refuses a grep without a path, or with a blank one, in a session opened in the home folder", () =>
    Effect.gen(function* () {
      const result = yield* inSession(
        (context) =>
          Effect.gen(function* () {
            const hooks = yield* PluginHooks.Service
            const grep = (input: Record<string, unknown>) =>
              hooks
                .trigger("tool", "execute.before", { tool: "grep", codemode: false, ...context, input })
                .pipe(Effect.exit, Effect.map(failure))
            return [yield* grep({ pattern: "password" }), yield* grep({ pattern: "password", path: "" })]
          }),
        "home",
      )

      const refused = { message: expect.stringMatching(/^A search of `\.` would read the ABuCode engine's own state/) }
      expect(result).toEqual([expect.objectContaining(refused), expect.objectContaining(refused)])
    }),
  )

  // An automation's shell action is approved once, when it is made, through core's shell requests for it. That one
  // request shows the Policy tier's reason too.
  it.live("asks before an automation's shell command that names them", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          const evaluate = (command: string, resources: string[]) =>
            hooks
              .trigger("permission", "evaluate", {
                sessionID: context.sessionID,
                agent: context.agent,
                action: "shell",
                resources,
                metadata: { automation: "probe", trigger: { type: "manual" }, unattended: true, command },
                effect: "allow",
              })
              .pipe(Effect.map((event) => ({ effect: event.effect, message: event.message })))
          const cd = "cd ~/.local/state/abucode && cat service-local.json"
          const curl = "curl -s https://example.com/x && cat ~/.local/state/abucode/service-local.json"
          return {
            cd: yield* evaluate(cd, ["cat service-local.json"]),
            curl: yield* evaluate(curl, [curl]),
          }
        }),
      )

      expect(result.cd).toEqual({ effect: "ask", message: stateAsk })
      expect(result.curl).toEqual({ effect: "ask", message: expect.stringMatching(/engine's own state.*curl/s) })
    }),
  )

  // A background command's output reaches the model later as a session message, not as a tool result.
  it.live("masks the engine's password in everything a model request is built from", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const hooks = yield* PluginHooks.Service
          const token = btoa("opencode:probe-password-0f3a")
          const plain = Message.user("nothing to mask here")
          const event: SessionHooks["context"] = {
            sessionID: context.sessionID,
            agent: context.agent,
            model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("probe") }),
            system: [SystemPart.make("Pinned memory: probe-password-0f3a")],
            messages: [
              Message.user(
                `<background-result kind="shell">password=probe-password-0f3a basic=Basic ${token} query=?auth_token=${encodeURIComponent(token)}</background-result>`,
              ),
              Message.assistant([{ type: "text", text: "The password is probe-password-0f3a." }]),
              Message.tool({ id: "call_probe", name: "shell", result: { output: "probe-password-0f3a" } }),
              plain,
            ],
            tools: {},
            options: {},
          }
          const masked = yield* hooks.trigger("session", "context", event)
          return { masked, plain }
        }),
      )

      const text = JSON.stringify({ system: result.masked.system, messages: result.masked.messages })
      expect(text).not.toContain("probe-password")
      expect(text).not.toContain(btoa("opencode:probe-password-0f3a").slice(0, 20))
      expect(text.match(/\[REDACTED ENGINE PASSWORD\]/g)).toHaveLength(6)
      expect(result.masked.messages).toContain(result.plain)
    }),
  )

  // A password set by hand takes other forms: escaped in the service file, UTF-8 in the credential the clients send, or
  // too short to mask as written. One with any character must not stop model requests or tool calls.
  it.live("masks a password set by hand in the forms it takes", () =>
    Effect.gen(function* () {
      const credential = (secret: string) => Buffer.from(`opencode:${secret}`).toString("base64")
      const masked = (secret: string, text: string) =>
        inSession(
          (context) =>
            Effect.gen(function* () {
              const hooks = yield* PluginHooks.Service
              const registry = yield* Tool.Service
              const event = yield* hooks.trigger("session", "context", {
                sessionID: context.sessionID,
                agent: context.agent,
                model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("probe") }),
                system: [],
                messages: [Message.user(text)],
                tools: {},
                options: {},
              })
              const read = yield* executeTool(registry, call(context, "read", { path: "missing.txt" }))
              return { text: JSON.stringify(event.messages), read: read.status }
            }),
          undefined,
          secret,
        )
      const euro = yield* masked("Passwort€2026-probe", `Basic ${credential("Passwort€2026-probe")} Passwort€2026-probe`)
      const escaped = yield* masked('Pa"ss\\word-2026', JSON.stringify({ password: 'Pa"ss\\word-2026' }))
      const latin = yield* masked("pässwört-probe-1234", `Authorization: Basic ${credential("pässwört-probe-1234")}`)
      const short = yield* masked("hunter2", `Basic ${credential("hunter2")}; hunter2 is a common word`)

      expect(euro).toEqual({ text: expect.not.stringContaining("Passwort€2026"), read: "error" })
      expect(euro.text).not.toContain(credential("Passwort€2026-probe"))
      expect(escaped.text).not.toContain("word-2026")
      expect(latin.text).not.toContain(credential("pässwört-probe-1234"))
      expect(short.text).not.toContain(credential("hunter2"))
      expect(short.text).toContain("hunter2 is a common word")
    }),
  )

  // Core shows the model a wrapped cause's own message, so a cause that names the password must not reach it.
  it.live("masks the engine's password in a tool's error, its cause included", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const registry = yield* Tool.Service
          // Nothing listens on port 1, so the fetch fails with an error that names the URL.
          const url = "http://127.0.0.1:1/collect?k=probe-password-0f3a"
          return yield* executeTool(registry, call(context, "webfetch", { url, format: "text" }))
        }),
      )

      // The session error is what the model is shown.
      expect(result.status).toBe("error")
      expect(JSON.stringify(result)).toContain("[REDACTED ENGINE PASSWORD]")
      expect(JSON.stringify(result)).not.toContain("probe-password")
    }),
  )

  it.live("refuses Code Mode's requests to a local server that would ask, in unattended work", () =>
    Effect.gen(function* () {
      const dev = yield* devServer
      const result = yield* inSession((context) =>
        codeMode(
          context,
          `try { return (await fetch(${JSON.stringify(`${dev.url}/api/items`)}, { method: "POST", body: "x" })).status } catch (e) { return String(e) }`,
        ).pipe(Effect.provideService(Permission.Unattended, [{ action: "*", resource: "*", effect: "allow" }])),
      )

      expect(JSON.stringify(result)).toContain("Blocked POST request to loopback host")
      expect(dev.hits).toEqual([])
    }),
  )

  it.live("keeps the webfetch tool and playtest_url off the engine's own server", () =>
    Effect.gen(function* () {
      const own = yield* ownServer
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const registry = yield* Tool.Service
          return {
            webfetch: yield* executeTool(registry, call(context, "webfetch", { url: `${own.url}/api/session`, format: "text" })),
            playtest: yield* executeTool(registry, call(context, "playtest_url", { url: `${own.url}/` })),
          }
        }),
      )

      expect(JSON.stringify(result.webfetch)).toContain("Blocked request to this ABuCode engine's own server")
      expect(JSON.stringify(result.playtest)).toContain("Blocked request to this ABuCode engine's own server")
      expect(own.hits).toEqual([])
    }),
  )

  it.live("asks before a shell command that names them, also after a cd and from a working folder", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const registry = yield* Tool.Service
          const shell = (input: Record<string, unknown>) => executeTool(registry, call(context, "shell", input))
          return {
            cd: yield* askAndAnswer(context, shell({ command: "cd ~/.local/state/abucode && cat service-local.json" })),
            workdir: yield* askAndAnswer(context, shell({ command: "cat service-local.json", workdir: global.state })),
            database: yield* askAndAnswer(
              context,
              shell({ command: `sqlite3 ${path.join(global.data, "opencode-local.db")} "update kv set value = 'turbo'"` }),
            ),
          }
        }),
      )

      for (const attempt of [result.cd, result.workdir, result.database]) {
        expect(attempt.asks).toEqual([stateAsk])
        expect(attempt.ran).toBe(false)
        expect(attempt.output).not.toContain("probe-password")
      }
    }),
  )

  it.live("masks the engine's password in a tool result, even after an approved read", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const registry = yield* Tool.Service
          const command = `cat ${path.join(global.state, "service-local.json")}`
          return yield* askAndAnswer(context, executeTool(registry, call(context, "shell", { command })), "once")
        }),
      )

      expect(result.asks).toEqual([stateAsk])
      expect(result.output).toContain("[REDACTED ENGINE PASSWORD]")
      expect(result.output).not.toContain("probe-password")
    }),
  )

  it.live("asks before a play-test start command that names them, from its folder", () =>
    Effect.gen(function* () {
      const result = yield* inSession((context) =>
        Effect.gen(function* () {
          const global = yield* Global.Service
          const registry = yield* Tool.Service
          // Nothing listens on port 1, so the play-test would start the command.
          const input = { url: "http://127.0.0.1:1/", start_command: "cat service-local.json", cwd: global.state }
          return yield* askAndAnswer(context, executeTool(registry, call(context, "playtest_url", input)))
        }),
      )

      expect(result.asks).toEqual([stateAsk])
      expect(result.ran).toBe(false)
    }),
  )
})

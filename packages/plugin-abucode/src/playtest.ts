import childProcess from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import type { PolicyTier } from "@opencode/schema/abucode"
import type { Tool } from "@opencode/schema/tool"
import { Schema } from "effect"
import {
  AGENT_SELF_HEADER,
  evaluateShellPolicyDecision,
  isLoopbackHost,
  isOwnServerUrl,
  playtestConnectionAddresses,
  redactKnownSecrets,
  scrubEnvironmentRecord,
  validateFetchUrlGuard,
  validateResolvedFetchUrlGuard,
} from "./security.js"

export const PLAYTEST_ACTIONS = [
  "goto",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "scroll",
  "wait",
  "evaluate",
  "assert_text",
  "assert_visible",
  "assert_hidden",
  "assert_url",
  "assert_count",
  "screenshot",
] as const

const PlaytestStep = Schema.Struct({
  action: Schema.Literals(PLAYTEST_ACTIONS),
  selector: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.Number),
  timeoutMs: Schema.optionalKey(Schema.Number),
})
export type PlaytestStep = typeof PlaytestStep.Type

export const PlaytestInput = Schema.Struct({
  url: Schema.String.annotate({
    description: "Local loopback URL to test (must be http(s)://localhost, 127.0.0.1, or [::1]).",
  }),
  start_command: Schema.optionalKey(Schema.String).annotate({
    description:
      "Optional local dev-server command. Reuses an already-listening port automatically, or runs under the session's 4-tier shell policy and scrubbed env.",
  }),
  cwd: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory for start_command.",
  }),
  viewport: Schema.optionalKey(Schema.String).annotate({
    description: "Viewport preset ('desktop', 'laptop', 'tablet', 'mobile') or custom 'WxH' string (e.g. '1440x900').",
  }),
  allow_external_assets: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Allow DNS-validated GET/HEAD requests to public CDN hosts (private LAN/tailnet/IMDS stays blocked).",
  }),
  steps: Schema.optionalKey(Schema.Array(PlaytestStep)).annotate({
    description: "Optional interactive Playwright UI steps and assertions (18 actions supported).",
  }),
})
export type PlaytestInput = typeof PlaytestInput.Type

export const PlaytestOutput = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.Literals(["passed", "issues", "failed", "error"]),
  url: Schema.String,
  reusedServer: Schema.Boolean,
  consoleErrors: Schema.Array(Schema.String),
  consoleWarnings: Schema.Array(Schema.String),
  dialogs: Schema.Array(Schema.String),
  networkErrors: Schema.Array(Schema.String),
  report: Schema.String,
})
export type PlaytestOutput = typeof PlaytestOutput.Type

const VIEWPORT_PRESETS: Readonly<Record<string, { readonly width: number; readonly height: number }>> = {
  desktop: { width: 1280, height: 800 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
}

export function resolvePlaytestViewport(raw?: string): { readonly width: number; readonly height: number } {
  const clean = (raw ?? "").trim().toLowerCase()
  if (!clean) return VIEWPORT_PRESETS.desktop!
  if (VIEWPORT_PRESETS[clean]) return VIEWPORT_PRESETS[clean]!
  const m = /^(\d{3,4})\s*[x×,]\s*(\d{3,4})$/.exec(clean)
  if (m?.[1] && m[2]) {
    return {
      width: Math.max(320, Math.min(1920, Number.parseInt(m[1], 10))),
      height: Math.max(240, Math.min(1440, Number.parseInt(m[2], 10))),
    }
  }
  return VIEWPORT_PRESETS.desktop!
}

/** `ownServers` are the engine's own servers (FetchGuardOptions.ownServers), which a play-test may not open. */
export function validatePlaytestTargetUrl(
  rawUrl: string,
  ownServers: readonly string[] = [],
):
  | { readonly ok: true; readonly url: string; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly error: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) return { ok: false, error: "'url' is required (e.g. http://127.0.0.1:3000/)." }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (err) {
    return { ok: false, error: `Invalid URL '${trimmed}': ${err instanceof Error ? err.message : String(err)}` }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "'url' for playtest_url must use http:// or https://." }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "0.0.0.0" || host === "::") {
    return {
      ok: false,
      error: `Use http://127.0.0.1:${parsed.port || "3000"} instead of wildcard bind address '${host}'.`,
    }
  }
  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      error: `playtest_url only connects to local loopback (localhost, 127.0.0.1, [::1]), got '${host}'.`,
    }
  }
  const selfApiErr = validateFetchUrlGuard(parsed.toString(), { method: "GET", allowLoopbackGet: true, ownServers })
  if (selfApiErr) {
    return { ok: false, error: selfApiErr }
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80
  return { ok: true, url: parsed.toString(), host, port }
}

export function isPlaytestTargetPortOpen(rawUrl: string): Promise<boolean> {
  const validated = validatePlaytestTargetUrl(rawUrl)
  if (!validated.ok) return Promise.resolve(false)
  return checkTcpPortOpen(validated.host, validated.port)
}

function checkTcpPortOpen(host: string, port: number, timeoutMs = 350): Promise<boolean> {
  const candidates = host === "localhost" ? ["127.0.0.1", "::1"] : [host]
  return new Promise((resolve) => {
    let idx = 0
    const tryNext = () => {
      if (idx >= candidates.length) {
        resolve(false)
        return
      }
      const targetHost = candidates[idx++]!
      const socket = new net.Socket()
      let settled = false
      const finish = (open: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        if (open) resolve(true)
        else tryNext()
      }
      socket.setTimeout(timeoutMs)
      socket.once("connect", () => finish(true))
      socket.once("timeout", () => finish(false))
      socket.once("error", () => finish(false))
      socket.connect(port, targetHost)
    }
    tryNext()
  })
}

function killProcessTree(proc: childProcess.ChildProcess): void {
  if (!proc.pid) return
  try {
    if (process.platform === "win32") {
      childProcess.spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true })
    } else {
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {
        proc.kill("SIGTERM")
      }
    }
  } catch {
    // Ignore already-exited child process
  }
}

async function waitForLocalPortReady(
  host: string,
  port: number,
  proc: childProcess.ChildProcess,
  timeoutMs = 18_000,
  spawnError: () => Error | undefined = () => undefined,
): Promise<{ readonly ready: boolean; readonly exitedEarlyCode: number | null; readonly spawnError?: Error }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkTcpPortOpen(host, port)) {
      await new Promise((r) => setTimeout(r, 120))
      return { ready: true, exitedEarlyCode: null }
    }
    const failed = spawnError()
    if (failed !== undefined) return { ready: false, exitedEarlyCode: null, spawnError: failed }
    if (proc.exitCode !== null) {
      return { ready: false, exitedEarlyCode: proc.exitCode }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return { ready: false, exitedEarlyCode: proc.exitCode }
}

/** Why start_command cannot run in `folder`, if it cannot. */
export async function startFolderProblem(folder: string): Promise<string | undefined> {
  const stat = await fs.promises.stat(folder).catch(() => undefined)
  if (stat === undefined) return `The folder for start_command, ${folder}, does not exist or cannot be opened.`
  if (!stat.isDirectory()) return `The folder for start_command, ${folder}, is not a folder.`
  // A command cannot start in a folder it may not enter.
  const enterable = await fs.promises.access(folder, fs.constants.X_OK).then(
    () => true,
    () => false,
  )
  return enterable ? undefined : `The folder for start_command, ${folder}, cannot be opened.`
}

async function launchChromiumResilient(guardPort: number) {
  const { chromium } = await import("@playwright/test")
  for (const channel of [undefined, "msedge", "chrome"] as const) {
    try {
      return await chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
        // Every connection goes through the connection guard; `<-loopback>` sends loopback ones there too.
        proxy: { server: `socks5://127.0.0.1:${guardPort}`, bypass: "<-loopback>" },
      })
    } catch {
      continue
    }
  }
  throw new Error("Could not launch headless Chromium, Microsoft Edge, or Chrome via Playwright.")
}

// A SOCKS5 proxy for the play-test browser that connects only to the addresses `allowed` returns for each target, and
// connects to those, so a name is not resolved twice. The browser sends every TCP connection through it, loopback ones
// included, and so redirect hops, speculation-rules prefetch and prerender, workers and WebSockets are checked here.
// WebRTC's UDP does not pass through it; the engine's server does not listen on UDP.
async function startConnectionGuard(
  allowed: (
    host: string,
    port: number,
  ) => Promise<{ readonly addresses: readonly string[] } | { readonly refused: string }>,
) {
  const open = new Set<net.Socket>()
  const track = (socket: net.Socket) => {
    open.add(socket)
    socket.once("close", () => open.delete(socket))
  }
  const seen = { connections: 0 }
  const refusals: { readonly host: string; readonly port: number; readonly why: string }[] = []
  const server = net.createServer((client) => {
    track(client)
    client.on("error", () => client.destroy())
    client.once("data", (greeting) => {
      // Version 5, with "no authentication" among the methods offered.
      if (greeting[0] !== 5 || !greeting.subarray(2).includes(0)) return client.destroy()
      seen.connections++
      client.write(Buffer.from([5, 0]))
      client.once("data", (request) => {
        client.pause()
        const target = socksTarget(request)
        if (target === undefined) return refuseSocks(client, 7)
        allowed(target.host, target.port).then(
          (decision) => {
            if ("addresses" in decision)
              return connectFirst(client, decision.addresses, target.port, track, () =>
                refusals.push({ ...target, why: "nothing answered" }),
              )
            refusals.push({ ...target, why: `refused, ${decision.refused}` })
            refuseSocks(client, 2)
          },
          () => refuseSocks(client, 1),
        )
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    /** How many connections the browser has sent through the guard. */
    connections: () => seen.connections,
    /** The connections the guard refused, and those whose server did not answer. */
    refusals,
    close: () => {
      server.close()
      for (const socket of open) socket.destroy()
    },
  }
}

// The host and port of a SOCKS5 CONNECT request: the version, command 1, a reserved byte, the address type (an IPv4
// address, a name or an IPv6 address), the address and the port.
function socksTarget(request: Buffer): { readonly host: string; readonly port: number } | undefined {
  if (request[0] !== 5 || request[1] !== 1) return undefined
  const type = request[3]
  const length = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? 1 + (request[4] ?? 0) : 0
  if (length === 0 || request.length < 4 + length + 2) return undefined
  const address = request.subarray(4, 4 + length)
  const host =
    type === 1
      ? Array.from(address).join(".")
      : type === 4
        ? Array.from({ length: 8 }, (_, index) => address.readUInt16BE(index * 2).toString(16)).join(":")
        : address.subarray(1).toString("latin1")
  return { host, port: request.readUInt16BE(4 + length) }
}

// Connects to the first of `addresses` that answers, in the resolver's order, and joins it to the browser's socket.
// As browsers do (Happy Eyeballs), the next address starts 250 ms after the one before, or at once when that one
// fails, and the first to connect wins; so `localhost` reaches `::1` first, as in the user's browser, and a dead IPv6
// address costs a quarter of a second.
function connectFirst(
  client: net.Socket,
  addresses: readonly string[],
  port: number,
  track: (socket: net.Socket) => void,
  unanswered: () => void,
): void {
  const pending = new Set<net.Socket>()
  const progress = { started: 0, done: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const finish = (winner?: net.Socket) => {
    progress.done = true
    clearTimeout(progress.timer)
    for (const socket of pending) if (socket !== winner) socket.destroy()
  }
  client.once("close", () => finish())
  const start = () => {
    const address = addresses[progress.started]
    if (progress.done || address === undefined) return
    progress.started++
    const upstream = net.connect({ host: address, port })
    track(upstream)
    pending.add(upstream)
    upstream.once("error", () => {
      pending.delete(upstream)
      upstream.destroy()
      if (progress.done) return
      if (pending.size === 0 && progress.started >= addresses.length) {
        finish()
        unanswered()
        return refuseSocks(client, 5)
      }
      start()
    })
    upstream.once("connect", () => {
      if (progress.done) return upstream.destroy()
      finish(upstream)
      upstream.on("error", () => client.destroy())
      // Succeeded. The browser does not use the bound address in the reply.
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      client.pipe(upstream)
      upstream.pipe(client)
    })
    clearTimeout(progress.timer)
    progress.timer = setTimeout(start, 250)
  }
  start()
}

// `host:port` with the host written one way, as the URL parser writes it (`[::1]` for `0:0:0:0:0:0:0:1`).
function targetKey(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, "")
  const parsed = URL.parse(`http://${net.isIPv6(bare) ? `[${bare}]` : bare}/`)
  return `${parsed?.hostname ?? bare.toLowerCase()}:${port}`
}

function refuseSocks(client: net.Socket, code: number): void {
  client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]))
}

export interface PlaytestRuntimeHooks {
  readonly policyTier?: PolicyTier
  /** The engine's own servers, which the page may not open or call. */
  readonly ownServers?: readonly string[]
  readonly onRequireCommandApproval?: (command: string, reason: string) => Promise<void>
}

export async function runPlaytestUrl(
  input: PlaytestInput,
  hooks?: PlaytestRuntimeHooks,
): Promise<Tool.Result<typeof PlaytestOutput>> {
  const emptyErrorResult = (message: string): Tool.Result<typeof PlaytestOutput> => ({
    output: {
      ok: false,
      status: "error",
      url: input.url,
      reusedServer: false,
      consoleErrors: [],
      consoleWarnings: [],
      dialogs: [],
      networkErrors: [],
      report: message,
    },
    content: [{ type: "text", text: message }],
  })

  const ownServers = hooks?.ownServers ?? []
  const validated = validatePlaytestTargetUrl(input.url, ownServers)
  if (!validated.ok) {
    return emptyErrorResult(validated.error)
  }

  let serverProc: childProcess.ChildProcess | undefined
  let serverLogs = ""
  let reusedServer = false

  if (input.start_command?.trim()) {
    const startCmd = input.start_command.trim()
    const effectiveCwd = input.cwd || process.cwd()

    const alreadyOpen = await checkTcpPortOpen(validated.host, validated.port)
    if (alreadyOpen) {
      reusedServer = true
    } else {
      const tier = hooks?.policyTier ?? "default"
      const decision = evaluateShellPolicyDecision(tier, startCmd, "allow", effectiveCwd)
      if (decision.effect === "deny") {
        return emptyErrorResult(decision.message ?? "Blocked start_command by security policy.")
      }
      if (decision.effect === "ask" && hooks?.onRequireCommandApproval) {
        await hooks.onRequireCommandApproval(
          startCmd,
          decision.message ?? "Confirm starting local dev server for playtest_url.",
        )
      }

      const folderProblem = await startFolderProblem(effectiveCwd)
      if (folderProblem !== undefined) return emptyErrorResult(folderProblem)
      const cleanEnv = scrubEnvironmentRecord(process.env) as NodeJS.ProcessEnv
      serverProc = childProcess.spawn(startCmd, {
        cwd: effectiveCwd,
        env: cleanEnv,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
      })
      const appendLog = (chunk: Buffer) => {
        if (serverLogs.length < 32_768) {
          serverLogs += chunk.toString("utf8").slice(0, 32_768 - serverLogs.length)
        }
      }
      serverProc.stdout?.on("data", appendLog)
      serverProc.stderr?.on("data", appendLog)
      // A failed spawn ends the wait below with its error, rather than crashing the engine.
      const spawn: { error?: Error } = {}
      serverProc.on("error", (error) => {
        spawn.error = error
      })

      const readiness = await waitForLocalPortReady(validated.host, validated.port, serverProc, 18_000, () => spawn.error)
      if (!readiness.ready) {
        killProcessTree(serverProc)
        const why =
          readiness.spawnError !== undefined
            ? `Could not start \`${startCmd}\`: ${readiness.spawnError.message}`
            : readiness.exitedEarlyCode !== null
              ? `Dev server \`${startCmd}\` exited early with code ${readiness.exitedEarlyCode} before ${validated.host}:${validated.port} opened.`
              : `Timed out waiting for \`${startCmd}\` to open ${validated.host}:${validated.port}.`
        const msg = redactKnownSecrets(`${why}\nServer logs:\n${serverLogs.slice(-3000)}`)
        return emptyErrorResult(msg)
      }
    }
  }

  // The browser's own error for a closed port would name the connection guard instead. A closed loopback port refuses
  // at once, so a long timeout costs nothing and rides out a busy engine.
  if (!(await checkTcpPortOpen(validated.host, validated.port, 2_000))) {
    const shown = validated.host.includes(":") ? `[${validated.host}]` : validated.host
    return emptyErrorResult(
      `Nothing is listening on ${shown}:${validated.port}. Start the dev server first, or pass start_command.`,
    )
  }

  let browser: Awaited<ReturnType<typeof launchChromiumResilient>> | undefined
  let guard: Awaited<ReturnType<typeof startConnectionGuard>> | undefined
  const consoleErrors: string[] = []
  const consoleWarnings: string[] = []
  const dialogs: string[] = []
  const networkErrors: string[] = []
  const screenshots: Tool.FileContent[] = []
  const external = input.allow_external_assets === true
  // The servers the pages asked for, redirect hops included, as `host:port`.
  const requested = new Set<string>()
  // What the guard refused or could not reach, for the report: a refused connection shows in the page only as a SOCKS
  // error. The engine's own server comes first, whatever asked for it; other targets only when a page asked for them,
  // which leaves out the browser's own background connections to its vendor's hosts.
  const guardNotes = () =>
    [
      ...new Map(
        (guard?.refusals ?? [])
          .map((item) => ({ ...item, target: targetKey(item.host, item.port) }))
          .filter((item) => item.why.endsWith("own server") || requested.has(item.target))
          .sort((a, b) => Number(!a.why.endsWith("own server")) - Number(!b.why.endsWith("own server")))
          .map((item) => [item.target, `- ${item.target}: ${item.why}`]),
      ).values(),
    ].slice(0, 8)

  try {
    guard = await startConnectionGuard((host, port) =>
      playtestConnectionAddresses(host, port, { ownServers, external }),
    )
    browser = await launchChromiumResilient(guard.port)
    const vp = resolvePlaytestViewport(input.viewport)
    // Service workers would fetch outside the routes below, and the routes cover every page, popups included.
    const context = await browser.newContext({ viewport: vp, serviceWorkers: "block" })

    // A browser policy can override the proxy setting, which would leave every check below to the page routes. So the
    // browser's first connection, to the guard's own port, must reach the guard as a proxied one before the page opens.
    // It is made in a tab of its own, so the test page's history starts clean.
    const probe = await context.newPage()
    await probe.goto(`http://127.0.0.1:${guard.port}/`, { timeout: 5_000 }).catch(() => undefined)
    await probe.close()
    if (guard.connections() === 0) {
      return emptyErrorResult(
        "playtest_url stopped: its browser does not send its connections through ABuCode's connection guard, which refuses this engine's own server. A browser policy may set the browser's proxy.",
      )
    }
    const ask = (raw: string) => {
      const url = URL.parse(raw)
      if (url !== null && url.hostname !== "")
        requested.add(targetKey(url.hostname, Number(url.port || (/^(?:https|wss):$/.test(url.protocol) ? 443 : 80))))
    }
    context.on("request", (request) => ask(request.url()))
    // Playwright raises no request for a WebSocket, so each page's DevTools session reports them, refused ones included.
    const watched = new WeakSet<object>()
    const watchSockets = async (opened: Awaited<ReturnType<typeof context.newPage>>) => {
      if (watched.has(opened)) return
      watched.add(opened)
      const session = await context.newCDPSession(opened).catch(() => undefined)
      session?.on("Network.webSocketCreated", (event) => ask(event.url))
      await session?.send("Network.enable").catch(() => undefined)
    }
    context.on("page", (opened) => void watchSockets(opened))
    const page = await context.newPage()
    await watchSockets(page)

    // What the page may reach: data and blob URLs, the loopback servers it tests, and with allow_external_assets
    // DNS-checked reads of public hosts. Never the engine's own server.
    const reach = async (reqUrl: string, method: string): Promise<"page" | "local" | "public" | undefined> => {
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:") || reqUrl.startsWith("about:")) return "page"
      const parsed = URL.parse(reqUrl)
      if (parsed === null || isOwnServerUrl(reqUrl, ownServers)) return undefined
      if (isLoopbackHost(parsed.hostname)) {
        const selfBlock = validateFetchUrlGuard(reqUrl, { method, allowLoopbackGet: true })
        if (selfBlock && method !== "GET" && method !== "HEAD") return undefined
        if (parsed.pathname.startsWith("/api/providers") || parsed.pathname.includes("abucode.control")) return undefined
        return "local"
      }
      const read = method === "GET" || method === "HEAD"
      if (input.allow_external_assets && read && !(await validateResolvedFetchUrlGuard(reqUrl, { method })))
        return "public"
      return undefined
    }

    // The browser routes only the first request of a redirect chain, and neither WebSockets nor speculation-rules
    // prefetch and prerender; those pass only the connection guard, which refuses the engine's own server by address.
    await context.route("**/*", async (route) => {
      const req = route.request()
      const access = await reach(req.url(), req.method())
      if (access === undefined) return route.abort("blockedbyclient")
      if (access === "local") return route.continue({ headers: { ...req.headers(), [AGENT_SELF_HEADER]: "playtest_url" } })
      return route.continue()
    })

    page.on("console", (msg) => {
      const text = redactKnownSecrets(msg.text())
      if (msg.type() === "error" && consoleErrors.length < 30) {
        consoleErrors.push(text)
      } else if (msg.type() === "warning" && consoleWarnings.length < 20) {
        consoleWarnings.push(text)
      }
    })
    page.on("pageerror", (err) => {
      if (consoleErrors.length < 30) {
        consoleErrors.push(redactKnownSecrets(`Uncaught: ${err.message}`))
      }
    })
    page.on("dialog", (dlg) => {
      if (dialogs.length < 20) {
        dialogs.push(redactKnownSecrets(`[${dlg.type()}] ${dlg.message()}`))
      }
      void dlg.dismiss().catch(() => undefined)
    })
    page.on("response", (res) => {
      if (res.status() >= 400 && networkErrors.length < 25) {
        networkErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`)
      }
    })

    const startedAt = Date.now()
    await page.goto(validated.url, { waitUntil: "domcontentloaded", timeout: 15_000 })

    const steps = (input.steps ?? []).slice(0, 40)
    const stepNotes: string[] = []
    let failedStep: string | undefined

    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx]!
      const timeout = step.timeoutMs ?? 8_000
      const stepStart = Date.now()
      try {
        switch (step.action) {
          case "goto": {
            const targetRaw = step.value ? new URL(step.value, page.url()).toString() : page.url()
            const sub = validatePlaytestTargetUrl(targetRaw, ownServers)
            if (!sub.ok) throw new Error(sub.error)
            await page.goto(sub.url, { waitUntil: "domcontentloaded", timeout })
            stepNotes.push(`✓ Step ${idx + 1}: goto ${sub.url} (${Date.now() - stepStart}ms)`)
            break
          }
          case "click":
            await page.locator(step.selector ?? "body").click({ timeout })
            stepNotes.push(`✓ Step ${idx + 1}: click ${step.selector ?? "body"} (${Date.now() - stepStart}ms)`)
            break
          case "fill":
            await page.locator(step.selector ?? "input").fill(step.value ?? "", { timeout })
            stepNotes.push(`✓ Step ${idx + 1}: fill ${step.selector ?? "input"} (${Date.now() - stepStart}ms)`)
            break
          case "type":
            await page.locator(step.selector ?? "input").pressSequentially(step.value ?? "", { timeout })
            stepNotes.push(`✓ Step ${idx + 1}: type ${step.selector ?? "input"} (${Date.now() - stepStart}ms)`)
            break
          case "press":
            if (step.selector) {
              await page.locator(step.selector).press(step.value ?? "Enter", { timeout })
            } else {
              await page.keyboard.press(step.value ?? "Enter")
            }
            stepNotes.push(`✓ Step ${idx + 1}: press ${step.value ?? "Enter"} (${Date.now() - stepStart}ms)`)
            break
          case "select":
            await page.locator(step.selector ?? "select").selectOption(step.value ?? "", { timeout })
            stepNotes.push(`✓ Step ${idx + 1}: select '${step.value ?? ""}' on ${step.selector ?? "select"}`)
            break
          case "check":
            await page.locator(step.selector ?? "input[type=checkbox]").check({ timeout })
            stepNotes.push(`✓ Step ${idx + 1}: check ${step.selector ?? "checkbox"}`)
            break
          case "uncheck":
            await page.locator(step.selector ?? "input[type=checkbox]").uncheck({ timeout })
            stepNotes.push(`✓ Step ${idx + 1}: uncheck ${step.selector ?? "checkbox"}`)
            break
          case "hover":
            await page.locator(step.selector ?? "body").hover({ timeout })
            stepNotes.push(`✓ Step ${idx + 1}: hover ${step.selector ?? "body"}`)
            break
          case "scroll": {
            if (step.selector) {
              await page.locator(step.selector).scrollIntoViewIfNeeded({ timeout })
              stepNotes.push(`✓ Step ${idx + 1}: scroll into view ${step.selector}`)
            } else {
              const deltaY = Number(step.value ?? 500) || 500
              await page.mouse.wheel(0, deltaY)
              stepNotes.push(`✓ Step ${idx + 1}: scroll wheel dy=${deltaY}`)
            }
            break
          }
          case "wait":
            if (step.selector) {
              await page.locator(step.selector).waitFor({ state: "visible", timeout })
              stepNotes.push(`✓ Step ${idx + 1}: wait for ${step.selector}`)
            } else {
              await page.waitForTimeout(Math.min(10_000, Math.max(50, Number(step.value ?? 500) || 500)))
              stepNotes.push(`✓ Step ${idx + 1}: wait ${step.value ?? 500}ms`)
            }
            break
          case "evaluate": {
            const expr = step.value ?? "document.title"
            const evalOut = await page.evaluate((code) => {
              // eslint-disable-next-line no-eval
              return (0, eval)(code) as unknown
            }, expr)
            const formatted = redactKnownSecrets(JSON.stringify(evalOut) ?? String(evalOut)).slice(0, 300)
            stepNotes.push(`✓ Step ${idx + 1}: evaluate -> ${formatted}`)
            break
          }
          case "assert_text": {
            const bodyText = await page.locator(step.selector ?? "body").innerText({ timeout })
            if (!bodyText.includes(step.value ?? "")) {
              throw new Error(`Expected '${step.value ?? ""}' inside '${step.selector ?? "body"}'`)
            }
            stepNotes.push(`✓ Step ${idx + 1}: assert_text '${step.value ?? ""}'`)
            break
          }
          case "assert_visible":
            await page.locator(step.selector ?? "body").waitFor({ state: "visible", timeout })
            stepNotes.push(`✓ Step ${idx + 1}: assert_visible ${step.selector ?? "body"}`)
            break
          case "assert_hidden":
            await page.locator(step.selector ?? "body").waitFor({ state: "hidden", timeout })
            stepNotes.push(`✓ Step ${idx + 1}: assert_hidden ${step.selector ?? "body"}`)
            break
          case "assert_url":
            if (!page.url().includes(step.value ?? "")) {
              throw new Error(`Expected URL '${page.url()}' to contain '${step.value ?? ""}'`)
            }
            stepNotes.push(`✓ Step ${idx + 1}: assert_url '${step.value ?? ""}'`)
            break
          case "assert_count": {
            const expected = step.count ?? Number.parseInt(step.value ?? "0", 10)
            const actual = await page.locator(step.selector ?? "*").count()
            if (actual !== expected) {
              throw new Error(`Expected ${expected} match(es) for '${step.selector ?? "*"}', found ${actual}`)
            }
            stepNotes.push(`✓ Step ${idx + 1}: assert_count ${step.selector} === ${expected}`)
            break
          }
          case "screenshot":
            if (screenshots.length < 4) {
              const useJpeg = screenshots.length >= 2
              const buf = await page.screenshot(useJpeg ? { type: "jpeg", quality: 82 } : { type: "png" })
              const mime = useJpeg ? "image/jpeg" : "image/png"
              const ext = useJpeg ? "jpg" : "png"
              screenshots.push({
                type: "file",
                mime,
                name: `playtest-step-${idx + 1}.${ext}`,
                uri: `data:${mime};base64,${buf.toString("base64")}`,
              })
              stepNotes.push(`✓ Step ${idx + 1}: captured screenshot (${vp.width}x${vp.height})`)
            }
            break
        }
      } catch (err) {
        failedStep = `✗ Step ${idx + 1} (${step.action}) failed: ${err instanceof Error ? err.message : String(err)}`
        stepNotes.push(failedStep)
        break
      }
    }

    if (screenshots.length === 0) {
      const pngBuf = await page.screenshot({ type: "png" })
      if (pngBuf.byteLength > 360 * 1024) {
        const jpgBuf = await page.screenshot({ type: "jpeg", quality: 82 })
        screenshots.push({
          type: "file",
          mime: "image/jpeg",
          name: "playtest-final.jpg",
          uri: `data:image/jpeg;base64,${jpgBuf.toString("base64")}`,
        })
      } else {
        screenshots.push({
          type: "file",
          mime: "image/png",
          name: "playtest-final.png",
          uri: `data:image/png;base64,${pngBuf.toString("base64")}`,
        })
      }
    }

    const totalDurationMs = Date.now() - startedAt
    const title = await page.title().catch(() => "")
    const domSnippet = (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 3_200)

    const hasIssues = consoleErrors.length > 0 || networkErrors.length > 0
    const status: PlaytestOutput["status"] = failedStep ? "failed" : hasIssues ? "issues" : "passed"

    const reportLines = [
      `## 🧪 Play-Test Report (${status.toUpperCase()})`,
      `- **URL:** \`${page.url()}\`${title ? ` — **${title}**` : ""}`,
      `- **Viewport:** \`${vp.width}x${vp.height}\` · **Duration:** \`${totalDurationMs}ms\` · **Screenshots:** \`${screenshots.length}\``,
      ...(input.start_command
        ? [
            `- **Dev Server:** \`${input.start_command}\` (${reusedServer ? "reused already-open port" : "started & torn down cleanly"})`,
          ]
        : []),
      ...(stepNotes.length > 0 ? ["", "### Interactive Steps", ...stepNotes] : []),
      ...(dialogs.length > 0 ? ["", "### JS Dialogs Captured", ...dialogs.map((d) => `- ${d}`)] : []),
      ...(consoleErrors.length > 0 ? ["", "### Console & Uncaught Errors", ...consoleErrors.map((e) => `- ${e}`)] : []),
      ...(consoleWarnings.length > 0
        ? ["", "### Console Warnings", ...consoleWarnings.slice(0, 8).map((w) => `- ${w}`)]
        : []),
      ...(networkErrors.length > 0 ? ["", "### HTTP 4xx/5xx Errors", ...networkErrors.map((e) => `- ${e}`)] : []),
      ...(guardNotes().length > 0 ? ["", "### Connections Refused or Unanswered", ...guardNotes()] : []),
      ...(domSnippet.trim()
        ? ["", "### Visible DOM Snapshot", "```text", redactKnownSecrets(domSnippet.trim()), "```"]
        : []),
    ]
    const report = reportLines.join("\n")

    const output: PlaytestOutput = {
      ok: !failedStep,
      status,
      url: page.url(),
      reusedServer,
      consoleErrors,
      consoleWarnings,
      dialogs,
      networkErrors,
      report,
    }
    return {
      output,
      content: [{ type: "text", text: report }, ...screenshots],
    }
  } catch (err) {
    const notes = guardNotes()
    const msg = redactKnownSecrets(
      [
        `Playtest error: ${err instanceof Error ? err.message : String(err)}`,
        ...(notes.length > 0 ? ["", "Connections refused or unanswered:", ...notes] : []),
      ].join("\n"),
    )
    return emptyErrorResult(msg)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    guard?.close()
    if (serverProc && !reusedServer) killProcessTree(serverProc)
  }
}

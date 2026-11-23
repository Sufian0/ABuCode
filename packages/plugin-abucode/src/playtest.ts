import childProcess from "node:child_process"
import type { Tool } from "@opencode/schema/tool"
import { Schema } from "effect"
import {
  classifyCatastrophicCommand,
  isLoopbackHost,
  redactKnownSecrets,
  scrubEnvironmentRecord,
  validateFetchUrlGuard,
} from "./security.js"

const PlaytestStep = Schema.Struct({
  action: Schema.Literals([
    "goto",
    "click",
    "fill",
    "type",
    "press",
    "wait",
    "assert_text",
    "assert_visible",
    "assert_url",
    "screenshot",
  ]),
  selector: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
})
export type PlaytestStep = typeof PlaytestStep.Type

export const PlaytestInput = Schema.Struct({
  url: Schema.String.annotate({
    description: "Local loopback URL to test (must be http(s)://localhost, 127.0.0.1, or [::1]).",
  }),
  start_command: Schema.optionalKey(Schema.String).annotate({
    description: "Optional local dev-server command started with scrubbed env for the duration of the check.",
  }),
  cwd: Schema.optionalKey(Schema.String).annotate({
    description: "Working directory for start_command.",
  }),
  viewport: Schema.optionalKey(Schema.Literals(["desktop", "laptop", "tablet", "mobile"])),
  allow_external_assets: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Allow GET/HEAD requests to public CDN hosts (private LAN/tailnet remains blocked).",
  }),
  steps: Schema.optionalKey(Schema.Array(PlaytestStep)).annotate({
    description: "Optional interactive Playwright UI steps and assertions to run.",
  }),
})
export type PlaytestInput = typeof PlaytestInput.Type

export const PlaytestOutput = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.Literals(["passed", "issues", "failed", "error"]),
  url: Schema.String,
  consoleErrors: Schema.Array(Schema.String),
  networkErrors: Schema.Array(Schema.String),
  report: Schema.String,
})
export type PlaytestOutput = typeof PlaytestOutput.Type

const VIEWPORTS: Record<"desktop" | "laptop" | "tablet" | "mobile", { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  laptop: { width: 1366, height: 768 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
}

export function validatePlaytestTargetUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
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
  return { ok: true, url: parsed.toString() }
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

async function waitForLocalUrlReady(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(1500) })
      if (res.status > 0) return true
    } catch {
      // Keep polling until server binds
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function launchChromiumResilient() {
  const { chromium } = await import("@playwright/test")
  for (const channel of [undefined, "msedge", "chrome"] as const) {
    try {
      return await chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
      })
    } catch {
      continue
    }
  }
  throw new Error("Could not launch headless Chromium, Microsoft Edge, or Chrome via Playwright.")
}

export async function runPlaytestUrl(input: PlaytestInput): Promise<Tool.Result<typeof PlaytestOutput>> {
  const validated = validatePlaytestTargetUrl(input.url)
  if (!validated.ok) {
    const out: PlaytestOutput = {
      ok: false,
      status: "error",
      url: input.url,
      consoleErrors: [],
      networkErrors: [],
      report: validated.error,
    }
    return { output: out, content: [{ type: "text", text: validated.error }] }
  }

  let serverProc: childProcess.ChildProcess | undefined
  let serverLogs = ""

  if (input.start_command?.trim()) {
    const blocked = classifyCatastrophicCommand(input.start_command)
    if (blocked) {
      const out: PlaytestOutput = {
        ok: false,
        status: "error",
        url: validated.url,
        consoleErrors: [],
        networkErrors: [],
        report: blocked,
      }
      return { output: out, content: [{ type: "text", text: blocked }] }
    }

    const cleanEnv = scrubEnvironmentRecord(process.env) as NodeJS.ProcessEnv
    serverProc = childProcess.spawn(input.start_command, {
      cwd: input.cwd || process.cwd(),
      env: cleanEnv,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    const appendLog = (chunk: Buffer) => {
      if (serverLogs.length < 16_384) serverLogs += chunk.toString("utf8").slice(0, 16_384 - serverLogs.length)
    }
    serverProc.stdout?.on("data", appendLog)
    serverProc.stderr?.on("data", appendLog)

    const ready = await waitForLocalUrlReady(validated.url, 15_000)
    if (!ready) {
      killProcessTree(serverProc)
      const msg = redactKnownSecrets(
        `Timed out waiting for start_command server at ${validated.url}.\nServer logs:\n${serverLogs.slice(0, 2000)}`,
      )
      const out: PlaytestOutput = {
        ok: false,
        status: "error",
        url: validated.url,
        consoleErrors: [],
        networkErrors: [],
        report: msg,
      }
      return { output: out, content: [{ type: "text", text: msg }] }
    }
  }

  let browser: Awaited<ReturnType<typeof launchChromiumResilient>> | undefined
  const consoleErrors: string[] = []
  const networkErrors: string[] = []
  const screenshots: Tool.FileContent[] = []

  try {
    browser = await launchChromiumResilient()
    const vp = VIEWPORTS[input.viewport ?? "desktop"]
    const context = await browser.newContext({ viewport: vp })
    const page = await context.newPage()

    await page.route("**/*", async (route) => {
      const req = route.request()
      const reqUrl = req.url()
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:") || reqUrl.startsWith("about:")) {
        await route.continue()
        return
      }
      try {
        const parsed = new URL(reqUrl)
        if (isLoopbackHost(parsed.hostname)) {
          await route.continue()
          return
        }
        if (
          input.allow_external_assets &&
          (req.method() === "GET" || req.method() === "HEAD") &&
          !validateFetchUrlGuard(reqUrl)
        ) {
          await route.continue()
          return
        }
      } catch {
        // Fall through to abort
      }
      await route.abort("blockedbyclient")
    })

    page.on("console", (msg) => {
      if (msg.type() === "error" && consoleErrors.length < 25) {
        consoleErrors.push(redactKnownSecrets(msg.text()))
      }
    })
    page.on("pageerror", (err) => {
      if (consoleErrors.length < 25) {
        consoleErrors.push(redactKnownSecrets(`Uncaught: ${err.message}`))
      }
    })
    page.on("response", (res) => {
      if (res.status() >= 400 && networkErrors.length < 25) {
        networkErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`)
      }
    })

    await page.goto(validated.url, { waitUntil: "domcontentloaded", timeout: 15_000 })

    const steps = (input.steps ?? []).slice(0, 40)
    const stepNotes: string[] = []
    let failedStep: string | undefined

    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx]!
      const timeout = step.timeoutMs ?? 8_000
      try {
        switch (step.action) {
          case "goto": {
            const sub = validatePlaytestTargetUrl(step.value ?? "")
            if (!sub.ok) throw new Error(sub.error)
            await page.goto(sub.url, { waitUntil: "domcontentloaded", timeout })
            stepNotes.push(`✓ Step ${idx + 1}: goto ${sub.url}`)
            break
          }
          case "click":
            await page.locator(step.selector ?? "body").click({ timeout })
            stepNotes.push(`✓ Step ${idx + 1}: click ${step.selector}`)
            break
          case "fill":
            await page.locator(step.selector ?? "input").fill(step.value ?? "", { timeout })
            stepNotes.push(`✓ Step ${idx + 1}: fill ${step.selector}`)
            break
          case "type":
            await page.locator(step.selector ?? "input").pressSequentially(step.value ?? "", { timeout })
            stepNotes.push(`✓ Step ${idx + 1}: type ${step.selector}`)
            break
          case "press":
            await page.keyboard.press(step.value ?? "Enter")
            stepNotes.push(`✓ Step ${idx + 1}: press ${step.value ?? "Enter"}`)
            break
          case "wait":
            await page.waitForTimeout(Math.min(10_000, Math.max(50, Number(step.value ?? 500))))
            stepNotes.push(`✓ Step ${idx + 1}: wait`)
            break
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
            stepNotes.push(`✓ Step ${idx + 1}: assert_visible ${step.selector}`)
            break
          case "assert_url":
            if (!page.url().includes(step.value ?? "")) {
              throw new Error(`Expected URL '${page.url()}' to contain '${step.value ?? ""}'`)
            }
            stepNotes.push(`✓ Step ${idx + 1}: assert_url '${step.value ?? ""}'`)
            break
          case "screenshot":
            if (screenshots.length < 4) {
              const buf = await page.screenshot({ type: "png" })
              screenshots.push({
                type: "file",
                mime: "image/png",
                name: `playtest-step-${idx + 1}.png`,
                uri: `data:image/png;base64,${buf.toString("base64")}`,
              })
              stepNotes.push(`✓ Step ${idx + 1}: captured screenshot`)
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
      const finalBuf = await page.screenshot({ type: "png" })
      screenshots.push({
        type: "file",
        mime: "image/png",
        name: "playtest-final.png",
        uri: `data:image/png;base64,${finalBuf.toString("base64")}`,
      })
    }

    const title = await page.title().catch(() => "")
    const domSnippet = (await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "")).slice(0, 2400)

    const hasIssues = consoleErrors.length > 0 || networkErrors.length > 0
    const status: PlaytestOutput["status"] = failedStep ? "failed" : hasIssues ? "issues" : "passed"

    const reportLines = [
      `## Playtest Report (${status.toUpperCase()})`,
      `- **URL:** ${page.url()}`,
      `- **Title:** ${title || "(untitled)"}`,
      ...(stepNotes.length > 0 ? ["", "### Steps", ...stepNotes] : []),
      ...(consoleErrors.length > 0 ? ["", "### Console / Page Errors", ...consoleErrors.map((e) => `- ${e}`)] : []),
      ...(networkErrors.length > 0 ? ["", "### HTTP 4xx/5xx Errors", ...networkErrors.map((e) => `- ${e}`)] : []),
      ...(domSnippet.trim() ? ["", "### Visible Text Snapshot", "```text", redactKnownSecrets(domSnippet.trim()), "```"] : []),
    ]
    const report = reportLines.join("\n")

    const output: PlaytestOutput = {
      ok: !failedStep,
      status,
      url: page.url(),
      consoleErrors,
      networkErrors,
      report,
    }
    return {
      output,
      content: [{ type: "text", text: report }, ...screenshots],
    }
  } catch (err) {
    const msg = redactKnownSecrets(`Playtest error: ${err instanceof Error ? err.message : String(err)}`)
    const output: PlaytestOutput = {
      ok: false,
      status: "error",
      url: validated.url,
      consoleErrors,
      networkErrors,
      report: msg,
    }
    return { output, content: [{ type: "text", text: msg }] }
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    if (serverProc) killProcessTree(serverProc)
  }
}

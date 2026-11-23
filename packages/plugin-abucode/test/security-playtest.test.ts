import http from "node:http"
import { describe, expect, test } from "bun:test"
import { runPlaytestUrl, validatePlaytestTargetUrl } from "../src/playtest.js"
import {
  classifyCatastrophicCommand,
  commandStagesSecretEnvFile,
  evaluateShellPolicyDecision,
  redactKnownSecrets,
  scrubEnvironmentRecord,
  secretFileAccessReason,
  showHiddenCharacters,
  validateFetchUrlGuard,
} from "../src/security.js"

describe("Phase 4 — Security Bodyguards & Guarded playtest_url", () => {
  test("scrubs credential environment variables while honoring ABUCODE_PASS_ENV", () => {
    const rawEnv = {
      PATH: "/usr/bin",
      VENICE_API_KEY: "venice-super-secret-key",
      GITHUB_TOKEN: "ghp_secret123456",
      NPM_TOKEN: "npm_allowed_override",
      TOKENIZERS_PARALLELISM: "false",
      ABUCODE_PASS_ENV: "NPM_TOKEN",
    }
    const scrubbed = scrubEnvironmentRecord(rawEnv)
    expect(scrubbed.PATH).toBe("/usr/bin")
    expect(scrubbed.TOKENIZERS_PARALLELISM).toBe("false")
    expect(scrubbed.NPM_TOKEN).toBe("npm_allowed_override")
    expect("VENICE_API_KEY" in scrubbed).toBe(false)
    expect("GITHUB_TOKEN" in scrubbed).toBe(false)
  })

  test("protects .env files while permitting .env.example templates, and redacts leaked keys", () => {
    expect(secretFileAccessReason("/repo/.env")).toBeDefined()
    expect(secretFileAccessReason("/repo/.env.local")).toBeDefined()
    expect(secretFileAccessReason("/repo/.envrc")).toBeDefined()
    expect(secretFileAccessReason("/repo/.env.example")).toBeUndefined()
    expect(commandStagesSecretEnvFile("git add .env.local")).toBeDefined()
    expect(commandStagesSecretEnvFile("git add .env.example")).toBeUndefined()

    const prev = process.env.VENICE_API_KEY
    process.env.VENICE_API_KEY = "vn_test_secret_99887766"
    try {
      expect(redactKnownSecrets("Header Authorization: Bearer vn_test_secret_99887766")).toBe(
        "Header Authorization: Bearer [REDACTED API KEY]",
      )
    } finally {
      if (prev === undefined) delete process.env.VENICE_API_KEY
      else process.env.VENICE_API_KEY = prev
    }
  })

  test("enforces 4-tier policy decisions and hard-blocks catastrophic commands even in Turbo", () => {
    expect(classifyCatastrophicCommand("rm -rf /")).toBeDefined()
    expect(classifyCatastrophicCommand("mkfs.ext4 /dev/sda1")).toBeDefined()
    expect(evaluateShellPolicyDecision("turbo", "rm -rf /", "allow").effect).toBe("deny")
    expect(evaluateShellPolicyDecision("turbo", "git push origin dev", "ask").effect).toBe("allow")
    expect(evaluateShellPolicyDecision("auto", "npm test", "ask").effect).toBe("allow")
    expect(evaluateShellPolicyDecision("auto", "git push origin dev", "allow").effect).toBe("ask")
    expect(evaluateShellPolicyDecision("request_review", "ls -la", "allow").effect).toBe("ask")
  })

  test("blocks SSRF private LAN, cloud metadata, and Tailscale hosts + reveals hidden Unicode", () => {
    expect(validateFetchUrlGuard("https://example.com/docs")).toBeUndefined()
    expect(validateFetchUrlGuard("http://169.254.169.254/latest/meta-data")).toBeDefined()
    expect(validateFetchUrlGuard("http://192.168.1.10:8080/admin")).toBeDefined()
    expect(validateFetchUrlGuard("http://100.90.10.5:2222/")).toBeDefined()
    expect(validateFetchUrlGuard("http://my-box.tail2d458b.ts.net/api")).toBeDefined()

    const sneaky = "echo safe\u202Eevil\u200B"
    const visible = showHiddenCharacters(sneaky)
    expect(visible).toContain("⟦U+202E⟧")
    expect(visible).toContain("⟦U+200B⟧")
  })

  test("validates loopback-only playtest_url targets and executes headless local playtest", async () => {
    expect(validatePlaytestTargetUrl("https://google.com").ok).toBe(false)
    expect(validatePlaytestTargetUrl("http://0.0.0.0:3000").ok).toBe(false)
    expect(validatePlaytestTargetUrl("http://127.0.0.1:3000/app").ok).toBe(true)

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end("<!doctype html><html><head><title>ABuCode Smoke</title></head><body><h1>Hello Chief</h1></body></html>")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0

    try {
      const result = await runPlaytestUrl({
        url: `http://127.0.0.1:${port}/`,
        steps: [{ action: "assert_text", selector: "h1", value: "Hello Chief" }],
      })
      expect(result.output?.ok).toBe(true)
      expect(result.output?.status).toBe("passed")
      expect(result.output?.report).toContain("ABuCode Smoke")
      expect(Array.isArray(result.content)).toBe(true)
    } finally {
      server.close()
    }
  }, 25_000)
})

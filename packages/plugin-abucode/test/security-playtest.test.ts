import http from "node:http"
import { describe, expect, test } from "bun:test"
import { resolvePlaytestViewport, runPlaytestUrl, validatePlaytestTargetUrl } from "../src/playtest.js"
import {
  classifyCatastrophicCommand,
  classifyIpAddress,
  classifyShellCommand,
  commandStagesSecretEnvFile,
  evaluateShellPolicyDecision,
  redactKnownSecrets,
  scrubEnvironmentRecord,
  secretFileAccessReason,
  showHiddenCharacters,
  validateFetchUrlGuard,
  validateResolvedFetchUrlGuard,
} from "../src/security.js"

describe("Phase 4+ — Deep Shell Parser Policy, DNS SSRF Shield & 18-Action playtest_url", () => {
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

  test("protects .env, .git/, and credential files across read/write/search while permitting templates", () => {
    expect(secretFileAccessReason("/repo/.env")).toBeDefined()
    expect(secretFileAccessReason("/repo/.env.local")).toBeDefined()
    expect(secretFileAccessReason("/repo/.envrc")).toBeDefined()
    expect(secretFileAccessReason("/repo/.env.example")).toBeUndefined()
    expect(secretFileAccessReason("/repo/id_ed25519", { mode: "read" })).toBeDefined()
    expect(secretFileAccessReason("/repo/id_ed25519.pub", { mode: "read" })).toBeUndefined()
    expect(secretFileAccessReason("/repo/prod.tfvars", { mode: "search" })).toBeDefined()
    expect(secretFileAccessReason("/repo/service-account-prod.json", { mode: "read" })).toBeDefined()
    expect(secretFileAccessReason("/repo/.git/hooks/pre-commit", { mode: "write" })).toBeDefined()
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

  test("parses quoting, subshells, wrappers, inline scripts, and enforces 4-tier policy", () => {
    expect(classifyCatastrophicCommand("rm -rf /")).toBeDefined()
    expect(classifyCatastrophicCommand("mkfs.ext4 /dev/sda1")).toBeDefined()
    expect(evaluateShellPolicyDecision("turbo", "rm -rf /", "allow").effect).toBe("deny")
    expect(evaluateShellPolicyDecision("turbo", "git push origin dev", "ask").effect).toBe("allow")

    // Quoted 'rm -rf' inside echo stays safe, while $(git push) inside double quotes asks!
    expect(classifyShellCommand("echo 'rm -rf build'").kind).toBe("safe")
    expect(classifyShellCommand('echo "$(git push origin main)"').kind).toBe("ask_always")
    expect(classifyShellCommand("bash -c 'rm -rf dist'").kind).toBe("ask_always")
    expect(classifyShellCommand("env FOO=1 time git reset --hard HEAD").kind).toBe("ask_always")
    expect(classifyShellCommand('python -c "import os; os.remove(\'a.txt\')"').kind).toBe("ask_always")
    expect(classifyShellCommand("echo 'unclosed quote").kind).toBe("ask_always")

    // Package installs ask in Default, but run automatically in Auto!
    expect(evaluateShellPolicyDecision("default", "pip install pytest", "allow").effect).toBe("ask")
    expect(evaluateShellPolicyDecision("auto", "pip install pytest", "ask").effect).toBe("allow")

    // Destructive / credential / exfiltration commands still ask in Auto
    expect(evaluateShellPolicyDecision("auto", "npm test", "ask").effect).toBe("allow")
    expect(evaluateShellPolicyDecision("auto", "git push origin dev", "allow").effect).toBe("ask")
    expect(evaluateShellPolicyDecision("auto", "cat ~/.ssh/id_rsa", "allow").effect).toBe("ask")
    expect(evaluateShellPolicyDecision("request_review", "ls -la", "allow").effect).toBe("ask")
  })

  test("blocks DNS rebinding, IPv4-mapped/NAT64 IPv6, cloud IMDS, and self-API while allowing local GET when requested", async () => {
    expect(classifyIpAddress("169.254.169.254")).toBe("blocked")
    expect(classifyIpAddress("fd00:ec2::254")).toBe("blocked")
    expect(classifyIpAddress("::ffff:127.0.0.1")).toBe("local")
    expect(classifyIpAddress("64:ff9b::169.254.169.254")).toBe("blocked")

    expect(validateFetchUrlGuard("https://example.com/docs")).toBeUndefined()
    expect(validateFetchUrlGuard("http://169.254.169.254/latest/meta-data")).toBeDefined()
    expect(validateFetchUrlGuard("http://192.168.1.10:8080/admin")).toBeDefined()
    expect(validateFetchUrlGuard("http://192.168.1.10:8080/app", { method: "GET", allowLocalGet: true })).toBeUndefined()
    expect(validateFetchUrlGuard("http://192.168.1.10:8080/app", { method: "POST", allowLocalGet: true })).toBeDefined()
    expect(validateFetchUrlGuard("http://127.0.0.1:8865/api/providers", { method: "GET", allowLoopbackGet: true })).toBeDefined()

    // Simulated DNS rebinding domain resolving to AWS IMDS or private LAN
    const rebindImds = await validateResolvedFetchUrlGuard("https://evil-rebind.example/test", {
      lookupFn: async () => [{ address: "169.254.169.254" }],
    })
    expect(rebindImds).toContain("SSRF guard")

    const rebindLanPost = await validateResolvedFetchUrlGuard("https://lan-service.example/hook", {
      method: "POST",
      allowLocalGet: true,
      lookupFn: async () => [{ address: "10.0.0.42" }],
    })
    expect(rebindLanPost).toContain("SSRF guard")

    const publicOk = await validateResolvedFetchUrlGuard("https://public-docs.example/page", {
      lookupFn: async () => [{ address: "93.184.216.34" }],
    })
    expect(publicOk).toBeUndefined()

    const sneaky = "echo safe\u202Eevil\u200B"
    const visible = showHiddenCharacters(sneaky)
    expect(visible).toContain("⟦U+202E⟧")
    expect(visible).toContain("⟦U+200B⟧")
  })

  test("validates custom WxH viewports, reuses open port, handles JS dialogs, and runs expanded playtest_url steps", async () => {
    expect(validatePlaytestTargetUrl("https://google.com").ok).toBe(false)
    expect(validatePlaytestTargetUrl("http://0.0.0.0:3000").ok).toBe(false)
    expect(validatePlaytestTargetUrl("http://127.0.0.1:3000/app").ok).toBe(true)
    expect(resolvePlaytestViewport("1440x900")).toEqual({ width: 1440, height: 900 })

    const html = [
      "<!doctype html><html><head><title>ABuCode 18-Step Smoke</title></head><body>",
      "<h1>Hello Chief</h1>",
      "<select id='tier'><option value='a'>Alpha</option><option value='b'>Bravo</option></select>",
      "<input id='agree' type='checkbox' />",
      "<div id='secret' style='display:none'>Hidden Box</div>",
      "<ul class='item'><li>1</li><li>2</li></ul>",
      "<button id='dlgBtn' onclick=\"alert('Cortana ping')\">Ping</button>",
      "</body></html>",
    ].join("")

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0

    try {
      const result = await runPlaytestUrl({
        url: `http://127.0.0.1:${port}/`,
        // Passing start_command while port is already open verifies smart port reuse!
        start_command: "echo should-not-need-to-spawn",
        viewport: "1024x768",
        steps: [
          { action: "assert_text", selector: "h1", value: "Hello Chief" },
          { action: "select", selector: "#tier", value: "b" },
          { action: "check", selector: "#agree" },
          { action: "hover", selector: "#dlgBtn" },
          { action: "click", selector: "#dlgBtn" },
          { action: "assert_hidden", selector: "#secret" },
          { action: "assert_count", selector: "ul.item li", count: 2 },
          { action: "evaluate", value: "document.getElementById('tier').value" },
        ],
      })
      expect(result.output?.ok).toBe(true)
      expect(result.output?.status).toBe("passed")
      expect(result.output?.reusedServer).toBe(true)
      expect(result.output?.dialogs.some((d) => d.includes("Cortana ping"))).toBe(true)
      expect(result.output?.report).toContain("ABuCode 18-Step Smoke")
    } finally {
      server.close()
    }
  }, 30_000)
})

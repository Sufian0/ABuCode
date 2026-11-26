import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { resolvePlaytestViewport, runPlaytestUrl, validatePlaytestTargetUrl } from "../src/playtest.js"
import {
  classifyCatastrophicCommand,
  classifyIpAddress,
  classifyShellCommand,
  commandStagesSecretEnvFile,
  evaluateShellPolicyDecision,
  isEngineConfigPath,
  redactKnownSecrets,
  scrubEnvironmentRecord,
  secretFileAccessReason,
  shellConfigWrites,
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

  // The file tools pass project-relative paths, so `.git` is often the first segment.
  test("guards a .git folder by a project-relative path as well as an absolute one", () => {
    const inside = [
      ".git",
      ".git/config",
      ".git/hooks/pre-commit",
      "./.git/config",
      "packages/app/../../.git/config",
      ".GIT\\hooks\\pre-commit",
      "vendor/lib/.git/config",
      "/repo/.git",
      "/repo/.git/hooks/pre-commit",
    ]
    const beside = [
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".github/workflows/test.yml",
      "tools.git/config",
      "src/git/index.ts",
    ]

    expect(inside.filter((file) => secretFileAccessReason(file, { mode: "write" }) === undefined)).toEqual([])
    expect(beside.filter((file) => secretFileAccessReason(file, { mode: "write" }) !== undefined)).toEqual([])
    // Reading stays open except for the files that can hold a credential.
    expect(secretFileAccessReason(".git/config", { mode: "read" })).toBeDefined()
    expect(secretFileAccessReason("/repo/.git/config", { mode: "read" })).toBeDefined()
    expect(secretFileAccessReason(".git/HEAD", { mode: "read" })).toBeUndefined()
    expect(secretFileAccessReason(".gitignore", { mode: "search" })).toBeUndefined()
  })

  test("treats engine config as config however it is spelled, and leaves the Plan agent's plans and code alone", () => {
    // A base no automounter serves: macOS looks up every missing name under /home in automountd.
    const base = path.resolve("/nonexistent-abucode-test")
    const at = (relative: string) => path.join(base, relative)
    const dirs = {
      cwd: at("u/repo/app"),
      home: at("u"),
      roots: [at("u/.config/abucode"), at("etc/opencode")],
      files: [at("srv/team-config.json")],
    }
    const config = [
      "opencode.json",
      "../opencode.jsonc",
      "opencode.j\u017Fon",
      "opencode.json.",
      ".opencode/plugin/guard.ts",
      ".OpenCode/Plugins/guard.ts",
      ".opencode::$INDEX_ALLOCATION/plugins/guard.ts",
      ".opencode/command/policy.md",
      "../.opencode/agent/build.md",
      "../.opencode/plan/notes.md",
      "C:\\repo\\.opencode\\plugin\\guard.ts",
      at("u/.opencode/plugin/guard.ts"),
      at("u/.opencode/plan/opencode.json"),
      at("u/.opencode/plan/.opencode/plugins/guard.ts"),
      at("u/.config/abucode/plugin/guard.ts"),
      at("u/.Config/ABuCode/command/policy.md"),
      at("u/.config/abucode/project/p1/skills/upkeep/SKILL.md"),
      at("etc/opencode/plugin/guard.ts"),
      at("srv/team-config.json"),
    ]
    const other = [
      "src/index.ts",
      "docs/opencode.json.md",
      at("u/.opencode/plan/2026-11-25-plan.md"),
      at("u/.config/abucode-old/plugin/guard.ts"),
      at("u/.config/other/plugin/guard.ts"),
    ]

    expect(config.filter((resource) => !isEngineConfigPath(resource, dirs))).toEqual([])
    expect(other.filter((resource) => isEngineConfigPath(resource, dirs))).toEqual([])
    // A session moved into a .opencode or plan folder, or opened in the home folder, sees config as relative paths.
    expect(isEngineConfigPath("plugins/guard.ts", { ...dirs, cwd: at("u/repo/.opencode") })).toBe(true)
    expect(isEngineConfigPath("opencode.json", { ...dirs, cwd: at("u/.opencode/plan") })).toBe(true)
    expect(isEngineConfigPath(".config/abucode/plugin/guard.ts", { ...dirs, cwd: at("u") })).toBe(true)
  })

  // Windows needs extra rights to create a symbolic link.
  test.skipIf(process.platform === "win32")("follows links into config folders that exist", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abucode-config-")))
    try {
      fs.mkdirSync(path.join(root, "home/.config/abucode/plugin"), { recursive: true })
      fs.mkdirSync(path.join(root, "home/.opencode/plan"), { recursive: true })
      fs.mkdirSync(path.join(root, "repo/.opencode/plugins"), { recursive: true })
      fs.symlinkSync(path.join(root, "home/.config"), path.join(root, "repo/settings"))
      fs.symlinkSync(path.join(root, "repo/.opencode/plugins"), path.join(root, "repo/tools"))
      // A config folder that is a link into the plan folder still loads as config.
      fs.symlinkSync(path.join(root, "home/.opencode/plan"), path.join(root, "repo/.opencode/command"))
      const dirs = {
        cwd: path.join(root, "repo"),
        home: path.join(root, "home"),
        roots: [path.join(root, "home/.config/abucode")],
        files: [],
      }

      expect(isEngineConfigPath("settings/abucode/plugin/guard.ts", dirs)).toBe(true)
      expect(isEngineConfigPath("tools/guard.ts", dirs)).toBe(true)
      expect(isEngineConfigPath(".opencode/command/policy.md", dirs)).toBe(true)
      expect(isEngineConfigPath("src/index.ts", dirs)).toBe(false)
      // A write through a link to a file that does not exist yet creates that file.
      fs.symlinkSync(path.join(root, "repo/.opencode/plugins/new.ts"), path.join(root, "repo/notes.md"))
      fs.symlinkSync(path.join(root, "home/.config/abucode/plugin/new.ts"), path.join(root, "repo/todo.md"))
      expect(isEngineConfigPath("notes.md", dirs)).toBe(true)
      expect(isEngineConfigPath("todo.md", dirs)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // A folder that can be searched but not read makes realpath fail; root ignores the mode, and Windows has no such mode.
  const modesApply = process.platform !== "win32" && process.getuid?.() !== 0
  test.skipIf(!modesApply)("keeps working under folders it cannot read", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abucode-config-")))
    const dropBox = path.join(root, "repo/drop-box")
    const system = path.join(root, "system-config")
    try {
      fs.mkdirSync(dropBox, { recursive: true })
      fs.mkdirSync(system)
      fs.chmodSync(dropBox, 0o300)
      fs.chmodSync(system, 0o100)
      const dirs = { cwd: path.join(root, "repo"), home: path.join(root, "home"), roots: [system], files: [] }

      expect(isEngineConfigPath("drop-box/note.md", dirs)).toBe(false)
      expect(isEngineConfigPath("src/index.ts", dirs)).toBe(false)
      expect(isEngineConfigPath(path.join(system, "plugin/guard.ts"), dirs)).toBe(true)
    } finally {
      fs.chmodSync(dropBox, 0o700)
      fs.chmodSync(system, 0o700)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("finds the engine config a shell command writes in the common spellings, and nothing else", () => {
    const base = path.resolve("/nonexistent-abucode-test")
    const at = (relative: string) => path.join(base, relative)
    const dirs = { cwd: at("u/repo"), home: at("u"), roots: [at("u/.config/abucode")], files: [] }
    const writes = [
      `echo '{"plugins":["./x"]}' > opencode.json`,
      "printf x >> ../opencode.jsonc",
      "echo x 2> opencode.json",
      "cat > .opencode/plugins/x.ts <<'EOF'",
      "echo x | tee .opencode/command/policy.md",
      "echo x | tee -a ~/.config/abucode/plugin/x.ts",
      "cp /tmp/evil.ts .opencode/plugins/",
      "cp /tmp/opencode.json .",
      "mv /tmp/evil.ts $HOME/.config/abucode/plugin/evil.ts",
      "install -m 644 evil.ts ${HOME}/.config/abucode/plugin/evil.ts",
      "ln -s /tmp/evil.ts .opencode/plugins/x.ts",
      "touch .opencode/plugins/x.ts",
      "sed -i 's/a/b/' opencode.json",
      "sed -i.bak -e 's/a/b/' opencode.json",
      "perl -pi -e 's/a/b/' opencode.json",
      "dd if=/tmp/x of=opencode.json",
      "curl -o .opencode/plugins/x.ts https://example.com/x.ts",
      "curl --output=opencode.json https://example.com/c.json",
      "wget -O opencode.json https://example.com/c.json",
      "tar -xzf x.tgz -C .opencode/plugins",
      "unzip x.zip -d .opencode",
      "cd .opencode && echo x > plugins/x.ts",
      "cd .opencode; cd plugins; cp /tmp/x.ts .",
      `bash -c "echo x > opencode.json"`,
      "sh -c 'cp x.ts .opencode/plugins/'",
      "echo $(echo x > opencode.json)",
      "eval 'echo x > opencode.json'",
      "sudo tee opencode.json",
      "env FOO=1 cp x opencode.json",
      "find . -name '*.ts' | xargs cp -t .opencode/plugins/",
      "find . -name '*.ts' | xargs -n 1 cp -t .opencode/plugins/",
      "Set-Content -Path opencode.json -Value x",
      // Data in a heredoc does not hide what follows it.
      "cat <<'EOF' > notes.md\nit's fine\nEOF\necho x > opencode.json",
      `echo x > "my files/../opencode.json"`,
      `echo x > "$HOME"/.config/abucode/plugin/x.ts`,
      "echo x >| opencode.json",
      "echo x >& opencode.json",
      "curl -fsSLo .opencode/plugins/x.ts https://example.com/x.ts",
      "wget -qO opencode.json https://example.com/c.json",
      "wget -P .opencode/plugins https://example.com/x.ts",
      "sudo -u root tee opencode.json",
      "nice -n 10 cp x.ts .opencode/plugins/",
      "su root -c 'echo x > opencode.json'",
      "echo x > ${ABUCODE_TEST_UNSET_VARIABLE:-$HOME/.config}/abucode/plugin/x.ts",
      // Files written into a config folder the command works in.
      "cd .opencode/plugins && tar -xzf /tmp/p.tgz",
      "cd .opencode/plugins && curl -O https://example.com/x.ts",
      "cd .opencode/plugins && wget https://example.com/x.ts",
      "cd .opencode && unzip /tmp/p.zip",
      "cd .opencode/plugins && ln -s /tmp/x.ts",
      // A descriptor number or a duplication beside the command is not one of its operands.
      "cp /tmp/evil.ts .opencode/plugins/x.ts 2>&1",
      "cp /tmp/evil.ts .opencode/plugins/x.ts 2>/dev/null",
      "cp /tmp/evil.ts .opencode/plugins/x.ts >/dev/null 2>&1",
      "cp /tmp/opencode.json opencode.json 1>&2",
      "install -m 644 /tmp/evil.ts .opencode/plugins/x.ts 2>&1 && echo done",
      "ln -s /tmp/evil.ts .opencode/plugins/x.ts 2>&-",
      "rsync /tmp/evil.ts .opencode/plugins/x.ts 3>&1 1>&2 2>&3",
      "cp 2>&1 /tmp/evil.ts .opencode/plugins/x.ts",
      "sh -c 'cp /tmp/evil.ts .opencode/plugins/x.ts 2>&1'",
      "echo x 2>> opencode.json",
      "cp /tmp/evil.ts .opencode/plugins/x.ts < /dev/null",
      "cp /tmp/evil.ts .opencode/plugins/x.ts 2>&1 </dev/null",
      "cp /tmp/evil.ts .opencode/plugins/x.ts \\\n  2>&1",
      "curl -fsSL https://example.com/x.ts > \\\n  .opencode/plugins/x.ts",
      // A backslash before CR LF escapes the CR; the next line is a command of its own.
      "echo done \\\r\ncp /tmp/evil.ts .opencode/plugins/x.ts",
      "echo x >&| opencode.json",
      "echo x | tee <>/dev/null opencode.json",
      "cp /tmp/x.json opencode.json</dev/null",
      "cp /dev/stdin opencode.json <<- EOF\n\t{}\n\tEOF",
      "sed -i -f <(echo s/a/b/) opencode.json",
      "eval -- 'cp /tmp/evil.ts .opencode/plugins/x.ts'",
      "sh -c -- 'cp /tmp/evil.ts .opencode/plugins/x.ts'",
      "echo x | xargs sh -c 'cp /tmp/evil.ts .opencode/plugins/x.ts'",
      // Wrappers in front of the command, with the values of their options.
      "nohup nice -n 5 cp /tmp/evil.ts .opencode/plugins/x.ts",
      "noglob cp /tmp/x.json opencode.json",
    ]
    const other = [
      "echo x > notes.txt",
      "cat opencode.json",
      "grep plugin opencode.json",
      "sed 's/a/b/' opencode.json",
      "cp opencode.json /tmp/backup.json",
      "jq . opencode.json > /tmp/out.json",
      "ls .opencode && git status",
      "cd .opencode && ls",
      "tar -czf backup.tgz .opencode",
      "cd .opencode && ls && cd .. && echo x > notes.txt",
      "sed -i 's/.opencode\\/old/.opencode\\/new/' README.md",
      "cat <<'EOF' > notes.md\nrun echo x > opencode.json to reset it\nEOF",
      "unzip -l /tmp/p.zip",
      "curl -fsSL https://example.com/install.sh",
      "cp /tmp/x.ts src/x.ts 2>&1",
      "cat opencode.json 2>/dev/null",
      "echo opencode.json >&2",
      "head -n 2 opencode.json > notes.txt",
      "wc -l < opencode.json",
    ]

    expect(writes.filter((command) => shellConfigWrites(command, dirs).length === 0)).toEqual([])
    expect(other.filter((command) => shellConfigWrites(command, dirs).length > 0)).toEqual([])
    // The command's own working folder counts: a relative target inside a .opencode folder is config.
    expect(shellConfigWrites("echo x > guard.ts", dirs, { workdir: ".opencode/plugins" })).toEqual([
      at("u/repo/.opencode/plugins/guard.ts"),
    ])
  })

  // Windows runs commands in PowerShell, which reads backslashes, backticks and here-strings its own way.
  test("finds the engine config a PowerShell command writes", () => {
    const base = path.resolve("/nonexistent-abucode-test")
    const at = (relative: string) => path.join(base, relative)
    const dirs = { cwd: at("u/repo"), home: at("u"), roots: [at("u/.config/abucode")], files: [] }
    const writes = [
      "Set-Content -Path .\\opencode.json -Value '{}'",
      "Copy-Item x.ts .opencode\\plugins\\",
      "cp x.ts .opencode\\plugins\\",
      "'x' | tee .opencode\\plugins\\x.ts",
      '"a`nb" | Out-File .opencode/plugins/x.ts',
      "@'\n// it's a plugin\n'@ | Set-Content -Path .opencode\\plugins\\x.ts",
      "Set-Content -Path $env:HOME\\.config\\abucode\\plugin\\x.ts -Value x",
      "sc .opencode\\plugins\\x.ts 'x'",
      "ni -Path .opencode\\plugins -Name x.ts -ItemType File",
      "cpi -Destination .opencode\\plugins -Path x.ts",
      "ren notes.txt opencode.json",
      "Expand-Archive p.zip -DestinationPath .opencode\\plugins",
      "cd .opencode\\plugins; Set-Content x.ts 'x'",
      "Invoke-WebRequest https://example.com/x.ts -outFile .opencode\\plugins\\x.ts",
    ]

    expect(writes.filter((command) => shellConfigWrites(command, dirs, { powershell: true }).length === 0)).toEqual([])
    expect(shellConfigWrites("Get-Content opencode.json; 'x' > notes.txt", dirs, { powershell: true })).toEqual([])
  })

  // macOS reaches the whole system volume again under /System/Volumes/Data, which no lexical check sees.
  test.skipIf(process.platform !== "darwin")("follows the macOS data-volume spelling of a config folder", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abucode-config-")))
    try {
      fs.mkdirSync(path.join(root, ".config/abucode/plugin"), { recursive: true })
      const dirs = { cwd: path.join(root, "repo"), home: root, roots: [path.join(root, ".config/abucode")], files: [] }

      expect(isEngineConfigPath(path.join("/System/Volumes/Data", root, ".config/abucode/plugin/guard.ts"), dirs)).toBe(
        true,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
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

  test("never permits a recursive delete of the root or home folder, however it is spelled", () => {
    const denied = [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf ~/",
      "rm -rf /*",
      "rm -rf ~/*/",
      'rm -rf "$HOME"',
      "rm -rf $HOME/",
      'rm -rf "${HOME}"/*',
      "rm -r -f /",
      "rm --recursive --force ~",
      "rm -R ~",
      "rm -rf -- /",
      "sudo rm -rf --no-preserve-root /",
      "/bin/rm -rf ~/",
      // A stray space splits one path into two operands.
      "rm -r ~ /project",
      "rm -rf ./build /",
      "rm ~ -rf",
      "rm -rf /; echo done",
      "rm -rf \\\n  ~/",
      "echo ok \\\r\nrm -r -f ~",
      "rm -rf ~</dev/null",
      'rm -rf "$(pwd)/build" ~/',
      `bash -c "rm -rf ~/"`,
      "bash -c -- 'rm -r ~'",
      "xargs sh -c 'rm -rf ~/'",
      `eval "rm -rf ~"`,
      "echo $(rm -rf ~/)",
      "if true; then rm -rf ~/; fi",
      "cat <<'EOF' > notes.md\nit's done\nEOF\nrm -rf ~/",
      // Wrappers in front, with the values of their options.
      "nohup nice -n 5 rm -rf ~/",
      "FOO=1 sudo -u root rm -rf ~/",
      "noglob rm -rf ~/",
      // The home folder by its own path, and the folders above it.
      "rm -rf /home/u",
      "rm -rf /home/u/ Documents/build",
      "rm -rf /home",
      "rm -rf /$HOME",
      "rm -rf ~/../*",
      // Patterns over everything in home or root, and brace lists that make one.
      "rm -rf ~/.*",
      "rm -r ~/**",
      "rm -rf ~/.??*",
      "rm -R /*/*",
      "rm -rf ~/{a,}",
      "rm -r ~/{*,.*}",
    ]
    const allowed = [
      "rm -rf ~/project/node_modules",
      "rm -rf /home/u/project",
      "rm -rf /home/other",
      "rm -rf ./build",
      "rm -rf /tmp/abucode-test",
      'rm -rf "$HOME/.cache/abucode"',
      'rm -rf "$(mktemp -d)/"',
      "rm -rf $(find ~ -name .DS_Store)",
      "rm -rf $HOMEDIR",
      "rm -rf ~other/build",
      "rm -f ~/notes.txt",
      "rm -rf build && cd /",
      "rm -rf dist # remove the build / cache",
      "git rm -r --cached .",
      "docker run --rm -v ~:/data image",
      "rm -rf ~/Library/Caches/*",
      "rm -rf ~/Downloads/*.dmg",
      "rm -rf ~/.{npm,yarn}",
      "rm -rf ~/{Library/Caches,.cache}/myapp",
      "ls | xargs -I{} rm -rf ~/{}",
      // `${NAME:?}` stops the command when NAME is unset or empty, so it is never root.
      'rm -rf "${ABUCODE_TEST_UNSET_VARIABLE:?}"/*',
      // A mention in a message or a search is not a delete, nor is the body of a quoted heredoc.
      `git commit -m "fix(abucode): refuse rm -rf ~/ too"`,
      "echo 'rm -rf ~'",
      `grep -rn "rm -rf ~" docs`,
      "git commit -m \"$(cat <<'EOF'\nfix(abucode): refuse `rm -rf ~/` and `rm -r ~`\nEOF\n)\"",
    ]

    expect(denied.filter((command) => classifyCatastrophicCommand(command, "/home/u") === undefined)).toEqual([])
    expect(allowed.filter((command) => classifyCatastrophicCommand(command, "/home/u") !== undefined)).toEqual([])
    // Windows gives the home folder as C:\Users\x.
    expect(classifyCatastrophicCommand("rm -r ~", "C:\\Users\\x")).toBeDefined()
    expect(classifyCatastrophicCommand('rm -r "$HOME"/*', "C:\\Users\\x")).toBeDefined()
    expect(classifyCatastrophicCommand("rm -r ~/project", "C:\\Users\\x")).toBeUndefined()
    // Turbo allows whatever the list does not refuse.
    expect(evaluateShellPolicyDecision("turbo", "rm -rf ~/", "allow").effect).toBe("deny")
    expect(evaluateShellPolicyDecision("turbo", "rm -rf ~/project/node_modules", "allow").effect).toBe("allow")
  })

  test("rates an eval as the command line it runs", () => {
    const rated = [
      [`eval "ls -la"`, "safe"],
      [`eval "curl https://example.com"`, "ask_default"],
      [`eval "git push origin dev"`, "ask_always"],
      ["eval git push origin dev", "ask_always"],
      [`eval -- "git push origin dev"`, "ask_always"],
      [`builtin eval "git push origin dev"`, "ask_always"],
      ["FOO=1 eval 'cat .env.local'", "ask_always"],
      [`eval "eval 'git push origin dev'"`, "ask_always"],
      [`sh -c 'eval "git push origin dev"'`, "ask_always"],
      [`ls && eval "rm -rf build"`, "ask_always"],
      [`eval "rm -rf ~"`, "deny"],
      // What these run is not known until they run: the shell expands the variable before eval reads the text.
      [`eval "$COMMAND"`, "ask_always"],
      [`eval "$(cat script.sh)"`, "ask_always"],
      [`eval "ls $DIR"`, "ask_always"],
      [`X='; git push origin dev'; eval "true $X"`, "ask_always"],
      // The word alone changes nothing.
      ["eval", "safe"],
      ["grep eval src/index.ts", "safe"],
      ["bun run eval", "safe"],
    ] as const

    expect(rated.filter(([command, kind]) => classifyShellCommand(command).kind !== kind)).toEqual([])
    expect(evaluateShellPolicyDecision("default", `eval "git push origin dev"`, "allow").effect).toBe("ask")
    expect(evaluateShellPolicyDecision("auto", `eval "ls -la"`, "allow").effect).toBe("allow")
  })

  test("rates the command a keyword, a wrapper or a shell runs, not the word in front of it", () => {
    const base = path.resolve("/nonexistent-abucode-test")
    const at = (relative: string) => path.join(base, relative)
    const dirs = { cwd: at("u/repo"), home: at("u"), roots: [at("u/.config/abucode")], files: [] }
    const rated = [
      ["if git push origin dev; then echo pushed; fi", "ask_always"],
      ["for b in main dev; do git push origin $b; done", "ask_always"],
      ["while true; do rm -rf build; done", "ask_always"],
      ["! git push origin dev", "ask_always"],
      ["if true; then :; else curl https://example.com; fi", "ask_default"],
      ["nice -n 5 git push --force origin dev", "ask_always"],
      ["echo x | xargs -n 1 git push origin", "ask_always"],
      ["bash -c -- 'git push origin dev'", "ask_always"],
      ["bash -c -e 'git push origin dev'", "ask_always"],
      ["git 2>/dev/null push origin dev", "ask_always"],
      ["echo ok \\\r\ngit push --force origin dev", "ask_always"],
      ["for f in *.ts; do echo $f; done", "safe"],
      ["if [ -f package.json ]; then bun test; fi", "safe"],
      // The descriptor numbers are not package names.
      ["bun install 2>&1 | tail -5", "safe"],
    ] as const
    const writes = [
      "for f in /tmp/*.ts; do cp $f .opencode/plugins/; done",
      "if true; then cp /tmp/evil.ts .opencode/plugins/x.ts; fi",
      "if test -f x; then :; else cp /tmp/evil.ts opencode.json; fi",
      "while read f; do cp $f .opencode/plugins/; done < list.txt",
      "until false; do cp /tmp/evil.ts opencode.json; done",
    ]

    expect(rated.filter(([command, kind]) => classifyShellCommand(command).kind !== kind)).toEqual([])
    expect(writes.filter((command) => shellConfigWrites(command, dirs).length === 0)).toEqual([])
    expect(shellConfigWrites("for f in src/*.ts; do cp $f /tmp/backup/; done", dirs)).toEqual([])
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

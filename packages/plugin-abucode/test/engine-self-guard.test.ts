import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { runPlaytestUrl } from "../src/playtest.js"
import { type AgentLlmCaller, runHouseholdSubagents } from "../src/squad.js"
import {
  engineStateFileReason,
  evaluateShellPolicyDecision,
  isEngineStatePath,
  isOwnServerUrl,
  playtestConnectionAddresses,
  shellEngineStateReferences,
  validateFetchUrlGuard,
  validateResolvedFetchUrlGuard,
} from "../src/security.js"

// A home folder with the usual layout and the files the engine writes there.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abucode-engine-self-")))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const home = path.join(root, "home")
const project = path.join(home, "project")
const config = path.join(home, ".config", "abucode")
const state = path.join(home, ".local", "state", "abucode")
const data = path.join(home, ".local", "share", "abucode")
const custom = path.join(root, "custom", "engine.sqlite")
for (const folder of [project, config, state, data, path.join(data, "repos", "lib"), path.dirname(custom)])
  fs.mkdirSync(folder, { recursive: true })
for (const file of [
  path.join(config, "service-local.json"),
  path.join(state, "service-local.json"),
  path.join(data, "opencode-local.db"),
  path.join(data, "opencode-local.db-wal"),
  path.join(data, "opencode-local.db-shm"),
  path.join(config, "opencode.json"),
  custom,
])
  fs.writeFileSync(file, "{}")
const dirs = { cwd: project, home, service: [config, state], data: [data], databases: [custom] }
const names = (command: string, workdir?: string) => shellEngineStateReferences(command, dirs, { workdir })
const unnamed = (commands: readonly string[], workdir?: string) =>
  commands.filter((command) => names(command, workdir).length === 0)

describe("ABuCode guard for the engine's own state and server", () => {
  test("knows the engine's state files however a file tool names them, and nothing else", () => {
    const named = [
      "~/.config/abucode/service-local.json",
      "~/.local/state/abucode/service-local.json",
      path.join(state, "service-local.json"),
      "../.local/state/abucode/service-local.json",
      path.join(state, "service.json"),
      path.join(state, "service-local.json.4242.tmp"),
      "~/.local/share/abucode/opencode-local.db",
      "~/.local/share/abucode/opencode-local.db-wal",
      "~/.local/share/abucode/opencode-local.db-shm",
      "~/.local/share/abucode/opencode.db-journal",
      // Names match without case everywhere; on Linux this is another file, which is refused too.
      "~/.LOCAL/State/ABUCODE/Service-Local.JSON",
      custom,
      `${custom}-wal`,
    ]
    const others = [
      "~/.config/abucode/opencode.json",
      "~/.local/share/abucode/repos/lib/opencode.db",
      "service-local.json",
      "README.md",
      "~/.config/abucode/service-local.json.bak",
    ]

    expect(named.filter((target) => !isEngineStatePath(target, dirs))).toEqual([])
    expect(others.filter((target) => isEngineStatePath(target, dirs))).toEqual([])
  })

  // Windows needs extra rights to create a symbolic link.
  test.skipIf(process.platform === "win32")("follows a link to a state file or to its folder", () => {
    fs.symlinkSync(state, path.join(project, "state-link"))
    fs.linkSync(path.join(state, "service-local.json"), path.join(project, "hard-link.json"))

    expect(isEngineStatePath("state-link/service-local.json", dirs)).toBe(true)
    expect(isEngineStatePath("hard-link.json", dirs)).toBe(true)
    expect(names("cat state-link/service-local.json")).not.toEqual([])
  })

  test("refuses a file tool the state files, and a search whose folder holds them", () => {
    expect(engineStateFileReason("~/.config/abucode/service-local.json", dirs, "read")).toMatch(
      /^`service-local\.json` is the ABuCode engine's own state/,
    )
    expect(engineStateFileReason("~/.local/share/abucode/opencode-local.db", dirs, "write")).toBeDefined()
    // The grep tool reads hidden folders, so a search of any folder at or above the state folders reaches them.
    const searches = ["~/.config", "~/.config/abucode", "~/.local", "~/.local/state", "~", "..", ".", "~/.local/share/abucode/repos"]
    expect(searches.filter((target) => engineStateFileReason(target, dirs, "search") === undefined)).toEqual([
      ".",
      "~/.local/share/abucode/repos",
    ])
    // A listing reads no file.
    expect(engineStateFileReason("~/.config/abucode", dirs, "read")).toBeUndefined()
  })

  test("finds the state files a shell command names, however it names them", () => {
    const named = [
      "cat ~/.config/abucode/service-local.json",
      "cat $HOME/.local/state/abucode/service-local.json",
      'cat "${HOME}/.local/state/abucode/service-local.json"',
      "cat < ~/.config/abucode/service-local.json",
      "cat <~/.config/abucode/service-local.json",
      "cat ~/.config/abucode/service-*.json",
      "cat ~/.config/abucode/*",
      // Bracket expressions, POSIX classes included, which the shells expand like any glob.
      "cat ~/.local/state/abucode/[[:alpha:]]ervice-local.json",
      "sqlite3 ~/.local/share/abucode/opencode-local.d[[:lower:]] .dump",
      "cat ~/.local/state/abucode/[[s]ervice-local.json",
      "cat ~/.local/state/abucode/servic[!x]-local.json",
      "bash -c 'cat ~/.local/state/abucode/[[=s=]]ervice-local.json'",
      "bash -c 'cat ~/.local/state/abucode/[[.s.]]ervice-local.json'",
      "sqlite3 ~/.local/share/abucode/opencode-local.d[[=b=]] .dump",
      // A glob through a dot folder, which a shell's startup files can let `*` match.
      "cat ~/*/abucode/service-local.json",
      "cat ~/*/abucode/service-local.json(Dr)",
      "cd ~/.config/abucode && cat service-local.json",
      "jq -r .password ~/.local/state/abucode/service-local.json",
      'sqlite3 ~/.local/share/abucode/opencode-local.db "update kv set value = \'turbo\'"',
      `sqlite3 ${custom} .dump`,
      "DB=~/.local/share/abucode/opencode-local.db sqlite3 x",
      "echo x > ~/.local/share/abucode/opencode-local.db",
      'bash -c "cat ~/.config/abucode/service-local.json"',
      'echo "$(cat ~/.local/state/abucode/service-local.json)"',
      // Inline code and heredoc bodies, in the spellings interpreters read the same way.
      `python3 -c "import sqlite3; sqlite3.connect('${data}/opencode-local.db')"`,
      `python3 -c "print(open(os.environ['HOME'] + '/.config/abucode/service-local.json').read())"`,
      `python3 -c "print(open('$HOME/.local/./state/abucode/service-local.json').read())"`,
      `ruby -e 'puts File.read(Dir.home + "/.local//state/abucode/service-local.json")'`,
      `python3 -c "open('${home}/.local/share/../state/abucode/service-local.json')"`,
      `python3 -c "open('%s/.local/state/abucode/service-local.json' % os.environ['HOME'])"`,
      `perl -e 'open(F, $ENV{HOME}."/.local/state/abucode/service-local.json"); print <F>'`,
      `python3 -c "open('/.local/state/abu\\\ncode/service-local.json')"`,
      `sqlite3 :memory: "ATTACH 'file:${data.replaceAll("/", "%2F")}%2Fopencode-local.db?mode=ro' AS a"`,
      `cat ~${path.basename(home)}/.local/state/abucode/service-local.json`,
      "python3 - <<'EOF'\nimport os\nprint(open(os.path.expanduser('~/.local/state/abucode/service-local.json')).read())\nEOF",
      "sqlite3 <<'EOF'\n.open ~/.local/share/abucode/opencode-local.db\nselect * from kv;\nEOF",
      // Brace lists and ranges, zsh groups and ANSI-C quoting.
      "cat ~/.local/state/abucode/{service-local.json,x}",
      "cat ~/.local/state/abucode/service-local.js{on,}",
      "cat ~/.local/state/abucode/ser{v..v}ice-local.json",
      "cat ~/.local/state/abucode/(service|x)-local.json",
      "cat ~/.local/state/abucode/(service)-local.json",
      "cat ~/.local/state/abucode/$'service-local.json'",
      "cat ~/.local/state/abucode/service$''-local.json",
      "cat ~/.local/state/abucode/$'\\x73'ervice-local.json",
      "cat ~/.local/state/abucode/$'\\163'ervice-local.json",
      // Folder changes the scan cannot follow, also inside `sh -c`.
      "sh -c 'cd ~/.local/state/abucode && (cd /) && cat service-local.json'",
      "cd ~/.local/state/abucode; cd /; cd - >/dev/null; cat service-local.json",
      "cd ~/.local/state/abucode && cd / | true && cat service-local.json",
      "pushd ~/.local/state/abucode && pushd / && popd && cat service-local.json",
      "cd ~/.local/state/abucode && cd / && cat ~-/service-local.json",
      "cd ~/.local/st*/abucode && cat service-local.json",
      "sh -c 'cd ~/.local/st*/abucode && cat service-local.json'",
      "sh -c 'cd $(dirname ~/.local/state/abucode/x) && cat service-local.json'",
      `sh -c 'cd "$1" && cat service-local.json' _ ${state}`,
      "CDPATH=~/.local/state cd abucode && cat service-local.json",
      // zsh's two-word `cd`, with options and redirections anywhere around the words.
      "cd project 2>/dev/null .local/state/abucode && cat service-local.json",
      "cd project > /dev/null .local/state/abucode && cat service-local.json",
      "cd project 2>&1 .local/share/abucode && sqlite3 opencode-local.db .dump",
      "cd 2>/dev/null project .local/state/abucode && cat service-local.json",
      "cd project>/dev/null .local/state/abucode && cat service-local.json",
      "cd project <<< x .local/state/abucode && cat service-local.json",
      "cd -q project .local/state/abucode && cat service-local.json",
      "chdir project .local/state/abucode && cat service-local.json",
      // A script a shell reads from a heredoc or a here-string, and zsh's `emulate -c`.
      "bash <<'EOF'\ncd ~/.local/state/abucode\ncat service-local.json\nEOF",
      "sh -s <<'EOF'\ncd ~/.config/abucode\ncat service*.json\nEOF",
      "bash <<'EOF'\ngrep -r password ~/.config\nEOF",
      "zsh <<<'cat ~/.config/abucode/s*'",
      "emulate zsh -c 'cat ~/.config/abucode/s*'",
      "emulate sh -c 'cd ~/.local/state/abucode && cat service-local.json'",
      "emulate zsh -c -- 'cat ~/.config/abucode/s*'",
      "cd ~/.config && bash <<'EOF'\ngrep -r password .\nEOF",
      "cd ~/.local/state && bash <<'EOF'\ncat abucode/s*\nEOF",
      "bash <<'EOF'\ncat ~/.config/abucode/{s,x}ervice-local.js?n\nEOF",
      "bash -euo pipefail <<'EOF'\ncat ~/.config/abucode/s*\nEOF",
      "bash -s -- arg <<'EOF'\ncat ~/.config/abucode/s*\nEOF",
      "source /dev/stdin <<'EOF'\ncat ~/.config/abucode/s*\nEOF",
      "eval 'cd -q project .local/state/abucode'; cat service-local.json",
      // A reader behind a launcher the scan does not know, and a container given the folder.
      "caffeinate -i grep -r password ~/.config",
      "xcrun grep -r password ~/.config",
      "uv run python -m tarfile --create /tmp/x.tar ~/.local/state",
      "docker run --rm -v ~/.config:/cfg alpine cat /cfg/abucode/service-local.json",
      "docker run --rm --mount type=bind,src=$HOME/.local/state,dst=/s alpine ls /s",
      "docker cp ~/.config/abucode box:/tmp/",
      "echo {,}{,}{,}{,}{,}; cat ~/.config/abucode/{s,{x,y}}ervice-local.jso?",
      "echo {,}{,}{,}{,}{,}; cd ~/.local/st{a,}te/abucode && cat service-local.json",
      "npx tsx scripts/copy.ts ~/.config out",
      "emulate zsh -c'cat ~/.config/abucode/s*'",
      // A glob too long to spell a path, which the shells still expand a segment at a time, and brace lists past the
      // ones the scan expands.
      `cat ~/.config/abucode/s[${"e".repeat(4100)}]rvice-local.json`,
      `cat ~/.config/abucode/s${"*".repeat(4100)}`,
      "cat ~/.config/abucode/{,}{,}{,}{,}{,}{s,x}ervice-local.json",
      "echo {,}{,}{,}{,}{,} ; cat ~/.config/abucode/{s,x}ervice-local.jso?",
      // Commands that read, move or link a folder whole, also by a glob.
      "grep -r password ~/.config",
      "grep -r password ~/.config/*",
      "grep -rn password ~/.local/state/*",
      "grep -r password ~/.local/sta*",
      "rg --hidden password ~/.local/st*",
      "tar czf /tmp/engine.tgz ~/.local/state/abucode",
      "git diff --no-index /tmp/empty ~/.local/state/abucode",
      "diff -r -N ~/.local/state/abucode /tmp/empty",
      "git -C ~/.local/state/abucode grep --no-index -h password",
      "pax -w ~/.local/state/abucode",
      "cd ~/.local/state && mv abucode abucode-x",
      "cd ~/.local/state && mv abuc* x",
      "ln -s ~/.local/state/abucode /tmp/link && cat /tmp/link/service-local.json",
      "cd ~/.local/state/abucode && ln service-local.json ~/project/copy.json",
      "cd ~ && cp -r -t backup .local/state/abucode",
      "cd ~ && cp -rt backup .local/state/abucode",
      "cd ~ && cp -r --target-directory=backup .local/state/abucode",
      "rg --hidden password ~",
      "rg -uu password ~",
      // A `*` that the command lets match names starting with a dot, in the spellings bash and zsh accept.
      "shopt -s dotglob; grep -r password ~/*",
      "shopt -s dot''glob; grep -r password ~/*",
      "setopt G_LOB_DOTS; grep -r password ~/*",
      "unsetopt noglobdots; tar czf /tmp/x.tgz ~/*",
      "set -4; grep -r password ~/*",
      "GLOBIGNORE+=x; grep -r password ~/*",
      "grep -r password ~/*(D)",
      "grep -r password ~/*(#qD)",
      "setopt glob{dots,}; grep -r password ~/*",
      "shopt -s dotgl{o,}b; grep -r password ~/*",
      "setopt glob${:-dots}; grep -r password ~/*",
      "zsh --glob-dots -c 'grep -r password ~/*'",
      "emulate sh -4; grep -r password ~/*",
      "grep -r password ~/*(e:'true || true':D)",
      "setopt glob${unset_name:-dots}; grep -r password ~/*",
      "echo {,}{,}{,}{,}{,}; setopt glob{dots,}; grep -r password ~/*",
      // A state folder, or one above it, named in an interpreter's code.
      `python3 -c "import os; os.rename(os.path.expanduser('~/.local/state/abucode'), '/tmp/x')"`,
      `python3 -c "import shutil; shutil.copytree('${state}/', 'copy')"`,
      `python3 -c "import shutil, os; shutil.copytree(os.path.expanduser('~/.local/state'), 'copy')"`,
      `python3 -c "import os; os.rename(os.path.expanduser('~/.config'), os.path.expanduser('~/.cfg'))"`,
      `python3 -c "import glob, os; print(glob.glob(os.path.expanduser('~/.local/state/abucode/*')))"`,
      `python3 -c "import glob, os; print(glob.glob(os.path.expanduser('~/.local/state/*/s*')))"`,
      `node -e "const d = require('os').homedir() + '/.local/state/abucode/'; console.log(require('fs').readdirSync(d))"`,
      `python3 -c "import os; h = os.path.expanduser('~'); print(open(f'{h}/.local/state/abucode/{chr(115)}ervice-local.json').read())"`,
      `python3 -c "import glob, os; print(open(glob.glob(os.path.expanduser('~/.local/state/abucode/s*'))[0]).read())"`,
      `python3 -c "import glob, os, sqlite3; sqlite3.connect(glob.glob(os.path.expanduser('~/.local/share/abucode/o*.db'))[0])"`,
      `python3 -c "import glob, os; print(glob.glob(os.path.expanduser('~/.local/state/abucode*/*')))"`,
      `python3 -c "import glob, os; print(glob.glob(os.path.expanduser('~/.local/state/a*/service-local.json')))"`,
      `python3 -c "import os; print(open(os.path.expanduser('~/.local/state/abucode/s' 'ervice-local.json')).read())"`,
      `ruby -e 'f = "service-local.json"; puts File.read("#{Dir.home}/.local/state/abucode/#{f}")'`,
      `node -e "console.log(require('fs').readFileSync(require('os').homedir() + '/.local/state/abucode/'.concat('service-local.json'), 'utf8'))"`,
      // Code that steps back up from a path it names whole.
      `python3 -c "import os; print(open(os.path.join(os.path.dirname(os.path.expanduser('~/.local/state/abucode/x')), 'service-local.json')).read())"`,
      `python3 -c "import os; print(open(os.path.normpath(os.path.join(os.path.expanduser('~/.local/state/abucode/x'), '..', 'service-local.json'))).read())"`,
      `python3 -c "from pathlib import Path; print((Path('~/.local/state/abucode/x').expanduser().parent / 'service-local.json').read_text())"`,
      `python3 -c "import glob, os; print(glob.glob(os.path.dirname(os.path.expanduser('~/.local/state/abucode/x')) + '/*'))"`,
      `python3 -c "import shutil, os; shutil.copytree(os.path.dirname(os.path.expanduser('~/.config/abucode/opencode.json')), 'copy')"`,
      `python3 -c "import os; print(os.listdir(os.path.abspath(os.path.join(os.path.expanduser('~/.local/state/abucode/x'), os.pardir))))"`,
      `python3 -c "import glob, os; print(glob.glob(os.path.join(os.path.dirname(os.path.expanduser('~/.local/state/x')), 'abucode', 's*')))"`,
      // An interpreter given a folder above them as a script's or a module's argument, or code in quotes the shell drops.
      "python3 -m tarfile --create /tmp/state.tar ~/.local/state",
      "python3 copy.py ~/.local/state out",
      `python3 <(echo 'import shutil, os; shutil.copytree(os.path.expanduser("~/.local/state"), "copy")')`,
      `python3 '-c' "import shutil, os; shutil.copytree(os.path.expanduser('~/.local/state'), 'copy')"`,
      `pyth''on3 -c "import os; print(open(os.path.expanduser('~/.local/state/abucode/s') + 'ervice-local.json').read())"`,
    ]
    expect(unnamed(named)).toEqual([])
    // Inside the engine's own folders, as in a worktree session, a relative path reaches them however far up it goes.
    const worktree = path.join(data, "worktree", "abc", "wt1")
    expect(
      unnamed(
        [
          `python3 -c "print(open('../../../opencode-local.db', 'rb').read(16))"`,
          `node -e "console.log(require('fs').readFileSync(require('path').resolve('../../..', 'opencode-local.db')).length)"`,
          `python3 -c "import glob, sqlite3; print(sqlite3.connect(glob.glob('../../../*.db')[0]))"`,
          `node -e "console.log(require('fs').readdirSync('../../..'))"`,
        ],
        worktree,
      ),
    ).toEqual([])
    // The shell tool's working folder counts like a `cd`, inline code included.
    expect(names("cat service-local.json", state)).toEqual([path.join(state, "service-local.json")])
    expect(
      unnamed(
        [
          `python3 -c "print(open('service-local.json').read())"`,
          `perl -e 'open(F, "service-local.json"); print <F>'`,
          "ls",
        ],
        state,
      ),
    ).toEqual([])
    expect(names(`python3 -c "open('abucode/service-local.json')"`, path.dirname(state))).not.toEqual([])
    expect(names(`cat $PWD/.local/state/abucode/service-local.json`, home)).not.toEqual([])
    // A folder is reported by the state files inside it.
    expect(names("grep -r password ~/.local/state")).toEqual([path.join(state, "service-local.json")])
  })

  test("leaves ordinary commands alone", () => {
    const ordinary = [
      "cat README.md",
      "ls ~/.config/abucode",
      "grep -rn TODO src",
      "git status",
      "cat ~/notes/service.md",
      "cp build/app ~/",
      "mv notes.txt ~/",
      "cd src && cat service-local.json",
      // rg and ag skip hidden folders.
      "rg -n 'alias ll' ~",
      "ag TODO ~",
      // The same layout under another folder, such as a test fixture's home, is another engine's.
      "sqlite3 /tmp/test-home/.local/share/abucode/opencode-local.db .tables",
      "cat test/fixture/home/.config/abucode/service.json",
      `python3 -c "open(os.path.expanduser('~/.config/nvim/init.lua'))"`,
      // POSIX classes, which a glob matcher can fail to compile.
      "grep -nE '^[[:space:]]*- ' README.md",
      "awk -F'[[:space:]]*=[[:space:]]*' '{print $1}' settings.ini",
      // A redirection after a `cd` target is not zsh's two-word `cd`.
      "cd src 2>/dev/null && cat service-local.json",
      "cd src >/dev/null && cat service-local.json",
      // Interpreters given paths below the engine's folders that are not its state: a worktree, a log, its config.
      `cd ${data}/worktree/abc/wt1 && bun --version`,
      `node ${data}/repos/lib/build.js`,
      "python3 -m json.tool ~/.config/abucode/opencode.json",
      `tail -n 5 ${data}/log/dev.log | python3 -c "import sys; print(sys.stdin.read())"`,
      // The folders above them, in commands that carry no code of their own.
      "XDG_CONFIG_HOME=~/.config bun test",
      "export XDG_DATA_HOME=$HOME/.local/share; bun run dev",
      "mkdir -p ~/.local/share && node scripts/install.js",
      "ls ~/.config && bun --version",
      "du -sh ~/.local/share/* | sort -h | tail -5; node -v",
      // Names that end like those folders.
      `node -e "require('dotenv').config({ path: '.env.local' }); console.log(process.env.API_URL)"`,
      `python3 -c "from app.config import settings; print(settings.DEBUG)"`,
      `python3 -c "import requests; print(requests.get('http://raspberrypi.local:8080/health').status_code)"`,
      `node -e "console.log(require('./next.config'))"`,
      // Another file named like a state file, under a folder above them.
      `python3 -c "import json, os; print(json.load(open(os.path.expanduser('~/.config/gcloud/service-account.json')))['client_email'])"`,
      // An interpreter given the folder above the project, which is the home folder here.
      "python3 -m pip install -e ..",
      "bun add ..",
      "python3 -m pip install --prefix ~/.local/share/venvs/app .",
      // Long quoted text with glob characters, which the shell never expands.
      `gh pr create --title "Fix" --body "${"- [ ] check *this* item\n".repeat(220)}"`,
      `git commit -m "${"* tidy a thing\n".repeat(340)}"`,
      `sqlite3 app.db "SELECT * FROM events WHERE id IN (${Array.from({ length: 900 }, (_, index) => index).join(", ")})"`,
    ]
    expect(ordinary.filter((command) => names(command).length > 0)).toEqual([])
    // `*` skips the dot folders, as the shells' does.
    expect(unnamed(["grep -r TODO * 2>/dev/null | head -3", "tar czf /dev/null *"], home)).toHaveLength(2)
    const worktree = path.join(data, "worktree", "abc", "wt1")
    const inWorktree = [
      "python3 $PWD/scripts/gen.py",
      "python3 scripts/gen.py",
      "bun run build",
      `bun test ${worktree}/packages/core/test/a.test.ts && ls ..`,
      `python3 -c "import os; print(os.listdir('$PWD/..'))"`,
      `node -e "console.log(require('path').dirname('${worktree}/package.json'))"`,
      `python3 -c "from pathlib import Path; print(Path('${worktree}/src/app.py').parent)"`,
    ]
    expect(unnamed(inWorktree, worktree)).toHaveLength(inWorktree.length)
  })

  // Each of these once took seconds to minutes, so a regression times the test out.
  test("reads long commands quickly", () => {
    const previous = process.env.ABUCODE_TEST_LONG_PATH
    process.env.ABUCODE_TEST_LONG_PATH = "/a".repeat(1000)
    try {
      expect(names(`true ${"$ABUCODE_TEST_LONG_PATH".repeat(600)}; cat ~/.local/state/abucode/service-local.json`)).not.toEqual([])
    } finally {
      if (previous === undefined) delete process.env.ABUCODE_TEST_LONG_PATH
      else process.env.ABUCODE_TEST_LONG_PATH = previous
    }
    expect(names(`${"cd a; ".repeat(2000)}cat x`)).toEqual([])
    const source = "export const route = { path: '/api/items', method: 'GET' } // see src/lib/routes.ts\n".repeat(2000)
    expect(names(`cat > src/routes.ts <<'EOF'\n${source}EOF`)).toEqual([])
    // Unclosed brackets, which a glob matcher reads in quadratic time, quoted brace lists it would expand, and many globs.
    expect(names(`grep -r x ${"[".repeat(3000)}`)).toEqual([])
    expect(names(`ls ~/.local/state/abucode/${"[".repeat(3000)}`)).toEqual([])
    expect(names(`cat "${"{a,b}".repeat(40)}*"`)).toEqual([])
    expect(names(`grep -r x ${"a* ".repeat(3000)}`)).toEqual([])
    expect(names(`cat ${"[[=".repeat(1330)}*`)).toEqual([])
    expect(names(`grep -r x ${"[[:".repeat(1300)}*`)).toEqual([])
    expect(names(`echo {a,b}{a,b}{a,b}{a,b}{a,b}; cat ${"[".repeat(9000)}`)).toEqual([])
    expect(names(`echo {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}; ls ${"[".repeat(4000)}*`)).toEqual([])
    expect(names(`${"cd a; ".repeat(1400)}cat x`, path.join(data, "worktree", "abc", "wt1"))).toEqual([])
    // A folder the scan follows grows with each `cd`; past what the system allows, the shell's `cd` fails too.
    expect(
      names(`${"cd $PWD/$PWD 2>/dev/null; ".repeat(11)}ls *; cat ~/.local/state/abucode/service-local.json`),
    ).not.toEqual([])
  })

  test("asks before a command that prints a process's environment, where a server's password can be", () => {
    for (const command of ["ps -E -o command= -p $PPID", "ps axE", "cat /proc/$PPID/environ", "strings /proc/1/environ"])
      expect(evaluateShellPolicyDecision("auto", command, "allow").effect).toBe("ask")
    // An option's value is not a flag.
    for (const command of ["ps -p $SERVER_PID", "ps -u $USER", "ps -p 1234 -o %CPU,%MEM", "ps aux"])
      expect(evaluateShellPolicyDecision("auto", command, "allow").effect).toBe("allow")
  })

  // Subagents run their own read tools and model requests, which the engine's hooks do not see.
  test("keeps subagents off the state files and masks what they send to their model", async () => {
    fs.writeFileSync(path.join(home, "notes.txt"), "token=probe-subagent-secret")
    const sent: string[] = []
    const llmCaller: AgentLlmCaller = async (request) => {
      sent.push(request.messages.map((message) => message.content).join("\n"))
      const first = sent.length === 1
      return {
        content: first ? "" : "done",
        toolCalls: first
          ? [
              { name: "read_file", arguments: { path: ".local/state/abucode/service-local.json" } },
              { name: "search_files", arguments: { query: "password", path: ".config" } },
              { name: "read_file", arguments: { path: "notes.txt" } },
            ]
          : [],
        totalTokens: 1,
        finishReason: "stop",
      }
    }
    const guard = {
      refuse: (target: string, mode: "read" | "search") => engineStateFileReason(target, { ...dirs, cwd: home }, mode),
      mask: (text: string) => text.replaceAll("probe-subagent-secret", "[MASKED]"),
    }
    await runHouseholdSubagents(
      { task: "Read the engine's password" },
      { repo: home, provider: "venice", model: "probe", effort: "low", defaultCharacter: "none", llmCaller, guard },
    )

    expect(sent[1]).toContain("is the ABuCode engine's own state")
    expect(sent[1]).toContain("would read the ABuCode engine's own state")
    expect(sent[1]).toContain("token=[MASKED]")
    expect(sent.join("\n")).not.toContain("probe-subagent-secret")
  })

  test("refuses a fetch of the engine's own server by any method, path or spelling of its address", async () => {
    const ownServers = ["http://127.0.0.1:49375", "https://route.tunnel.example"]
    const lookupFn = async (host: string) => [{ address: host === "self.example.test" ? "127.0.0.1" : "93.184.216.34" }]
    const guard = (url: string, method = "GET") =>
      validateResolvedFetchUrlGuard(url, { method, allowLoopbackGet: true, allowLocalGet: true, ownServers, lookupFn })
    const own = [
      ["http://127.0.0.1:49375/api/shell", "POST"],
      ["http://127.0.0.1:49375/api/session/ses_x/permission/per_y/reply", "POST"],
      ["http://127.0.0.1:49375/api/shell?auth_token=b3BlbmNvZGU6eA", "GET"],
      ["http://127.0.0.1:49375/api/health", "GET"],
      ["http://localhost:49375/", "GET"],
      ["http://LOCALHOST.:49375/", "GET"],
      ["http://[::1]:49375/", "GET"],
      ["http://127.1:49375/", "GET"],
      ["http://2130706433:49375/", "GET"],
      ["http://0x7f.0.0.1:49375/", "GET"],
      ["http://[::ffff:127.0.0.1]:49375/", "GET"],
      ["http://app.localhost:49375/", "GET"],
      ["http://self.example.test:49375/", "GET"],
      ["https://route.tunnel.example/api/shell", "POST"],
      ["https://route.tunnel.example./api/shell", "POST"],
      ["http://route.tunnel.example/api/shell", "POST"],
    ] as const
    const reasons = await Promise.all(own.map(([url, method]) => guard(url, method)))
    expect(reasons.filter((reason) => !reason?.startsWith("Blocked request to this ABuCode engine's own server"))).toEqual(
      [],
    )
    expect(isOwnServerUrl("http://localhost:49375/x", ownServers)).toBe(true)
    expect(isOwnServerUrl("http://localhost:3000/x", ownServers)).toBe(false)
    // A server bound to every interface answers on this machine's network addresses too.
    const lan = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => !entry.internal && entry.family === "IPv4")
    if (lan) expect(validateFetchUrlGuard(`http://${lan.address}:49375/`, { allowLocalGet: true, ownServers })).toBeDefined()
  })

  test("still lets public sites and loopback dev servers on other ports through", async () => {
    const ownServers = ["http://127.0.0.1:49375", "https://route.tunnel.example"]
    const lookupFn = async () => [{ address: "93.184.216.34" }]
    const options = { allowLoopbackGet: true, allowLocalGet: true, ownServers, lookupFn }

    expect(await validateResolvedFetchUrlGuard("https://docs.example.test/page", options)).toBeUndefined()
    expect(await validateResolvedFetchUrlGuard("https://other.tunnel.example/api/shell", options)).toBeUndefined()
    expect(await validateResolvedFetchUrlGuard("http://127.0.0.1:3000/", options)).toBeUndefined()
    expect(await validateResolvedFetchUrlGuard("http://localhost:5173/app", options)).toBeUndefined()
    expect(await validateResolvedFetchUrlGuard("http://127.0.0.1:3000/", { ...options, method: "POST" })).toMatch(
      /SSRF guard/,
    )
    expect(await validateResolvedFetchUrlGuard("http://169.254.169.254/latest/meta-data/", options)).toMatch(
      /cloud-metadata/,
    )
    // IPv6 spellings that carry an IPv4 address are that address.
    for (const url of [
      "http://[::ffff:0:169.254.169.254]/latest/meta-data/",
      "http://[64:ff9b:1::a9fe:a9fe]/latest/meta-data/",
      "http://[2002:a9fe:a9fe::1]/latest/meta-data/",
    ])
      expect(validateFetchUrlGuard(url, options)).toMatch(/cloud-metadata/)
    expect(validateFetchUrlGuard("http://[::127.0.0.1]:3000/", { ...options, method: "POST" })).toMatch(/SSRF guard/)
  })

  test("lets the play-test browser connect to loopback servers but not the engine's own", async () => {
    const ownServers = ["http://127.0.0.1:49375", "https://route.tunnel.example"]
    const connect = (host: string, port: number, external = false) =>
      playtestConnectionAddresses(host, port, { ownServers, external })

    // The IPv6 address as the proxy reads it from a SOCKS request, written out in full.
    for (const host of ["127.0.0.1", "localhost", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:7f00:1"])
      expect(await connect(host, 49375)).toEqual({ refused: "this ABuCode engine's own server" })
    expect(await connect("route.tunnel.example", 443, true)).toEqual({ refused: "this ABuCode engine's own server" })
    // Names that would move the port into a path.
    for (const host of ["127.0.0.1/", "localhost#"]) expect(await connect(host, 49375)).toEqual({ refused: "not a host name" })
    expect(await connect("127.0.0.1", 5173)).toEqual({ addresses: ["127.0.0.1"] })
    expect(await connect("0:0:0:0:0:0:0:1", 5173)).toEqual({ addresses: ["::1"] })
    // The resolver's order is kept, so `localhost` reaches `::1` first where the resolver puts it first, as a browser does.
    expect(await connect("localhost", 5173)).toEqual({ addresses: expect.arrayContaining(["127.0.0.1"]) })
    expect(await connect("169.254.169.254", 80, true)).toEqual({ refused: expect.stringContaining("cloud-metadata") })
    expect(await connect("192.168.1.10", 80, true)).toEqual({ refused: expect.stringContaining("LAN") })
    expect(await connect("93.184.216.34", 443)).toEqual({ refused: expect.stringContaining("not a loopback server") })
    expect(await connect("93.184.216.34", 443, true)).toEqual({ addresses: ["93.184.216.34"] })
  })

  test("keeps a play-test page off the engine's own server, through redirects, WebSockets and prerendering", async () => {
    const hits: string[] = []
    const own = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, server) => {
        hits.push(`${request.method} ${new URL(request.url).pathname}`)
        if (server.upgrade(request)) return undefined
        return new Response("engine")
      },
      websocket: { message: () => undefined },
    })
    const ownServers = [`http://127.0.0.1:${own.port}`]
    // The page tries a redirect, eleven redirects and a WebSocket, then shows #done for the test to wait on. The
    // speculation rules ask the browser to prefetch and prerender the engine's pages on its own.
    const rules = JSON.stringify({
      prerender: [{ source: "list", urls: [`${ownServers[0]}/api/prerender`] }],
      prefetch: [{ source: "list", urls: [`${ownServers[0]}/api/prefetch`] }],
    })
    const page = `<!doctype html><html><body><h1>dev</h1><script type="speculationrules">${rules}</script><script>
      let finished = 0
      const done = () => { if (++finished === 3) document.body.insertAdjacentHTML("beforeend", "<p id='done'>done</p>") }
      fetch("/redirect").then(done, done)
      fetch("/chain/0").then(done, done)
      const socket = new WebSocket("ws://127.0.0.1:${own.port}/socket")
      socket.onclose = done
    </script></body></html>`
    const dev = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html" } })
        const hop = /^\/chain\/(\d+)$/.exec(pathname)
        if (hop) {
          const next = Number(hop[1]) < 10 ? `/chain/${Number(hop[1]) + 1}` : `${ownServers[0]}/api/chain`
          return new Response("", { status: 302, headers: { location: next } })
        }
        // The browser follows its own redirects, so a page reached through one keeps its real address.
        if (pathname === "/docs") return new Response("", { status: 301, headers: { location: "/docs/" } })
        if (pathname === "/docs/") return new Response("<p>docs</p>", { headers: { "content-type": "text/html" } })
        return new Response("", { status: 302, headers: { location: `${ownServers[0]}/api/session` } })
      },
    })
    const devUrl = `http://127.0.0.1:${dev.port}`
    try {
      const redirected = await runPlaytestUrl({ url: `${devUrl}/start` }, { ownServers })
      const chained = await runPlaytestUrl({ url: `${devUrl}/chain/0` }, { ownServers })
      const scripted = await runPlaytestUrl(
        { url: `${devUrl}/`, steps: [{ action: "wait", selector: "#done" }, { action: "wait", value: "2500" }] },
        { ownServers },
      )
      const docs = await runPlaytestUrl({ url: `${devUrl}/docs`, steps: [{ action: "evaluate", value: "document.baseURI" }] })

      expect(redirected.output?.ok).toBe(false)
      expect(chained.output?.ok).toBe(false)
      // The page saw every attempt end; the refused requests show as console errors.
      expect(scripted.output?.report).toContain("✓ Step 1: wait for #done")
      expect(docs.output?.report).toContain(`"${devUrl}/docs/"`)
      expect(hits).toEqual([])
    } finally {
      own.stop(true)
      dev.stop(true)
    }
  }, 60_000)
})

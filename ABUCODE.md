# ABuCode

**ABuCode** is a minimal-conflict fork of OpenCode `v2.4.0` layered with MultiCode's full coding-side arsenal—Household 343 persona engine (with visual multi-character picker & wildcards), **Squad** multi-agent workflows (`diagnose` / `review` / `design` / `map` with paired Skeptics & cross-subscription cost routing), Household `dispatch_subagent`, proactive repo context pre-injection, `.env.local` provider vault, Poe/XML stream bridge + loop circuit breaker + Poe title thrift, GMT+8 `zzz_local/Chat-History` Markdown archiver, Pinned Session Memory compaction, quote/subshell-aware 4-tier security bodyguards + DNS/redirect SSRF shield, 18-action `playtest_url` with port reuse, custom bubble styling, and `Alt+Space` Desktop summon (with busy-hotkey fallback & tray approval alerts)—across **both** the Terminal CLI/TUI and the Dedicated Desktop/Web GUI.

## Running ABuCode

All modes connect to the same isolated `abucode` local background engine and SQLite store (`~/.local/share/abucode` / `~/.config/abucode`), leaving stock `opencode` and `MultiCode` completely untouched:

* **Terminal CLI / TUI (Windows):** `.\abucode.cmd [project-path]` *(or `node packages\cli\bin\abucode.cjs`)*
* **Terminal CLI / TUI (macOS/Linux):** `./abucode.sh [project-path]`
* **Web GUI:** `.\abucode_web.cmd` *(or `bun run dev:web`)*
* **Dedicated Desktop App (Electron + Tray + `Alt+Space` Summon):** `.\abucode_desktop.cmd` *(or `bun run dev:desktop`; pass `-- --minimized` to start hidden in tray)*

## Experimental features

OpenCode turns most of its experimental features on in anything run from source, which is how ABuCode runs. The launchers (`abucode.cmd`, `abucode.sh`, `abucode_desktop.cmd` and `packages/cli/bin/abucode.cjs`) therefore start the engine with those switched off, by putting this in `OPENCODE_FLAGS`:

```
-full_codemode,-home_memory,-project_overlay,-machines,-media_blob,-artifacts,-sqlite_fts,-console_watches,-recommended_api,-opencode_api
```

`packages/schema/src/config/flag.ts` says what each one does. They stay off because ABuCode's guards were not written for them. Full Code Mode, for one, gives the model's scripts file access that does not pass through the secret-file guard.

* **To try one,** name it in `OPENCODE_FLAGS` before you start ABuCode: `$env:OPENCODE_FLAGS = "artifacts"` in PowerShell, `set OPENCODE_FLAGS=artifacts` in cmd, or `OPENCODE_FLAGS=artifacts ./abucode.sh`. The launcher puts your entries after its own, and a later entry for the same feature wins. `all` does not override the list.
* **`experimental.<name>: true` in a config file does not turn a listed feature on,** because `OPENCODE_FLAGS` outranks config.
* **The engine reads the flags once, when it starts, and the terminal launcher reuses an engine that is already running.** An engine started any other way, or before the launchers had this list, keeps its own flags. Run `.\abucode.cmd service stop` once after updating, after any `bun run dev`, and before changing flags.
* **Do not set `OPENCODE_FLAGS` with `service set env`.** A saved value replaces the launcher's list, which turns every feature it does not name back on.
* **Only the launchers do this.** `bun run dev` and `bun run dev:desktop` carry no list, so an engine they start has the default-on features on. That includes the desktop app on macOS and Linux, which has no launcher. A WSL server added inside the desktop app does not get the list either. `abucode_web.cmd` and `bun run dev:web` start no engine of their own.
* **After merging a newer OpenCode, or editing a launcher,** run `bun run script/test.ts test/abucode-launchers.test.ts test/plugin/abucode-guard.test.ts test/plugin/abucode-config-edit.test.ts test/plugin/abucode-project-trust.test.ts test/plugin/abucode-trust-command.test.ts` in `packages/core`. The first file fails if the release added a feature the launchers do not yet switch off: add it to the list in all four and in the block above. The other two fail if the merge drops the ABuCode id from the protected list, removes the reserved-id check, changes how file edits ask for permission, renames core's unattended marker, moves the system config folder, or renames the shell tool or its `command` and `workdir` fields (next section). The first of those two also fails if the merge lets config commands register after the ABuCode plugin again, lets front matter run as JavaScript, or stops resolving `..` in plugin paths (the section after next). The last two fail if the merge drops project trust from config loading, the plugin, command, agent or formatter loaders, the overlay check or the plugin list. They do not check that `OPENCODE_CONFIG` still names the config file.

## The ABuCode plugin cannot be switched off from config

ABuCode's server plugin, `abucode.core`, enforces the policy tiers and the secret-file and network guards. A `plugins` entry that would remove it (`"-abucode.core"`, `"-abucode.*"` or `"-*"`) is ignored in every config file, your own `~/.config/abucode/opencode.json` included, and the engine does not say that it ignored one. The same plugin carries the personas, memory, archiver and provider vault, so no config entry gives a stock OpenCode run from this checkout.

* **A plugin loaded from config cannot take its id either.** The engine does not activate such a plugin and lists it as failed with "Plugin ID abucode.core is reserved for a built-in plugin". Its code is still imported to read the id.
* **The agent asks before it edits engine config.** That is any file named `opencode.json` or `opencode.jsonc`, anything in a `.opencode` folder, anything in the global config folder (`~/.config/abucode`, or `OPENCODE_CONFIG_DIR` when set) or the system config folder, and the file `OPENCODE_CONFIG` names. Theme and doc files in those places count too. An edit to them by a file tool waits for your approval in every Policy tier, even where your permission rules allow it; a rule that denies the edit still denies it. Links to files and folders that already exist, and other spellings of them, are followed. The Plan agent's `~/.opencode/plan` folder is left out, except for an `opencode.json` or a `.opencode` folder inside it.
* **In unattended work, such as an automation run, such an edit is refused.** Nobody is there to approve it, so the edit fails. The experimental home memory's daily skill upkeep (on under `bun run dev` and the desktop app on macOS and Linux) does not count as unattended: its skill edits wait for approval in a session you do not see.
* **Auto-approval answers this prompt like any other.** `run --auto`, the terminal's auto-accept mode and the app's auto-approve setting approve it without showing it to you.
* **Choosing Always in that prompt does not stop the next one.** As on any edit prompt, it also saves an allow for every other file edit in this project's sessions, including files outside the project folder.
* **The agent's shell commands also ask, in every Policy tier, when they visibly write those files.** That covers the agent's shell tool and `playtest_url`'s `start_command`: output redirection (`>`, `>>`, `>|`, `>& file`), `tee`, `cp`, `mv`, `install`, `ln`, `touch`, `sed -i` and `perl -i`, `dd of=`, `curl -o` and `wget -O` or `-P`, and archives unpacked with `tar` or `unzip`, also inside `sh -c`, `eval`, `$(…)` and `xargs`. On Windows, PowerShell's write cmdlets and their usual aliases count too. Each file is resolved against the folder its command runs in, after the shell tool's `workdir` and any `cd`, and a download or unpacked archive into a config folder counts. `~`, `$HOME` and other variables in file names are expanded from the engine's own environment. The prompt names the files (the app also shows the command), it offers no Always that sticks, and where the Policy tier asks about the command too, a second prompt follows.
* **What this does not cover.** A shell command that builds the file name at run time, or runs a script or program that writes the file itself (`python -c`, `node -e`, `git checkout`, PowerShell's `[IO.File]` methods), runs as the Policy tier allows, which outside Request Review usually means without asking. So does a shell command an automation runs as its action, and deleting those files with `rm` (which the Default and Auto tiers ask about anyway). Code the engine runs from elsewhere, such as a plugin your config points to outside those folders or a program the engine starts, can still be changed without this prompt. A repository you open can still ship plugin code of its own, as OpenCode allows, and code that runs inside the engine is not held by the guards (next section).
* **Two of these protections are edits to upstream files** (`packages/core/src/plugin/internal.ts` and `packages/core/src/plugin/supervisor.ts`), which a merge can drop. The post-merge command above runs the tests that catch that.

## Opening a repository you do not trust

As in stock OpenCode, a repository you open is trusted unless you turn project trust on: its own config applies as soon as ABuCode opens it. Its `opencode.json` and `.opencode` folder can start MCP programs, which run with the engine's environment and so with the provider keys. They can load plugin code into the engine, where the guards do not hold it, and add slash commands whose shell snippets run without a Policy tier when you type the command.

* **ABuCode's own commands keep their names.** A command file named like `/policy`, `/character`, `/squad`, `/keys`, `/memory`, `/archive` or `/trust` does not replace that command, whether a repository ships it or it is your own; ABuCode's answers. Commands with other names still load.
* **Command, agent and skill files are read, not run.** Their front matter is read as YAML or JSON; a file whose front matter is JavaScript is skipped, as any file that cannot be parsed is.
* **The project overlay stays in its folder.** The experimental per-project config folder (`project_overlay`) is named after the project ID, which a repository can set itself. An ID that would lead out of `~/.config/abucode/project/` gets no overlay.

### Project trust (experimental)

* **Off until you turn it on** with `"experimental": { "project_trust": true }` in `~/.config/abucode/opencode.json` (or `OPENCODE_FLAGS=project_trust` for the engine). Only your own config files decide it: a repository that is not trusted cannot turn it off. The launchers leave it alone, because it is off by default in every build.
* **While it is on, a repository's own config runs nothing until you trust its folder.** That is every `opencode.json`, `opencode.jsonc` and `.opencode` folder found by walking up from the folder you opened, those in parent folders included. Held back: plugins (its plugin folders and `plugins` entries), MCP servers, commands (its command files and `commands`), the `shell` setting, providers, permission rules (top-level and each agent's), `default_agent`, `references`, `worktree`, `warming`, the `instructions` and `skills` entries, `experimental`, and every other setting not named in the next point. `{env:…}` and `{file:…}` in its files are left as written.
* **What still applies:** its `AGENTS.md` and `CLAUDE.md`, its agents (prompt, model and description; not their permission rules, and an agent cannot be removed), skills from its folders, `model`, the deny statements in `policies`, and settings that run nothing: `compaction`, `tool_output`, `watcher`, `media`, `timezone` and `username`.
* **No formatter runs in a project that is not trusted,** your own included: the built-in ones run the repository's own tools and config files.
* **`/trust`** says whether this project is trusted and lists what is held back. `/trust yes` adds the project's folder to `trusted-projects.json` in the global config folder, and its config then loads in the background, without a restart. That folder is the one that holds the `.git` or `.hg` entry, or else the folder you opened. `/trust no` takes it off again; a plugin that already ran keeps what it started until the engine restarts. `/trust` will not add your home folder, a folder above it or a drive root; to trust one of those, edit the file.
* **A trusted folder covers the folders below it,** so trusting a checkout also covers the worktrees inside it. A worktree elsewhere, such as one ABuCode creates for a session, needs its own `/trust yes`. Config in a folder above, such as `~/.opencode`, stays held back until that folder is trusted too.
* **The list is your own file:** `{ "trusted": ["C:/Users/you/code/project"] }`. Only absolute paths count; `/trust` keeps any other entry as it is. A file that does not parse trusts nothing, and `/trust` leaves it for you to fix. A repository's config cannot add a folder to it; the agent's edits to the global config folder ask first, to the extent the previous section describes.
* **The terminal holds back the same projects' own terminal plugins** (those in `.opencode/plugins`), following what the engine decided for the folder. If it cannot read the engine's config, it holds back every project folder the list does not cover. It decides when it starts, so restart it after `/trust yes` or `/trust no`.
* **Unattended runs** (`run`, automations) hold an untrusted project back the same way; nothing asks.
* **Your own config is not filtered:** the global and system config folders, managed preferences, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`, your global plugin folder and your MCP servers. A repository that is not trusted cannot replace one of your MCP servers by defining one of the same name.
* **Limits.** Text the repository ships (its instructions, agents and skills) still reaches the model as it is, whatever it contains.

### Without project trust

* **Policies in your own config can stop plugin code and MCP programs from config,** with no code change. Put them in `~/.config/abucode/opencode.json` (or the `opencode.json` in `OPENCODE_CONFIG_DIR`), with your own folder in the allow (on macOS, `/Users/you/.config/abucode/plugins/*`):

  ```jsonc
  {
    "policies": [
      { "action": "plugin.use", "resource": "*", "effect": "deny" },
      { "action": "plugin.use", "resource": "C:/Users/you/.config/abucode/plugins/*", "effect": "allow" },
      { "action": "mcp.use", "resource": "*", "effect": "deny" }
    ]
  }
  ```

* **Your statements win when they are in the right place.** Policies in the global config folder, the system config folder, managed preferences and the file `OPENCODE_CONFIG` names outrank any in a repository's config, so a repository cannot allow what you deny there. Those in `OPENCODE_CONFIG_CONTENT` and the project overlay rank below a repository's, so keep your denies in the global config. Within one file, the last statement that matches decides: keep each allow below the deny it narrows.
* **The allow names your own plugin folder.** Write the global config folder as the engine knows it, then `/plugins/*`; add the same with `/plugin/*` if you use that folder. On Windows, forward slashes and any case match. A plugin path is matched after its `..` parts are resolved, so a path that only starts in your folder does not count. A plugin your own config names by a path outside that folder needs an allow for that path.
* **Plugins you name as packages are blocked too,** unless you allow each package name. Such an allow holds for any config that names the package, a repository's included, whatever version or source that config adds to the name.
* **The MCP deny stops your own servers as well.** An allow by server name admits that name in every config, and a repository's config can define a server of the same name: its definition then starts instead of yours.
* **What policies do not stop.** A repository's command files, with their shell snippets, and its other settings still apply.
* **A stricter switch:** start the engine with `OPENCODE_DISABLE_PROJECT_CONFIG=1`. It then reads no project config at all, so a repository's plugins, MCP servers, commands, agents and settings are all ignored by the engine. The terminal still loads a project's own terminal plugins unless project trust holds them back. The terminal launcher reuses a running engine, so run `.\abucode.cmd service stop` first.

### Edits to upstream files

These protections are edits to upstream files, which a merge can drop: in `packages/core/src`, the plugin order and the protected ids in `plugin/internal.ts`, the front matter in `config/markdown.ts`, the path check in `config/plugin/source.ts` and the overlay folder in `config/discovery.ts`; for project trust, `config.ts`, `config/plugin/source.ts`, `config/plugin/command.ts`, `config/plugin/agent.ts` and `config/plugin/formatter.ts`, the flag in `packages/schema/src/config/flag.ts`, and the terminal's `packages/tui/src/plugin/discovery.ts` and `packages/tui/src/app.tsx`. The post-merge command above runs the core tests that catch those; in `packages/tui`, `bun test test/plugin-project-trust.test.ts` covers the terminal's check, and `bun run check` fails if a merge drops the terminal's call to it, whose argument is required. No test covers the terminal reading the engine's config at start.

## CLI Slash Commands, Agent Tools & GUI Controls

Every control above the GUI composer (`Character`, `Memory`, `Squad`, `Policy`) and inside `Settings -> ABuCode` has a live-synced CLI slash command:

| Feature | GUI Control | CLI Slash Command / Agent Tool |
| :--- | :--- | :--- |
| **Household 343 + Vanilla + Multi-Picker** | Composer `Household Persona` pill (`Multiple...` checkboxes + `Other1..10`) | `/character [none \| default \| random \| <Name> \| <N1, N2> \| Other1 {desc} \| list]` |
| **Pinned Session Memory + Compaction** | Composer `Memory` pill (`Compact Turns -> Memory` + auto-sync on compaction) | `/memory [show \| clear \| compact [keep] [note] \| <notes>]` |
| **Squad Multi-Agent Workflows & Cost Routing** | Composer `Squad` pill + `Settings -> ABuCode` routing table | `/squad [on \| off \| status \| max <4..12> \| cost <usd> \| route <role> <prov> [model] [effort]]` + `run_workflow` & `get_agent_report` |
| **Household Parallel Subagents** | Automatic when delegating research | `dispatch_subagent(tasks=[{task, character}])` (up to 4 in parallel) |
| **4-Tier Shell Parser & DNS SSRF Policy** | Composer `Policy` pill + scroll-to-unlock dock | `/policy [request_review \| default \| auto \| turbo]` |
| **Project Trust (experimental, `project_trust` flag)** | — | `/trust [status \| yes \| no]` |
| **18-Action Headless Browser Play-Tester** | Inline Markdown report + live vision screenshots | `playtest_url` (port reuse, `WxH` viewports, JS dialog/console/network capture) |
| **Provider `.env.local` Vault & Ping** | `Settings -> ABuCode` | `/keys [status \| test venice \| test nano-gpt \| test poe]` |
| **GMT+8 Markdown Archiver** | Auto-runs on prompt, step, stop/idle, rename & startup backfill | `/archive` *(force immediate snapshot to `zzz_local/Chat-History`)* |
| **Bubble Colors & Width** | `Settings -> ABuCode` | — |
| **Desktop `Alt+Space` Summon, Auto-Fallback & Tray Alerts** | `Settings -> ABuCode` + Tray Menu + Hidden Approval Balloons | — |

## MultiCode ↔ ABuCode Native Surface Equivalence Ledger

Several everyday coding workflows exist in **both** MultiCode and ABuCode, **but look different** because MultiCode is a bespoke single-page FastAPI web app with a custom right-hand Control Center rail, whereas ABuCode intentionally uses **OpenCode `v2.4.0`'s first-class native GUI + TUI surfaces** wherever OpenCode already owns the capability (keeping upstream OpenCode merges clean).

Full architectural breakdown lives in `zzz_local/Decisions/Closed/0001-multicode-vs-abucode-native-surface-equivalence.md`:

| MultiCode UI Control | ABuCode Native Surface (GUI & TUI) | How They Work Similarly & Why They Look Different |
| :--- | :--- | :--- |
| **`⚡ Act` / `📋 Plan` button** | **`Build` / `Plan` Agent Switcher** (`Tab` key or composer agent pill) | Both toggle between full read/write execution and read-only planning. ABuCode uses OpenCode's extensible Agent system rather than a hardcoded two-state toolbar button. |
| **`⏪ Undo Turn` / `🌿 Branch` / `✏️ Edit`** | **`/undo`, `/redo`, Timeline Revert & Session Fork** | Both roll back unwanted turns and fork mid-conversation. MultiCode restores saved `before_content` strings only for its file tools; ABuCode uses OpenCode's Git snapshot tracker + SQLite event store, reverting **both** file-tool and shell-command changes with full `/redo`. |
| **`@file` Popup & `📎` Attachments** | **Native `@` Mention Menu & Attachment / Clipboard Paste** | Both fuzzy-match repo files and send images/code to multimodal models (with automatic image-stripping fallback on text-only models). ABuCode's `@` menu also resolves symbols, agents, and MCP resources. |
| **`Appearance` & `Notifications` Modals** | **OpenCode Appearance/Notification Settings + `Settings -> ABuCode`** | OpenCode owns semantic light/dark themes, fonts, and completion sounds across GUI and TUI; ABuCode adds MultiCode's per-bubble color pickers, width presets, and hidden-window tray approval balloons. |
| **Right-Rail `Repository` Dropdown** | **Multi-Project Workspace Tabs, Worktree Picker & `abucode <path>`** | MultiCode switches one `active_repo` at a time; ABuCode keeps multiple repos and **Git worktrees** open concurrently across tabs and TUI sessions, plus adds **LSP**, **MCP**, **integrated terminal tabs**, and **background automations**. |

## Git Remotes (Gitea Primary · GitHub Backup · Read-Only Upstream)

* **`origin` (Gitea Primary):** `ssh://Bustamam@desktop-sufian-3080.tail2d458b.ts.net:2222/sufian/ABuCode.git`
* **`github` (GitHub Backup):** `https://github.com/Sufian0/ABuCode.git` *(or auto-synced via Gitea Push Mirror)*
* **`upstream` (OpenCode Source):** `https://github.com/anomalyco/opencode.git` *(push URL set to `DISABLED`)*

To pull a future OpenCode release tag cleanly later:

```bash
git fetch upstream --tags
git merge v2.3.0
```

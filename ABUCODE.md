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
* **After merging a newer OpenCode, or editing a launcher,** run `bun run script/test.ts test/abucode-launchers.test.ts test/plugin/abucode-guard.test.ts test/plugin/abucode-config-edit.test.ts test/plugin/abucode-automation.test.ts` in `packages/core`. The first file fails if the release added a feature the launchers do not yet switch off: add it to the list in all four and in the block above. The next two fail if the merge drops the ABuCode id from the protected list, removes the reserved-id check, changes how file edits ask for permission, renames core's unattended marker, moves the system config folder, or renames the shell tool or its `command` and `workdir` fields (next section). They do not check that `OPENCODE_CONFIG` still names the config file. `abucode-automation.test.ts` fails if the merge renames the automation tool, changes how core marks the permission requests of an automation that runs a shell command or a script, stops running a script's tool calls under the unattended marker, or stops pausing an automation at once when a run is refused for want of approval (Automations, below).

## The ABuCode plugin cannot be switched off from config

ABuCode's server plugin, `abucode.core`, enforces the policy tiers and the secret-file and network guards. A `plugins` entry that would remove it (`"-abucode.core"`, `"-abucode.*"` or `"-*"`) is ignored in every config file, your own `~/.config/abucode/opencode.json` included, and the engine does not say that it ignored one. The same plugin carries the personas, memory, archiver and provider vault, so no config entry gives a stock OpenCode run from this checkout.

* **A plugin loaded from config cannot take its id either.** The engine does not activate such a plugin and lists it as failed with "Plugin ID abucode.core is reserved for a built-in plugin". Its code is still imported to read the id.
* **The agent asks before it edits engine config.** That is any file named `opencode.json` or `opencode.jsonc`, anything in a `.opencode` folder, anything in the global config folder (`~/.config/abucode`, or `OPENCODE_CONFIG_DIR` when set) or the system config folder, and the file `OPENCODE_CONFIG` names. Theme and doc files in those places count too. An edit to them by a file tool waits for your approval in every Policy tier, even where your permission rules allow it; a rule that denies the edit still denies it. Links to files and folders that already exist, and other spellings of them, are followed. The Plan agent's `~/.opencode/plan` folder is left out, except for an `opencode.json` or a `.opencode` folder inside it.
* **In unattended work, such as an automation run, such an edit is refused.** Nobody is there to approve it, so the edit fails. The experimental home memory's daily skill upkeep (on under `bun run dev` and the desktop app on macOS and Linux) does not count as unattended: its skill edits wait for approval in a session you do not see.
* **Auto-approval answers this prompt like any other.** `run --auto`, the terminal's auto-accept mode and the app's auto-approve setting approve it without showing it to you.
* **Choosing Always in that prompt does not stop the next one.** As on any edit prompt, it also saves an allow for every other file edit in this project's sessions, including files outside the project folder.
* **The agent's shell commands also ask, in every Policy tier, when they visibly write those files.** That covers the agent's shell tool and `playtest_url`'s `start_command`: output redirection (`>`, `>>`, `>|`, `>& file`), `tee`, `cp`, `mv`, `install`, `ln`, `touch`, `sed -i` and `perl -i`, `dd of=`, `curl -o` and `wget -O` or `-P`, and archives unpacked with `tar` or `unzip`, also inside `sh -c`, `eval`, `$(…)` and `xargs`. On Windows, PowerShell's write cmdlets and their usual aliases count too. Each file is resolved against the folder its command runs in, after the shell tool's `workdir` and any `cd`, and a download or unpacked archive into a config folder counts. `~`, `$HOME` and other variables in file names are expanded from the engine's own environment. The prompt names the files (the app also shows the command), it offers no Always that sticks, and where the Policy tier asks about the command too, a second prompt follows.
* **What this does not cover.** A shell command that builds the file name at run time, or runs a script or program that writes the file itself (`python -c`, `node -e`, `git checkout`, PowerShell's `[IO.File]` methods), runs as the Policy tier allows, which outside Request Review usually means without asking. So does deleting those files with `rm` (which the Default and Auto tiers ask about anyway). Code the engine runs from elsewhere, such as a plugin your config points to outside those folders or a program the engine starts, can still be changed without this prompt. A repository you open can still ship plugin code of its own, as OpenCode allows, and code that runs inside the engine is not held by the guards.
* **Two of these protections are edits to upstream files** (`packages/core/src/plugin/internal.ts` and `packages/core/src/plugin/supervisor.ts`), which a merge can drop. The post-merge command above runs the tests that catch that.

## Automations ask before they exist

OpenCode's automations run a prompt, a script or a shell command at a set time, on an interval, on a cron schedule, or when an MCP server sends an event. They are on by default, and the agent creates them with its `automation` tool. A shell command or a script then runs later with nobody there to approve it, so ABuCode asks when the automation is made.

* **Creating one that runs a shell command or a script asks you first, in every Policy tier,** Turbo included, and also where your permission rules allow it; a rule that denies the command still refuses it. The prompt shows the whole command or script (some clients show less, below), and Always saves nothing. It comes before the engine checks the rest of the request, such as the trigger, so an automation the engine then turns down is not made, and a corrected one asks again. A second prompt, for the command itself, follows where the Policy tier would ask about that command, or, in Request Review and Default, where a permission rule would.
* **A shell command is refused, not asked about, when it is on the never-permitted list or visibly writes engine config** (the files and the kinds of write listed under "The ABuCode plugin cannot be switched off from config"), because its runs could not be approved. The never-permitted list is the commands ABuCode never runs, such as formatting a disk, shutting the machine down, deleting the home folder or staging a `.env` file. It is checked again each time the command runs.
* **When a script automation runs, a shell command that the session's Policy tier would ask about is refused.** The approval you gave when it was made does not answer the tier's question. That is every shell command in Request Review, the commands Default and Auto ask about in those tiers, and none in Turbo. The command does not run, and unless the script handles the failure itself the automation is paused with the reason in its last output. Your approval does answer a permission rule that asks about every shell command. A rule that names particular commands still needs a person, so in the Default tier those commands fail in a run too, and the automation is paused after its third failed run. A script can call the shell tool only with Full Code Mode on, which the launchers switch off.
* **An automation that only sends a prompt is not affected.** Nothing is asked when it is made, and the prompt runs as an ordinary turn, under the Policy tier of the session it is sent to. A prompt to a subagent starts a new session at each run, which follows your default Policy tier, not the creating session's.
* **Auto-approval answers the creation prompt like any other,** as it does the config-edit prompt.
* **Some clients show less.** The desktop and web app show ABuCode's reason above the command or script. The terminal shows a shell command without the reason, a long one only as far as the prompt is tall, and for a script only "Call tool execute", not the script. An editor connected over ACP shows the command as it was written, without the reason, and for a script only `execute`.
* **What this does not cover.** A shell command is rated by the Policy tier and checked for engine-config writes only when the automation is made; each run checks the never-permitted list again and nothing else, and the limits of that reading listed under "The ABuCode plugin cannot be switched off from config" apply to it. Shell-command automations made before this check keep running as they are, while script automations made before it are held to the refusal above when they run: ask the agent to list them, and delete the ones you do not want. A script's web requests and file reads and writes follow your permission rules, apart from edits to engine config, which a run is refused. The engine's own HTTP API makes automations without this prompt, as in OpenCode, because nobody can be asked there; it refuses a shell automation whose command is never permitted, visibly writes engine config, or is one the session's Policy tier would ask about (in Request Review, any command). Commands that write the engine's own database are not checked here.
* **To switch automations off,** put `"automations": false` at the top level of `opencode.json` in the global config folder (`~/.config/abucode`, or `OPENCODE_CONFIG_DIR` when set; create the file if it is missing). Spell it exactly: a misspelled key, or a value other than the bare `false`, leaves automations on. The agent then has no `automation` tool and no `/automation` command, nothing new can be made, and stored automations start no new runs. This is a default, not a lock: a config file in a project folder or a folder above it, the file `OPENCODE_CONFIG` names, `OPENCODE_CONFIG_CONTENT` and the system config folder all outrank the global file. Stored automations are kept and cannot be listed or deleted while the setting is off, and an overdue one runs once when it is on again, so delete the ones you do not want first.

## CLI Slash Commands, Agent Tools & GUI Controls

Every control above the GUI composer (`Character`, `Memory`, `Squad`, `Policy`) and inside `Settings -> ABuCode` has a live-synced CLI slash command:

| Feature | GUI Control | CLI Slash Command / Agent Tool |
| :--- | :--- | :--- |
| **Household 343 + Vanilla + Multi-Picker** | Composer `Household Persona` pill (`Multiple...` checkboxes + `Other1..10`) | `/character [none \| default \| random \| <Name> \| <N1, N2> \| Other1 {desc} \| list]` |
| **Pinned Session Memory + Compaction** | Composer `Memory` pill (`Compact Turns -> Memory` + auto-sync on compaction) | `/memory [show \| clear \| compact [keep] [note] \| <notes>]` |
| **Squad Multi-Agent Workflows & Cost Routing** | Composer `Squad` pill + `Settings -> ABuCode` routing table | `/squad [on \| off \| status \| max <4..12> \| cost <usd> \| route <role> <prov> [model] [effort]]` + `run_workflow` & `get_agent_report` |
| **Household Parallel Subagents** | Automatic when delegating research | `dispatch_subagent(tasks=[{task, character}])` (up to 4 in parallel) |
| **4-Tier Shell Parser & DNS SSRF Policy** | Composer `Policy` pill + scroll-to-unlock dock | `/policy [request_review \| default \| auto \| turbo]` |
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

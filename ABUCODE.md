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
* **After merging a newer OpenCode, or editing a launcher,** run `bun run script/test.ts test/abucode-launchers.test.ts test/plugin/abucode-guard.test.ts test/plugin/abucode-config-edit.test.ts` in `packages/core`. The first file fails if the release added a feature the launchers do not yet switch off: add it to the list in all four and in the block above. The other two fail if the merge drops the ABuCode id from the protected list, removes the reserved-id check, changes how file edits ask for permission, renames core's unattended marker, moves the system config folder, renames the shell tool or its `command` and `workdir` fields, renames the session move tool or its `directory` field, or moves the engine's worktree folder (next two sections). They do not check that `OPENCODE_CONFIG` still names the config file.

## The ABuCode plugin cannot be switched off from config

ABuCode's server plugin, `abucode.core`, enforces the policy tiers and the secret-file and network guards. A `plugins` entry that would remove it (`"-abucode.core"`, `"-abucode.*"` or `"-*"`) is ignored in every config file, your own `~/.config/abucode/opencode.json` included, and the engine does not say that it ignored one. The same plugin carries the personas, memory, archiver and provider vault, so no config entry gives a stock OpenCode run from this checkout.

* **A plugin loaded from config cannot take its id either.** The engine does not activate such a plugin and lists it as failed with "Plugin ID abucode.core is reserved for a built-in plugin". Its code is still imported to read the id.
* **The agent asks before it edits engine config.** That is any file named `opencode.json` or `opencode.jsonc`, anything in a `.opencode` folder, anything in the global config folder (`~/.config/abucode`, or `OPENCODE_CONFIG_DIR` when set) or the system config folder, and the file `OPENCODE_CONFIG` names. Theme and doc files in those places count too. An edit to them by a file tool waits for your approval in every Policy tier, even where your permission rules allow it; a rule that denies the edit still denies it. Links and other spellings of files and folders that exist are followed, and so is a link to a file that does not exist yet, which a write through it would create. The Plan agent's `~/.opencode/plan` folder is left out, except for an `opencode.json` or a `.opencode` folder inside it.
* **In unattended work, such as an automation run, such an edit is refused.** Nobody is there to approve it, so the edit fails. The experimental home memory's daily skill upkeep (on under `bun run dev` and the desktop app on macOS and Linux) does not count as unattended: its skill edits wait for approval in a session you do not see.
* **Auto-approval answers this prompt like any other.** `run --auto`, the terminal's auto-accept mode and the app's auto-approve setting approve it without showing it to you.
* **Choosing Always in that prompt does not stop the next one.** As on any edit prompt, it also saves an allow for every other file edit in this project's sessions. Edits outside the project still ask (next section).
* **The agent's shell commands also ask, in every Policy tier, when they visibly write those files.** That covers the agent's shell tool and `playtest_url`'s `start_command`: output redirection (`>`, `>>`, `>|`, `>& file`), `tee`, `cp`, `mv`, `install`, `ln`, `touch`, `sed -i` and `perl -i`, `dd of=`, `curl -o` and `wget -O` or `-P`, and archives unpacked with `tar` or `unzip`, also inside `sh -c`, `eval`, `$(…)` and `xargs`. On Windows, PowerShell's write cmdlets and their usual aliases count too. Each file is resolved against the folder its command runs in, after the shell tool's `workdir` and any `cd`, and a download or unpacked archive into a config folder counts. `~`, `$HOME` and other variables in file names are expanded from the engine's own environment. The prompt names the files (the app also shows the command), it offers no Always that sticks, and where the Policy tier asks about the command too, a second prompt follows.
* **What this does not cover.** A shell command that builds the file name at run time, or runs a script or program that writes the file itself (`python -c`, `node -e`, `git checkout`, PowerShell's `[IO.File]` methods), runs as the Policy tier allows, which outside Request Review usually means without asking. So does a shell command an automation runs as its action, and deleting those files with `rm` (which the Default and Auto tiers ask about anyway). Code the engine runs from inside the project, such as a plugin your project's config points to or a formatter's config file, can still be changed without this prompt; outside the project the next section's prompt asks first. A repository you open can still ship plugin code of its own, as OpenCode allows, and code that runs inside the engine is not held by the guards.
* **Two of these protections are edits to upstream files** (`packages/core/src/plugin/internal.ts` and `packages/core/src/plugin/supervisor.ts`), which a merge can drop. The post-merge command above runs the tests that catch that.

## The agent asks before it edits files outside the project

A file outside the project can be code that the engine or your shell runs later: a shell startup file such as `~/.zshenv`, git's `~/.gitconfig`, a program on `PATH` such as `~/.bun/bin/bun`, a plugin installed in the engine's cache, or a plugin or MCP script your config points to. So an edit to a file outside the session's project waits for your approval in every Policy tier, even where your permission rules allow it, and a rule that denies the edit still denies it. The project is the folder the session works in and the repository checkout it is in.

* **Every file tool counts:** write, edit and patch, Code Mode's `Bun.write` and file deletes, image and video output saved to a path the agent names, and removing a worktree. A patch that also changes files in the project asks once, naming only the files outside it. Reads outside the project do not ask.
* **Where the edit lands decides.** Links are followed, also a link to a file that does not exist yet, so a link in the project that points outside asks, and another spelling of a file in the project does not. A file on another machine always asks.
* **These folders outside the project do not ask:** the repository's main checkout, the engine's worktree folder for the project (`~/.local/share/abucode/worktree/<id>`), the Plan agent's `~/.opencode/plan` folder, and the engine's own temp folder (`abucode` in the system temp folder), which the engine tells the agent to use for scratch files. The rest of the system temp folder, `/tmp` included, asks, because other programs keep files there that run later. So does the engine's cache, where installed plugins live. The engine reads where these folders really are once, when it opens the project, so a folder that is later replaced by a link to elsewhere asks. Worktrees kept elsewhere through the `worktree` config setting ask too.
* **Moving a session out of the project asks as well.** A session moved to another folder treats that folder as its project, so the agent's `opencode_session_move` tool asks before it moves a session anywhere but the folders above. The prompt names the destination. Moving into a worktree the engine made does not ask.
* **In unattended work, such as an automation run, such an edit or move is refused.**
* **Each edit asks again.** Choosing Always does not stop the next prompt, and saves an allow for every other file edit in this project's sessions, as on any edit prompt. Auto-approval (`run --auto`, the terminal's auto-accept mode, the app's auto-approve setting) answers it without showing it to you.
* **What this does not cover.** Shell commands still run as the Policy tier allows, apart from writes to engine config (previous section). A session opened in your home folder, or in a repository that contains it, treats everything in it as its project. A hard link inside the project to a file outside it is not recognised, and a link put in place while an edit waits for approval is not checked again.

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

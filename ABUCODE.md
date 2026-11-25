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
* **After merging a newer OpenCode, or editing a launcher,** run `bun run script/test.ts test/abucode-launchers.test.ts test/plugin/abucode-guard.test.ts` in `packages/core`. The first file fails if the release added a feature the launchers do not yet switch off: add it to the list in all four and in the block above. The second fails if the merge dropped the ABuCode plugin from the protected list described in the next section.

## The ABuCode plugin cannot be switched off from config

ABuCode's server plugin, `abucode.core`, enforces the policy tiers and the secret-file and network guards. A `plugins` entry that would remove it (`"-abucode.core"`, `"-abucode.*"` or `"-*"`) is ignored in every config file, your own `~/.config/abucode/opencode.json` included, and the engine does not say that it ignored one. The same plugin carries the personas, memory, archiver and provider vault, so no config entry gives a stock OpenCode run from this checkout.

* **This stops removal entries only.** A repository can still load plugin code of its own from its `.opencode` folder, as OpenCode allows, and code that runs inside the engine is not held by the guards.
* **The protection is one id added to an upstream line** in `packages/core/src/plugin/internal.ts`, which a merge can drop. The post-merge command above runs the test that catches that.

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

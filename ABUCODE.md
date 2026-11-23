# ABuCode

**ABuCode** is a minimal-conflict fork of OpenCode `v2.2.5` layered with MultiCode's Household 343 persona engine, `.env.local` provider vault, Poe/XML stream bridge, GMT+8 `zzz_local/Chat-History` Markdown archiver, security bodyguards, guarded `playtest_url`, custom bubble styling, and `Alt+Space` Desktop summon—across **both** the Terminal CLI/TUI and the Dedicated Desktop/Web GUI.

## Running ABuCode

All modes connect to the same isolated `abucode` local background engine and SQLite store (`~/.local/share/abucode` / `~/.config/abucode`), leaving stock `opencode` and `MultiCode` completely untouched:

* **Terminal CLI / TUI (Windows):** `.\abucode.cmd [project-path]` *(or `node packages\cli\bin\abucode.cjs`)*
* **Terminal CLI / TUI (macOS/Linux):** `./abucode.sh [project-path]`
* **Web GUI:** `.\abucode_web.cmd` *(or `bun run dev:web`)*
* **Dedicated Desktop App (Electron + Tray + `Alt+Space` Summon):** `.\abucode_desktop.cmd` *(or `bun run dev:desktop`; pass `-- --minimized` to start hidden in tray)*

## CLI Slash Commands & GUI Controls

Every control above the GUI composer (`Character`, `Memory`, `Policy`) and inside `Settings -> ABuCode` also has a live-synced CLI slash command:

| Feature | GUI Control | CLI Slash Command |
| :--- | :--- | :--- |
| **Household 343 + Vanilla Mode** | Composer `Household Persona` pill | `/character [none \| default \| random \| <Name> \| <N1, N2> \| Other1 {desc} \| list]` |
| **Pinned Session Memory** | Composer `Memory` pill | `/memory [show \| clear \| <notes>]` |
| **4-Tier Approval Policy** | Composer `Policy` pill | `/policy [request_review \| default \| auto \| turbo]` |
| **Provider `.env.local` Vault & Ping** | `Settings -> ABuCode` | `/keys [status \| test venice \| test nano-gpt \| test poe]` |
| **GMT+8 Markdown Archiver** | Auto-runs on every idle turn | `/archive` *(force immediate snapshot to `zzz_local/Chat-History`)* |
| **Bubble Colors & Width** | `Settings -> ABuCode` | — |
| **Desktop `Alt+Space` Summon & Tray** | `Settings -> ABuCode` + Tray Menu | — |

## Git Remotes (Gitea Primary · GitHub Backup · Read-Only Upstream)

* **`origin` (Gitea Primary):** `ssh://Bustamam@desktop-sufian-3080.tail2d458b.ts.net:2222/sufian/ABuCode.git`
* **`github` (GitHub Backup):** `https://github.com/Sufian0/ABuCode.git` *(or auto-synced via Gitea Push Mirror)*
* **`upstream` (OpenCode Source):** `https://github.com/anomalyco/opencode.git` *(push URL set to `DISABLED`)*

Once your empty `ABuCode` repository is created on Gitea (and optionally GitHub):

```bash
git push -u origin dev
# Optional manual push to GitHub if not using Gitea Push Mirror:
git push -u github dev
```

To pull a future OpenCode release tag cleanly later:

```bash
git fetch upstream --tags
git merge v2.3.0
```

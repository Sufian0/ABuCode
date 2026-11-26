import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { editsOutsideProject, projectFolders } from "../src/security.js"

describe("edits outside the session's project", () => {
  test("finds the edits that land outside the project's folders, as core names them", () => {
    // A base no automounter serves: macOS looks up every missing name under /home in automountd.
    const base = path.resolve("/nonexistent-abucode-test")
    const at = (relative: string) => path.join(base, relative)
    const dirs = {
      cwd: at("u/repo/app"),
      project: at("u/repo"),
      canonical: at("u/main"),
      worktrees: at("u/.local/share/abucode/worktree/abc123"),
      home: at("u"),
      tmp: at("tmp/abucode"),
    }
    const folders = projectFolders(dirs)
    const inside = [
      "src/index.ts",
      "../README.md",
      ".",
      // Core's catch-all resource, which automations check their grants with.
      "*",
      // How core names a local folder that reads like a machine path; `local` is never a machine.
      "./gpu:/notes.md",
      "local:/notes.md",
      at("u/repo/lib/index.ts"),
      at("u/main/src/index.ts"),
      at("u/.local/share/abucode/worktree/abc123/task/src/index.ts"),
      at("u/.opencode/plan/2026-11-26-plan.md"),
      at("tmp/abucode/scratch/probe.ts"),
    ]
    const outside = [
      "../../.zshenv",
      at("u/.zshenv"),
      at("u/.gitconfig"),
      at("u/.bun/bin/bun"),
      at("u/.cache/abucode/npm/node_modules/plugin/index.js"),
      at("u/.local/share/abucode/worktree/def456/task/index.ts"),
      at("u/.opencode/plugin/guard.ts"),
      at("u/repo-other/index.ts"),
      at("tmp/other/probe.ts"),
      "gpu:/home/u/.zshenv",
      "gpu:~/.zshenv",
    ]

    expect(editsOutsideProject(inside, folders)).toEqual([])
    expect(editsOutsideProject(outside, folders)).toEqual(outside)
    // A checkout at a filesystem root does not make every file part of the project.
    const root = path.parse(base).root
    expect(editsOutsideProject([at("u/.zshenv")], projectFolders({ ...dirs, project: root, canonical: root }))).toEqual(
      [at("u/.zshenv")],
    )
    // A project without a worktree folder of its own, such as one with the shared id `global`, asks for any worktree.
    const worktree = at("u/.local/share/abucode/worktree/abc123/task/index.ts")
    expect(editsOutsideProject([worktree], projectFolders({ ...dirs, worktrees: undefined }))).toEqual([worktree])
  })

  // Windows needs extra rights to create a symbolic link.
  test.skipIf(process.platform === "win32")("follows links to where a write lands", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abucode-outside-")))
    try {
      const at = (relative: string) => path.join(root, relative)
      fs.mkdirSync(at("home/.config"), { recursive: true })
      fs.mkdirSync(at("repo/src"), { recursive: true })
      fs.mkdirSync(at("tmp/abucode"), { recursive: true })
      fs.symlinkSync(at("home"), at("repo/linked"))
      // Writing through a link whose target does not exist yet creates that target.
      fs.symlinkSync(at("home/.gitconfig"), at("repo/notes.md"))
      fs.symlinkSync("../home/.zshenv", at("repo/relative.md"))
      fs.symlinkSync(at("repo"), at("home/projects-link"))
      const folders = projectFolders({
        cwd: at("repo"),
        project: at("repo"),
        canonical: at("repo"),
        worktrees: at("data/worktree/abc123"),
        home: at("home"),
        tmp: at("tmp/abucode"),
      })

      expect(editsOutsideProject(["linked/.zshenv", "notes.md", "relative.md", "src/index.ts"], folders)).toEqual([
        "linked/.zshenv",
        "notes.md",
        "relative.md",
      ])
      // Another spelling of a file in the project is still inside it.
      expect(editsOutsideProject([at("home/projects-link/src/index.ts")], folders)).toEqual([])

      // A folder replaced by a link after its real path was read does not take its exemption along.
      fs.renameSync(at("tmp/abucode"), at("tmp/abucode-before"))
      fs.symlinkSync(at("home"), at("tmp/abucode"))
      expect(editsOutsideProject([at("tmp/abucode/.zshenv")], folders)).toEqual([at("tmp/abucode/.zshenv")])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

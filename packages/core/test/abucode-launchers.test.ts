import { expect, test } from "bun:test"
import { chmod, symlink } from "node:fs/promises"
import path from "node:path"
import { Flag } from "@opencode/core/flag"
import { tmpdir } from "./fixture/tmpdir"

const root = path.join(import.meta.dir, "../../..")

// What a from-source engine would turn on if it were started with this OPENCODE_FLAGS.
const on = (overrides: string | undefined) =>
  Object.entries(Flag.resolve({ entries: [], channel: "local", overrides }))
    .filter(([, state]) => state.enabled)
    .map(([key]) => key)

// ABuCode runs from source, where every flag that is not opt-in only defaults to on. Its launchers switch them off
// through OPENCODE_FLAGS, so a merge that adds a flag fails here until all five launchers, and the copy of the list in
// the guide, name it.
test.each([
  "abucode.cmd",
  "abucode.sh",
  "abucode_desktop.cmd",
  "abucode_desktop.sh",
  "packages/cli/bin/abucode.cjs",
  "ABUCODE.md",
])("%s lists every flag a from-source build turns on", async (file) => {
  const text = await Bun.file(path.join(root, file)).text()

  expect(on(text.match(/(?:-[a-z0-9_]+,)+-[a-z0-9_]+/)?.[0])).toEqual([])
})

// The list only counts if the engine receives it, so the launchers are run with a stand-in for `bun` that prints
// the OPENCODE_FLAGS it was handed. The stand-in's folder is the child's whole PATH: a launcher that cannot find it
// fails, and can never reach the real `bun` and start an engine.
test.each([
  "packages/cli/bin/abucode.cjs",
  ...(process.platform === "win32" ? ["abucode.cmd", "abucode_desktop.cmd"] : ["abucode.sh", "abucode_desktop.sh"]),
])("%s hands the engine its list, then the flags the caller named", async (launcher) => {
  await using dir = await tmpdir()
  await Bun.write(path.join(dir.path, "bun.cmd"), "@echo %OPENCODE_FLAGS%\r\n")
  await Bun.write(path.join(dir.path, "bun"), '#!/bin/sh\necho "$OPENCODE_FLAGS"\n')
  await chmod(path.join(dir.path, "bun"), 0o755)
  // A shell launcher also needs `bash`, for its `#!` line, and `dirname`. The folder links to those two and to nothing
  // else, so the system folders, which may hold a real `bun`, stay off PATH.
  if (launcher.endsWith(".sh"))
    await Promise.all(["bash", "dirname"].map((tool) => symlink(Bun.which(tool) ?? tool, path.join(dir.path, tool))))

  const handed = (flags?: string) =>
    new Response(
      Bun.spawn(
        launcher.endsWith(".cjs")
          ? [process.execPath, launcher, "-e", "console.log(process.env.OPENCODE_FLAGS)"]
          : launcher.endsWith(".sh")
            ? // Started by its own path, as from a terminal, so its mode bits and `#!` line are part of what runs.
              [path.join(root, launcher)]
            : [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), "/d", "/c", `.\\${launcher}`],
        {
          // A relative launcher path keeps cmd.exe's quoting rules out of it, wherever the checkout lives.
          cwd: root,
          env: {
            // BASH_ENV and ENV name a file a shell reads as it starts, which could put another folder on PATH.
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !/^(path|opencode_flags|bash_env|env)$/i.test(key)),
            ),
            ...(flags === undefined ? {} : { OPENCODE_FLAGS: flags }),
            PATH: dir.path,
            // abucode.cjs starts this binary instead of looking for `bun`.
            ABUCODE_BIN_PATH: process.execPath,
          },
          stdout: "pipe",
        },
      ).stdout,
    ).text()

  // Any flag the list switches off will do as the one the caller asks for.
  const [wanted] = on(undefined)
  const [pinned, named] = await Promise.all([handed(), handed(wanted)])

  expect(on(pinned.trim())).toEqual([])
  expect(on(named.trim())).toEqual([wanted])
})

import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ProjectTrust } from "@opencode/util/project-trust"
import { localPluginDirectories } from "../src/plugin/discovery"
import { untrustedFolders } from "../src/plugin/project-trust"
import { tmpdir } from "./fixture/fixture"

// The engine's config for a location while project trust is on holds the trust list as a document at its path.
const trustOn = (config: string) => [{ type: "document", path: path.join(config, ProjectTrust.file), info: {} }]

// Two Git projects next to each other; the list trusts one of them.
const projects = async (root: string) => {
  const config = path.join(root, "config")
  const trusted = path.join(root, "trusted")
  const other = path.join(root, "other")
  await Promise.all([trusted, other].map((project) => mkdir(path.join(project, ".git"), { recursive: true })))
  await Bun.write(
    path.join(config, ProjectTrust.file),
    ProjectTrust.format([trusted, "relative/entries/match/nothing"]),
  )
  return { config, trusted, other }
}

test("holds back the plugin folders of a project that is not trusted, as the engine does", async () => {
  await using tmp = await tmpdir()
  const folders = await projects(tmp.path)
  const untrusted = await untrustedFolders({ configDirectory: folders.config, entries: trustOn(folders.config) })

  expect(await localPluginDirectories(folders.trusted, folders.config, untrusted)).toEqual([
    path.join(folders.config, "plugins"),
    path.join(folders.trusted, ".opencode", "plugins"),
  ])
  expect(await localPluginDirectories(folders.other, folders.config, untrusted)).toEqual([
    path.join(folders.config, "plugins"),
  ])
})

test("holds no plugin folder back while the engine's config says project trust is off", async () => {
  await using tmp = await tmpdir()
  const folders = await projects(tmp.path)
  const untrusted = await untrustedFolders({ configDirectory: folders.config, entries: [] })

  expect(untrusted(folders.other)).toBe(false)
})

// A terminal that cannot read the engine's config cannot tell whether project trust is on, so it holds back.
test("holds back what the list does not cover when the engine's config cannot be read", async () => {
  await using tmp = await tmpdir()
  const folders = await projects(tmp.path)
  const untrusted = await untrustedFolders({ configDirectory: folders.config, entries: undefined })

  expect([untrusted(folders.trusted), untrusted(folders.other)]).toEqual([false, true])
})

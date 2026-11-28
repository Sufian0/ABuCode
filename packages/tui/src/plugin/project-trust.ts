import path from "node:path"
import { Option, Schema } from "effect"
import { Entry } from "@opencode/schema/config"
import { FSUtil } from "@opencode/util/fs-util"
import { ProjectTrust } from "@opencode/util/project-trust"

const decodeEntries = Schema.decodeUnknownOption(Schema.Array(Entry))

/**
 * ABuCode: project trust. Tells which project folders' `.opencode` plugins the terminal leaves unloaded, as the engine
 * does. It follows the engine's decision: while project trust is on, the location's config (`entries`, from config.get)
 * holds the trust list as a document at the list's path. When that config cannot be read, every folder the list in
 * `configDirectory` does not cover stays unloaded.
 */
export async function untrustedFolders(input: { readonly configDirectory: string; readonly entries: unknown }) {
  const list = Option.match(decodeEntries(input.entries), {
    onNone: () => path.join(input.configDirectory, ProjectTrust.file),
    onSome: (entries) =>
      entries.find(
        (entry) =>
          entry.type === "document" && entry.path !== undefined && path.basename(entry.path) === ProjectTrust.file,
      )?.path,
  })
  if (list === undefined) return () => false
  const listed = Option.getOrElse(
    ProjectTrust.parse(
      await Bun.file(list)
        .text()
        .catch(() => undefined),
    ),
    () => [],
  )
  const trusted = listed.filter((folder) => path.isAbsolute(folder)).map((folder) => FSUtil.resolve(folder))
  return (folder: string) => ProjectTrust.covering(trusted, FSUtil.resolve(folder)) === undefined
}

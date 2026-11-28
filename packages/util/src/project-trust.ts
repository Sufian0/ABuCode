export * as ProjectTrust from "./project-trust.js"

import path from "path"
import { Option, Schema } from "effect"
import { FSUtil } from "./fs-util.js"

/**
 * ABuCode: the file in the global config folder that lists the folders whose own config may run code while project
 * trust is on. A listed folder covers every folder below it. Only the owner writes it, by hand or with /trust; a
 * repository's config never names a folder here.
 */
export const file = "trusted-projects.json"

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ trusted: Schema.Array(Schema.String) })),
)

/**
 * The entries a list holds, as written: none when there is no list (`undefined`), and `None` when the text is not a
 * list. Readers treat `None` as an empty list, so nothing is trusted by mistake.
 */
export function parse(text: string | undefined) {
  if (text === undefined) return Option.some<readonly string[]>([])
  return Option.map(decode(text), (list) => list.trusted)
}

export function format(trusted: readonly string[]) {
  return `${JSON.stringify({ trusted }, null, 2)}\n`
}

/** The listed folder that holds `directory`, if any. An entry that is not absolute matches nothing. Compare real paths. */
export function covering(trusted: readonly string[], directory: string) {
  return trusted.find((folder) => path.isAbsolute(folder) && FSUtil.contains(folder, directory))
}

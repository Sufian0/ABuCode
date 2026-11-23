import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ABUCODE_REPO_ROOT = path.resolve(HERE, "..", "..", "..")
export const ABUCODE_ENV_LOCAL = path.join(ABUCODE_REPO_ROOT, ".env.local")

function remapCrossOsPath(value: string): string {
  const norm = value.replaceAll("\\", "/").trim()
  if (process.platform === "win32" && norm.startsWith("/Users/")) {
    const match = /\/MultiCode-envs\/data\/(.+)$/.exec(norm)
    if (match?.[1] && fs.existsSync("D:/")) return `D:/MultiCode-envs/data/${match[1]}`
    return ""
  }
  if (process.platform === "darwin" && /^[A-Za-z]:\//.test(norm)) {
    const match = /\/MultiCode-envs\/data\/(.+)$/i.exec(norm)
    if (match?.[1]) return path.join(os.homedir(), "MultiCode-envs", "data", match[1])
    return ""
  }
  return value
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export function resolveContentRoot(): string {
  const configured =
    process.env.ABUCODE_CONTENT_DIR?.trim() ||
    process.env.MULTICODE_CONTENT_DIR?.trim() ||
    ""
  const remapped = configured ? remapCrossOsPath(configured) : ""
  if (remapped && isDir(remapped)) return path.resolve(remapped)

  const candidates = [
    ABUCODE_REPO_ROOT,
    path.resolve(ABUCODE_REPO_ROOT, "..", "Mano-Stories"),
    path.resolve(ABUCODE_REPO_ROOT, "..", "MultiCode"),
    path.join(os.homedir(), "Documents", "Projects", "Mano-Stories"),
    "D:/Libraries/Documents/1ACode/Mano-Stories",
  ]
  for (const candidate of candidates) {
    if (isDir(path.join(candidate, "Bots", "Prompts", "cards"))) {
      return path.resolve(candidate)
    }
  }
  return ABUCODE_REPO_ROOT
}

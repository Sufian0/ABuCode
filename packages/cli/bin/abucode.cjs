#!/usr/bin/env node

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")

const scriptDir = path.dirname(fs.realpathSync(__filename))
const cliDir = path.resolve(scriptDir, "..")
const envBin = process.env.ABUCODE_BIN_PATH || process.env.OPENCODE_BIN_PATH
const srcEntry = path.resolve(cliDir, "src", "index.ts")

if (envBin && fs.existsSync(envBin)) {
  const child = childProcess.spawn(envBin, process.argv.slice(2), { stdio: "inherit" })
  child.on("exit", (code) => process.exit(typeof code === "number" ? code : 0))
} else if (fs.existsSync(srcEntry)) {
  const bunExe = process.platform === "win32" ? "bun.exe" : "bun"
  const child = childProcess.spawn(bunExe, ["run", "--cwd", cliDir, "src/index.ts", ...process.argv.slice(2)], {
    stdio: "inherit",
  })
  child.on("exit", (code) => process.exit(typeof code === "number" ? code : 0))
} else {
  require("./opencode.cjs")
}

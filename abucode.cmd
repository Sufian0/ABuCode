@echo off
setlocal
bun run --cwd "%~dp0packages\cli" src/index.ts %*

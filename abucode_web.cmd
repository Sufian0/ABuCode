@echo off
setlocal
bun run --cwd "%~dp0packages\app" dev %*

@echo off
setlocal
bun --cwd "%~dp0packages\desktop" dev %*

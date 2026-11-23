@echo off
setlocal
rem Upstream switches its experimental features on for from-source builds. Keep them off unless asked for:
rem flags the caller names in OPENCODE_FLAGS come last and win. See ABUCODE.md, "Experimental features".
set "ABUCODE_FLAGS=-full_codemode,-home_memory,-project_overlay,-machines,-media_blob,-artifacts,-sqlite_fts,-console_watches,-recommended_api,-opencode_api"
if defined OPENCODE_FLAGS set "OPENCODE_FLAGS=%ABUCODE_FLAGS%,%OPENCODE_FLAGS%"
if not defined OPENCODE_FLAGS set "OPENCODE_FLAGS=%ABUCODE_FLAGS%"
bun --cwd "%~dp0packages\desktop" dev %*

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Upstream switches its experimental features on for from-source builds. Keep them off unless asked for:
# flags the caller names in OPENCODE_FLAGS come last and win. See ABUCODE.md, "Experimental features".
ABUCODE_FLAGS="-full_codemode,-home_memory,-project_overlay,-machines,-media_blob,-artifacts,-sqlite_fts,-console_watches,-recommended_api,-opencode_api"
export OPENCODE_FLAGS="${ABUCODE_FLAGS}${OPENCODE_FLAGS:+,${OPENCODE_FLAGS}}"
exec bun run --cwd "$ROOT/packages/cli" src/index.ts "$@"

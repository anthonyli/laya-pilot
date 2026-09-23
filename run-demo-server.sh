#!/usr/bin/env bash
set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then echo 'Node.js 20+ is required' >&2; exit 1; fi
exec "$NODE_BIN" "$SCRIPT_DIR/examples/demo-server.mjs"

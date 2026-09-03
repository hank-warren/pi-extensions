#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

python3 scripts/validate.py

while IFS= read -r -d '' script; do
  bash -n "$script"
done < <(find packages scripts -type f -name '*.sh' -print0)
printf 'Shell syntax: ok\n'

python3 - <<'PY'
import ast
from pathlib import Path

paths = sorted(
    p
    for p in [
        *Path("packages").rglob("*.py"),
        *Path("scripts").rglob("*.py"),
    ]
    if "node_modules" not in p.parts
)
for path in paths:
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
print(f"Python syntax: ok ({len(paths)} files)")
PY

npm run typecheck
# One node --test invocation over every test in the repository. It was twelve
# sequential npm scripts, which spent more time starting node than running tests
# and needed a new line here per package. The preload it loads gives every forked
# test process a private HOME and agent dir; see test/support/hermetic.ts.
npm run test:unit

npm run test:smoke-load

discovery_err=$(mktemp)
discovery_agent_dir=$(mktemp -d)
trap 'rm -f "$discovery_err"; rm -rf "$discovery_agent_dir"' EXIT
# Throwaway agent dir, for the same reason smoke-load.mjs sets one: extensions
# resolve their own config through getAgentDir(), and pi-multi-login performs a
# one-time credential adoption *write* on first load. The gate must never touch
# or read the host's real ~/.pi.
PI_CODING_AGENT_DIR="$discovery_agent_dir" pi -ne -e . --list-models >/dev/null 2>"$discovery_err"
if [[ -s "$discovery_err" ]]; then
  printf 'Pi package discovery emitted warnings:\n' >&2
  cat "$discovery_err" >&2
  exit 1
fi
printf 'Pi package discovery: ok\n'

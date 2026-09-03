#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks detect --source . --no-banner --redact
fi

printf 'gitleaks is unavailable; running limited high-confidence fallback scan\n' >&2

# The fallback is the only remaining gate here, so a missing or broken rg must be
# a hard failure. `if rg ...; then` alone treats "command not found" (127) and
# rg's own error exit (2) as "no matches", which passes the scan without ever
# looking at the tree.
if ! command -v rg >/dev/null 2>&1; then
  printf 'neither gitleaks nor ripgrep (rg) is available; cannot scan for secrets\n' >&2
  exit 1
fi

pattern='-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{36,}|AKIA[0-9A-Z]{16}|hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}|discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9._-]+'
status=0
rg --hidden --glob '!.git/**' --glob '!scripts/scan-secrets.sh' -n -- "$pattern" . || status=$?
case "$status" in
  0)
    printf 'Potential credential material found\n' >&2
    exit 1
    ;;
  1) ;;
  *)
    printf 'ripgrep failed with exit code %s; treating the scan as failed\n' "$status" >&2
    exit 1
    ;;
esac
printf 'Fallback secret scan: ok\n'

# Security Policy

## Supported versions

This project moves forward rather than backporting. Fixes land in the latest published version of the affected package on npm; older versions are not patched.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting instead: go to the [Security tab](https://github.com/hank-warren/pi-extensions/security/advisories/new) and open a draft advisory. That keeps the report private between us until there is a fix.

Please include what you found, which package and version it affects, and how to reproduce it. If it is exploitable, a proof of concept helps a lot.

This is a single-maintainer project, so I cannot promise a response window. I will acknowledge what I can, as soon as I can.

## Scope

These are Pi extensions: they run inside your own agent session, on your own machine, with your own credentials. The things most worth reporting are therefore:

- An extension widening tool permissions beyond what it declares — particularly [`pi-auto-permissions`](packages/pi-auto-permissions), which gates Bash execution, and [`pi-plan-mode`](packages/pi-plan-mode), which restricts tools while planning.
- Credentials, tokens, or session contents being logged, persisted, or transmitted somewhere they should not be.
- Untrusted input reaching a shell, an `eval`, or a tool call without being treated as untrusted.

Out of scope: anything requiring an attacker who already controls your machine or your agent config, and anything in Pi itself — report that to [the Pi project](https://github.com/earendil-works/pi).

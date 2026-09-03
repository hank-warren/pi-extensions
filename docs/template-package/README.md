# pi-TEMPLATE

Starter skeleton for a new public Pi package. It is a **template, not a live package**: it lives under `docs/` rather than `packages/` so it never becomes an npm workspace member, never enters `package-lock.json`, and can never be published. Copy it to create a real package.

## Why this lives in docs/ and not packages/

`packages/*` is the npm workspace glob and `scripts/validate.py` requires the directories under `packages/` to match `PUBLIC_PACKAGES` exactly. A template placed there would:

- be added to `package-lock.json` as a workspace member and symlinked into `node_modules/@hank-warren/`;
- be walked by the `for pkg in packages/*/` loop in `.github/workflows/publish.yml`;
- have to be special-cased in `PUBLIC_PACKAGES` and the package-dir equality check.

`private: true` does make `npm publish` refuse it (`Skipping workspace @hank-warren/pi-TEMPLATE, marked as private`), but keeping it out of `packages/` removes the whole class of interaction instead of relying on that one guard. `validate.py` therefore needs no template exception at all.

## Copy to create a package

Mirrors the seven-step checklist in [AGENTS.md](../../AGENTS.md), which this splits into eight by taking `package.json` a field at a time.

1. Copy the directory and drop the template's own test scaffolding into place:

   ```bash
   cp -r docs/template-package packages/pi-<name>
   ```

2. Replace every `TEMPLATE` placeholder:
   - `package.json`: `name` (`@hank-warren/pi-<name>`), `description`, `keywords`, `repository.directory`, `homepage`;
   - `index.ts`: the header comment, the extension function name, and the example `template_greet` tool;
   - `test/template.test.ts`: rename to `<name>.test.ts` and test the real surface. Nothing registers it: `npm test` runs one `node --test` over `packages/*/test/*.test.ts`;
   - this `README.md`: replace it entirely with real install/usage/configuration docs.

   Keep `"version": "0.1.0"`, `"type": "module"`, `"license": "MIT"`, the `pi-package` and `pi-extension` keywords, and `"pi": { "extensions": ["./index.ts"] }`.

3. **Remove `"private": true`** — it exists only to keep the template unpublishable. A real public package must not be private.

4. Keep the `files` allowlist covering every `*.ts` source plus `README.md`, `LICENSE` and `CHANGELOG.md` (written by `changeset version`, so it is listed before it exists), and never `test/`. `validate.py` fails if any `*.ts` file outside `test/` is missing from `files` — nested sources need either their own entry (`tool/schema.ts`) or a directory entry (`src`) — and if `CHANGELOG.md` is absent from the allowlist.

5. Trim `peerDependencies` to the subset actually imported (all pinned to `"*"`): `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`. Never put these in `dependencies`.

6. Register the package everywhere the gate enforces:
   - `PUBLIC_PACKAGES` in `scripts/validate.py`;
   - `EXPECTED_EXTENSION_ENTRYPOINTS` in `scripts/validate.py` **and** `pi.extensions` in the root `package.json` (must match exactly, same order);
   - `EXPECTED_SURFACES` in `scripts/smoke-load.mjs`, which compares exact sets, so a new entrypoint fails until its registration surface is listed.

7. Refresh the lockfile — a new workspace member missing from `package-lock.json` fails the publish workflow's `npm ci` with `Missing: @hank-warren/pi-<name> from lock file`. `validate.py` checks lockfile membership, so `npm test` catches it locally first:

   ```bash
   npm install --package-lock-only
   ```

8. Verify, then add the package to the root [README.md](../../README.md) table:

   ```bash
   npm test
   npm run scan-secrets
   cd packages/pi-<name> && npm pack --dry-run   # only intended files
   pi -ne -e ./packages/pi-<name> --list-models  # loads with zero diagnostics
   ```

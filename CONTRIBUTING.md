# Contributing

Thanks for taking an interest. Issues and pull requests are both welcome.

This is a personal project with a single maintainer. That shapes a few things, so they are written down here rather than left as a surprise.

## Ground rules

- **`main` is maintainer-only.** Nobody pushes to it directly, including me. Everything lands through a pull request.
- **Contribute from a fork.** You do not need write access, and I do not hand it out. Fork, branch, open a pull request.
- **I may be slow, and I may say no.** These packages track how I personally work day to day. A change can be well built and still not fit that, and I would rather decline it kindly than let it sit forever. If you are about to spend real effort, open an issue first and ask.

## Reporting a bug

Open an issue with the version of the package, the version of Pi, and what you expected versus what happened. A minimal reproduction is worth more than anything else you could include.

If you are not sure whether something is a bug or just how it works, file it anyway.

## Suggesting a package or feature

Open an issue and describe the workflow you are trying to fix, not just the feature you have in mind. Half the packages here exist because a problem got described well enough that the shape of the fix became obvious.

## Pull requests

1. Fork and branch from `main`.
2. Make the change. There is no build step — the extensions are TypeScript that Pi loads directly.
3. Run the gate:

   ```bash
   npm ci
   npm test
   npm run scan-secrets
   ```

   `npm test` runs everything: package validation, syntax sweeps, the typecheck, the unit suite, an extension load smoke test, and Pi package discovery. It should be green before you open the pull request.
4. Use [conventional commits](https://www.conventionalcommits.org/), lowercase, no emojis.
5. Open the pull request against `main` and fill in the template.

**Do not add a changeset.** Releases are cut separately, after a change has been exercised in a real session — see the publishing notes in [AGENTS.md](AGENTS.md). If your change should ship, I will handle the release.

Some notes that will save you a round trip:

- Packages are self-contained. Do not import across packages by relative path.
- New packages have a checklist in [AGENTS.md](AGENTS.md) and a skeleton in [`docs/template-package/`](docs/template-package/).
- No secrets, ever. `npm run scan-secrets` gates this, and so does review.

## Security

Please do not report security issues in a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Be decent to people. I moderate the issue tracker with a light touch and a low tolerance for hostility.

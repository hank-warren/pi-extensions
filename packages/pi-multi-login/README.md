# @hank-warren/pi-multi-login

Register a **second (third, fourth…) OAuth login** for any provider Pi already knows how to sign in to. Each additional login is an ordinary provider with its own id — `openai-codex-work`, `anthropic-personal` — so it gets its own credential slot in `auth.json` while reusing the base provider's OAuth flow, transport and model catalog.

Use it to keep a subscription account separate from a work account, or to give a background reviewer (such as [`@hank-warren/pi-auto-permissions`](../pi-auto-permissions/README.md)) a dedicated login that never competes with your interactive session for rate limits.

## Install

```bash
pi install npm:@hank-warren/pi-multi-login
```

Try it without installing:

```bash
pi -e npm:@hank-warren/pi-multi-login
```

## Usage

Run `/multi-login` in an interactive session:

- **Add a login…** — pick a base provider, type a suffix. The alias is written to the config file and registered immediately; then run `/login`, pick the alias, and complete OAuth there.
- **An existing alias** — remove it, which deletes both the credential and the provider.

All authentication goes through Pi's own `/login` — signing in for the first time and re-authenticating later (token expired, wrong account) both work there, because aliases are ordinary providers. `/multi-login` deliberately never drives an OAuth flow itself: `/login` implements every prompt type a provider's flow can emit (including the option choice OpenAI Codex asks for), so there is exactly one login path to keep correct. Aliases also appear in `/model` and `pi --list-models` with no extra work.

Once an alias has a credential you can select it like any other model:

```bash
pi --model openai-codex-work/gpt-5.6-sol -p "say hi"
```

## Configuration

Aliases live in:

```text
~/.pi/agent/pi-multi-login.json
```

When `PI_CODING_AGENT_DIR` points elsewhere, the configuration follows that agent directory. Set `PI_MULTI_LOGIN_CONFIG` to use an explicit file path.

```json
{
  "aliases": [
    { "base": "openai-codex", "suffix": "auto-permissions" },
    { "base": "anthropic", "suffix": "work", "name": "Anthropic (work)" }
  ]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `base` | yes | Provider id whose OAuth flow, transport and model catalog the alias reuses. It must expose an OAuth login, and it must not itself be an alias. |
| `suffix` | yes | Lowercase slug (`^[a-z0-9]+(-[a-z0-9]+)*$`) appended to `base`. The provider id is always `` `${base}-${suffix}` ``. |
| `name` | no | Display name. Defaults to `` `${baseProviderName} (${suffix})` ``. |

`/multi-login` rewrites this file, but editing it by hand is supported — the format is the point. Unknown fields are ignored; a malformed file registers no aliases and reports the problem once at session start.

The providers that can act as a base are the ones Pi offers an OAuth login for: `anthropic`, `github-copilot`, `kimi-coding`, `openai-codex`, `openrouter`, `radius`, `xai`. `/multi-login` lists whatever the running Pi version actually offers.

## How it works

Aliases register during the extension **load** phase rather than at `session_start`. `pi --list-models`, `pi --model provider/id` and `pi auth` all run before any session exists, so a session-only registration is invisible to them. Load-phase registrations are queued and flushed before every extension's `session_start`, so other extensions see the aliases regardless of load order.

At `session_start` each alias is re-cloned from the *composed* base provider, so an alias inherits any transport reshaping a config overlay applies to its base (this is what keeps an `anthropic` alias working under `@gotgenes/pi-anthropic-auth`).

Model lists are snapshots taken at clone time; the base provider remains the sole owner of catalog refresh.

### Adoption of existing credentials

The first time the extension runs without a config file, it scans `auth.json` for credentials whose id is not itself a provider id but does extend one — `openai-codex-auto-permissions` extends `openai-codex` — and adopts them as aliases. The base is the *longest* matching OAuth provider id, which is what keeps `openai-codex-auto-permissions` attached to `openai-codex` rather than to `openai`.

This makes the package a drop-in replacement for the dedicated login that `@hank-warren/pi-auto-permissions` used to register itself. The scan runs once: writing the config file (even as `{"aliases": []}`) is what prevents it from running again, so an alias you delete stays deleted.

## Cost

A host with no aliases and an existing config file does no work at startup beyond reading one small JSON file — no model runtime, no network.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT

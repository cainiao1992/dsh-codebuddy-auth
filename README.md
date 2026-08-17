# dsh-codebuddy-auth

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) port of [kuops/opencode-codebuddy-auth](https://github.com/kuops/opencode-codebuddy-auth) — use Tencent CodeBuddy (IOA) chat models directly in DSH: browser OAuth login, automatic token renewal, and automatic model-list sync. Log in once, and craft-agent models such as `deepseek-v4-pro`, `glm-5.2`, `kimi-k3-1`, and `minimax-m3` appear in the model picker.

## How it works

This plugin registers a **native ctx.llm adapter** (ported from [shatyuka/dsh-llm-codebuddy](https://github.com/shatyuka/dsh-llm-codebuddy), MIT) and owns the chat wire itself: minimal identity headers, the CLI client User-Agent, and its own SSE streaming + message serialization — no shared pi-ai route, so no attribution-UA override and no IDE identity block:

| OpenCode plugin | DSH equivalent |
| --- | --- |
| `config` hook: register provider + discover models from `/v3/config` | a native adapter registering the `codebuddy` route on `ctx.llm`, reading the catalog live from `/v3/config` (5-min cache) |
| `auth` hook: IOA browser OAuth + polling + refresh | the `codebuddy` model tool (`login` / `status` / `refresh` / `logout` / `sync-models`) + renewal at startup and every 30 min |
| token stored in `auth.json` | the `ctx.credentials` service (`~/.dsh/.credentials.yaml`, resolved per request, hot-swapped) |

## Installation

DSH installs profile plugins through its official `dsh plugin` CLI (a thin `pnpm` forwarder that installs the dependency, appends the package to the profile's `dsh.profile.bundles` layer stack, and mounts the plugin via the bundle's in-package patch — no manual file editing).

**Prerequisite**: make sure `pnpm` is on your `PATH`, e.g. via Homebrew:

```bash
brew install pnpm
```

### Install the plugin

```bash
dsh plugin --profile web add github:cainiao1992/dsh-codebuddy-auth
```

This single command resolves the dependency from GitHub, installs it, and activates the plugin as a profile layer.

### Restart DSH

Restart DSH. The plugin registers the `codebuddy` route natively on `ctx.llm` at startup (a legacy `llm-pi-ai` settings route from earlier versions is removed automatically), so CodeBuddy already appears in the Models page — unauthenticated — before you log in.

## Log in

You can log in either through the agent, or from the command line. Pick one.

### Option A — through the agent

Tell the agent **"log in with codebuddy"**. The agent calls the `codebuddy` tool, which opens the IOA login page in your browser and polls in the background; once the token arrives it writes credentials and warms the catalog, and the next request hits the chat endpoint directly with the CLI client identity.

### Option B — from the command line (headless / bootstrapping)

```bash
# Directly, no npm deps, Node >= 18 only:
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# Or via the package bin from the install directory:
cd ~/.dsh/profiles/web && pnpm exec codebuddy-login

# Add --no-browser on a remote server / headless box
```

The CLI only writes the credentials — the native adapter owns the route, so there is no settings route to manage; `--international` merely selects the OAuth endpoints the login itself uses.

## Uninstall

```bash
dsh plugin --profile web remove dsh-codebuddy-auth
```

This removes the dependency and takes the plugin back out of the profile layer stack. Restart DSH to unload it.

## International edition

The plugin targets the **China edition** by default (`copilot.tencent.com` / `www.codebuddy.cn`). Select the **international edition** (`www.codebuddy.ai`) through the mount row's `edition: intl` config:

```yaml
# your cordis.patch.yml mount row:
- id: codebuddy-auth
  name: dsh-codebuddy-auth
  edition: intl          # omitted = China edition
```

The adapter and the login/model-discovery endpoints then all use `www.codebuddy.ai`. The CLI's `--international` only selects the international OAuth endpoints for the login itself.

## Usage

- **Switch models**: pick any model under CodeBuddy in the model picker (e.g. `deepseek-v4-pro`)
- **Status**: "check codebuddy status" → the `codebuddy` tool's `status` action
- **Renewal (automatic, three layers)**: ① at every startup, the token is renewed when less than 5 minutes of validity remains (or it has already expired); ② while running, a check every 30 minutes renews whenever less than 1 hour remains — covering a long-lived dsh that never restarts; ③ if the refresh token itself is invalidated (password change / revocation), the first two layers fail and log it — then say "refresh codebuddy" to confirm, or log in again
- **Model updates**: after Tencent ships new models, say "sync codebuddy models" → `sync-models`
- **Logout**: "log out of codebuddy" → clears stored credentials

### Reasoning

Each model is declared with its **full real reasoning capability** from `/v3/config`, so the model picker shows the levels each model actually offers — plus an **off** level on models that report `canDisableThinking` (e.g. `deepseek-v4-pro`, `glm-5.2`; `hy3` is reasoning-only and gets no `off`):

- **Selectable levels** (per model): `supportedEfforts` mirrors straight into the picker — `deepseek-v4-pro` offers `low` / `high` / `xhigh` / `off`, `hy3` offers `low` / `high`, fixed-effort models (e.g. `glm-5.1`) offer their single `medium`. Sent as `reasoning: { effort }`.
- **Default level**: with nothing configured, no effort is sent and each model falls back to its **own server-side default** (`high` for `auto` / `hy3` / `glm-5.2` / `deepseek-v4-*`, `medium` for the rest).
- **Default level**: each model uses the `defaultEffort` its `/v3/config` entry reports (e.g. glm-5.2 defaults to High); every declared level stays selectable in the picker.

## Files

- `lib/index.js` — the Cordis host plugin (host composition row). Registers the `codebuddy` tool; refreshes/syncs at startup.
- `lib/codebuddy-core.mjs` — core OAuth, JWT decoding, and `/v3/config` discovery logic; dependency-free.
- `bin/login-flow.mjs` — standalone login CLI; no npm dependencies.
- `cordis.patch.yml` — in-package patch (self-mount row for bundle consumers).

## Known limitations (all verified empirically)

- `POST /v2/chat/completions` **does not check User-Agent** — any UA works; but the request must be `stream: true` (non-streaming returns `code 11101`). DSH's pi-ai adapter is streaming by default, so nothing to handle.
- `GET /v3/config` (model discovery) **does check User-Agent** — any non-VSCode-shaped UA gets a 400. The plugin's `fetchRemoteModels` sends its own direct request (bypassing DSH's user-agent attribution override) and explicitly carries a VSCode UA.
- CodeBuddy reports `supportsReasoning` on every craft model. Models are now declared with their real reasoning capability (levels per `supportedEfforts`, an `off` level when `canDisableThinking`, and `compat` for the `reasoning: { effort }` wire format), so reasoning is selectable in the model picker rather than stripped.

## License

MIT

# dsh-codebuddy-auth

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) port of [kuops/opencode-codebuddy-auth](https://github.com/kuops/opencode-codebuddy-auth) — use Tencent CodeBuddy (IOA) chat models directly in DSH: browser OAuth login, automatic token renewal, and automatic model-list sync. Log in once, and craft-agent models such as `deepseek-v4-pro`, `glm-5.2`, `kimi-k3-1`, and `minimax-m3` appear in the model picker.

## How it works

The original OpenCode plugin works through three hooks; this package maps each one onto a native DSH seam, with zero interception on the request path (DSH's pi-ai adapter natively speaks the OpenAI-completions protocol, the credential value is sent automatically as `Authorization: Bearer`, and route `headers` pass through verbatim):

| OpenCode plugin | DSH equivalent |
| --- | --- |
| `config` hook: register provider + discover models from `/v3/config` | the `llm-pi-ai.providers.codebuddy` route, which this plugin **creates on first boot** and syncs the real model list into after login |
| `auth` hook: IOA browser OAuth + polling + refresh | the `codebuddy` model tool this plugin registers (`login` / `status` / `refresh` / `logout` / `sync-models`) + automatic renewal at startup |
| token stored in `auth.json` | the `ctx.credentials` credential service (`~/.dsh/.credentials.yaml`, resolved per request, hot-swapped) |

## Installation

DSH installs profile plugins through its official `dsh plugin` CLI (a thin `pnpm` forwarder that installs the dependency, appends the package to the profile's `dsh.profile.bundles` layer stack, and mounts the plugin via the bundle's in-package patch — no manual file editing needed).

**Prerequisite**: make sure `pnpm` is on your PATH, e.g. via Homebrew:

```bash
brew install pnpm
```

### 1. Install

```bash
dsh plugin --profile web add github:cainiao1992/dsh-codebuddy-auth
```

This single command resolves the dependency from GitHub, installs it, and automatically activates the plugin as a profile layer.

### 2. Log in

Restart DSH. That's it for setup — on first boot the plugin **creates the `llm-pi-ai.providers.codebuddy` route itself** (with a placeholder model list), so CodeBuddy already shows in the Models page, unauthenticated. Now tell the agent **"log in with codebuddy"** — the agent calls the `codebuddy` tool: the browser opens the IOA login page, the tool polls every 3 seconds in the background, and once the token arrives it automatically writes credentials, writes JWT-derived identity headers (`X-User-Id` etc.) into the route, and replaces the placeholder models with your account's real `/v3/config` list.

> You can skip the DSH flow entirely and log in from the command line (headless / bootstrapping):

```bash
# Run directly after installing into the profile (no npm deps, Node >= 18 only):
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# Or resolve the local bin through package.json from the install directory:
cd ~/.dsh/profiles/web && pnpm exec codebuddy-login

# Add --no-browser on a remote server / headless box
```

The CLI writes the credentials **and** ensures the `llm-pi-ai.providers.codebuddy` route exists in `settings.yaml` (China edition by default; `--international` pre-creates an international route). The plugin fills in identity headers and the model list at its next startup (or when the `codebuddy` tool is invoked).

### Uninstall

```bash
dsh plugin --profile web remove dsh-codebuddy-auth
```

This removes the dependency and takes the plugin back out of the profile layer stack. Restart DSH to unload it.

## Usage

- **Switch models**: pick any model under CodeBuddy in the model picker (e.g. `deepseek-v4-pro`)
- **Status**: "check codebuddy status" → the `codebuddy` tool's `status` action
- **Renewal (automatic, three layers)**: ① at every startup, the token is renewed when less than 5 minutes of validity remains (or it has already expired); ② while running, a check every 30 minutes renews whenever less than 1 hour remains — covering a long-lived dsh that never restarts; ③ if the refresh token itself is invalidated (password change / revocation), the first two layers fail and log it — then say "refresh codebuddy" to confirm, or log in again
- **Model updates**: after Tencent ships new models, say "sync codebuddy models" → `sync-models`
- **Logout**: "log out of codebuddy" → clears stored credentials

## International edition

The plugin targets the **China edition** by default (`copilot.tencent.com` / `www.codebuddy.cn`). To use the **international edition** (`www.codebuddy.ai`), the easiest path is to log in with the CLI's `--international` flag — it not only logs you into `codebuddy.ai` but also **creates/points the `llm-pi-ai.providers.codebuddy` route at the international API for you**, so a fresh install (no route yet, plugin not yet run) goes straight to the international edition:

```bash
codebuddy-login --international   # or node bin/login-flow.mjs --international
```

Everything else follows automatically:

- **Chat requests** hit `https://www.codebuddy.ai/v2` (the route's `baseURL`).
- **`X-Domain` header** follows the baseURL automatically — the plugin rewrites it to `www.codebuddy.ai` whenever the route points at `codebuddy.ai` (the `sync-models` action, login, and startup all refresh it).
- **Login / refresh / model discovery** (`/v3/config`) automatically use the international endpoints, because the plugin derives its `serverUrl`/`domain` from the same `baseURL`.

If the route already exists, you can also just edit `~/.dsh/settings.yaml` → `llm-pi-ai.providers.codebuddy`:

```yaml
baseURL: https://www.codebuddy.ai/v2
```

Omit `--international` to log into the China edition (the default).

> Tip: switch back to the China edition by setting `baseURL` back to `https://copilot.tencent.com/v2`.

## Files

- `lib/index.js` — the Cordis host plugin (host composition row). Registers the `codebuddy` tool; refreshes/syncs at startup.
- `lib/codebuddy-core.mjs` — core OAuth, JWT decoding, and `/v3/config` discovery logic; dependency-free.
- `bin/login-flow.mjs` — standalone login CLI; no npm dependencies.
- `cordis.patch.yml` — in-package patch (self-mount row for bundle consumers).

## Known limitations (all verified empirically)

- `POST /v2/chat/completions` **does not check User-Agent** — any UA works; but the request must be `stream: true` (non-streaming returns `code 11101`). DSH's pi-ai adapter is streaming by default, so nothing to handle.
- `GET /v3/config` (model discovery) **does check User-Agent** — any non-VSCode-shaped UA gets a 400. The plugin's `fetchRemoteModels` sends its own direct request (bypassing DSH's user-agent attribution override) and explicitly carries a VSCode UA.
- Models are declared as non-reasoning (no reasoning parameters sent), matching the original OpenCode plugin's behavior; the API reports supportsReasoning for every model, so add `compat` on the route if you want it.

## License

MIT

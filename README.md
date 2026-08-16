# dsh-codebuddy-auth

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) port of [kuops/opencode-codebuddy-auth](https://github.com/kuops/opencode-codebuddy-auth) — use Tencent CodeBuddy (IOA) chat models directly in DSH: browser OAuth login, automatic token renewal, and automatic model-list sync. Log in once, and craft-agent models such as `deepseek-v4-pro`, `glm-5.2`, `kimi-k3-1`, and `minimax-m3` appear in the model picker.

## How it works

The original OpenCode plugin works through three hooks; this package maps each one onto a native DSH seam, with zero interception on the request path (DSH's pi-ai adapter natively speaks the OpenAI-completions protocol, the credential value is sent automatically as `Authorization: Bearer`, and route `headers` pass through verbatim):

| OpenCode plugin | DSH equivalent |
| --- | --- |
| `config` hook: register provider + discover models from `/v3/config` | the `llm-pi-ai.providers.codebuddy` route in `~/.dsh/settings.yaml`; after login this plugin syncs the real model list into it |
| `auth` hook: IOA browser OAuth + polling + refresh | the `codebuddy` model tool this plugin registers (`login` / `status` / `refresh` / `logout` / `sync-models`) + automatic renewal at startup |
| token stored in `auth.json` | the `ctx.credentials` credential service (`~/.dsh/.credentials.yaml`, resolved per request, hot-swapped) |

## Installation

### 1. Install the package

```bash
cd ~/.dsh/profiles/web
npm install github:cainiao1992/dsh-codebuddy-auth
```

### 2. Mount the plugin

Add one row to the `insert` list in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: codebuddy-auth
      name: dsh-codebuddy-auth
```

### 3. Add the model route

Add this at the top level of `~/.dsh/settings.yaml` (a minimal placeholder model list is fine — the plugin replaces it with your account's real list after login):

```yaml
llm-pi-ai:
  providers:
    codebuddy:
      displayName: CodeBuddy
      api: openai-completions
      baseURL: https://copilot.tencent.com/v2
      apiKeyEnv: CODEBUDDY_ACCESS_TOKEN
      headers:
        X-Requested-With: XMLHttpRequest
        X-Agent-Intent: craft
        X-IDE-Type: VSCode
        X-IDE-Name: VSCode
        X-IDE-Version: 1.119.0
        X-Product-Version: 4.9.29177644
        X-Env-ID: production
        X-Domain: www.codebuddy.cn
        X-Product: SaaS
      models:
        - id: auto
          name: Auto
          contextWindow: 168000
```

> If you already have other `llm-pi-ai.providers` entries, just append `codebuddy` to the same dict.

### 4. Log in

After restarting DSH, tell the agent **"log in with codebuddy"** — the agent calls the `codebuddy` tool: the browser opens the IOA login page, the tool polls every 3 seconds in the background, and once the token arrives it automatically writes credentials, writes JWT-derived identity headers (`X-User-Id` etc.) into the route, and syncs the real model list from `/v3/config`.

You can also use the CLI outside DSH (headless / bootstrapping):

```bash
# Run directly after installing into the profile per step 1 (no npm deps, Node >= 18 only):
node ~/.dsh/profiles/web/node_modules/dsh-codebuddy-auth/bin/login-flow.mjs

# Or resolve the local bin through package.json from the install directory:
cd ~/.dsh/profiles/web && npm exec codebuddy-login

# Add --no-browser on a remote server / headless box
```

The CLI only writes credentials; identity headers and the model list are filled in by the mounted plugin at its next startup (or when the `codebuddy` tool is invoked).

## Usage

- **Switch models**: pick any model under CodeBuddy in the model picker (e.g. `deepseek-v4-pro`)
- **Status**: "check codebuddy status" → the `codebuddy` tool's `status` action
- **Renewal (automatic, three layers)**: ① at every startup, the token is renewed when less than 5 minutes of validity remains (or it has already expired); ② while running, a check every 30 minutes renews whenever less than 1 hour remains — covering a long-lived dsh that never restarts; ③ if the refresh token itself is invalidated (password change / revocation), the first two layers fail and log it — then say "refresh codebuddy" to confirm, or log in again
- **Model updates**: after Tencent ships new models, say "sync codebuddy models" → `sync-models`
- **Logout**: "log out of codebuddy" → clears stored credentials

## Files

- `lib/index.js` — the Cordis host plugin (host composition row). Registers the `codebuddy` tool; refreshes/syncs at startup.
- `lib/codebuddy-core.mjs` — core OAuth, JWT decoding, and `/v3/config` discovery logic; dependency-free.
- `bin/login-flow.mjs` — standalone login CLI; no npm dependencies.
- `cordis.patch.yml` — in-package patch (self-mount row for bundle consumers).

## Known limitations (all verified empirically)

- `POST /v2/chat/completions` **does not check User-Agent** — any UA works; but the request must be `stream: true` (non-streaming returns `code 11101`). DSH's pi-ai adapter is streaming by default, so nothing to handle.
- `GET /v3/config` (model discovery) **does check User-Agent** — any non-VSCode-shaped UA gets a 400. The plugin's `fetchRemoteModels` sends its own direct request (bypassing DSH's user-agent attribution override) and explicitly carries a VSCode UA.
- Models are declared as non-reasoning (no reasoning parameters sent), matching the original OpenCode plugin's behavior; the API reports supportsReasoning for every model, so add `compat` on the route if you want it.
- International edition: switch `baseURL` to `https://www.codebuddy.ai/v2` and `X-Domain` to `www.codebuddy.ai`.

## License

MIT

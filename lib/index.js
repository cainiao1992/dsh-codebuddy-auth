/**
 * dsh-codebuddy-auth — CodeBuddy (Tencent IOA) provider lifecycle for the
 * DeepSeek Harness. Host-composition twin of kuops/opencode-codebuddy-auth.
 *
 * The OpenCode plugin's three hooks map onto native DSH seams:
 *   - its `config` hook (provider + model discovery)  -> the `llm-pi-ai`
 *     settings route `providers.codebuddy`, whose models this plugin syncs
 *     from GET /v3/config after login;
 *   - its `auth` storage (auth.json)                  -> `ctx.credentials`
 *     (CODEBUDDY_ACCESS_TOKEN / CODEBUDDY_REFRESH_TOKEN in
 *     ~/.dsh/.credentials.yaml, resolved per request, hot-swapped);
 *   - its `auth` OAuth browser flow + refresh         -> the `codebuddy`
 *     model tool registered here (login / status / refresh / logout /
 *     sync-models), plus a proactive refresh at plugin start.
 *
 * Mount as a host composition row pointing at this file. Requires the
 * `codebuddy` route to exist in the `llm-pi-ai` settings section.
 */
import { exec as nodeExec } from 'node:child_process';
import {
  DEFAULTS,
  requestAuthState,
  pollTokenOnce,
  refreshAccessToken,
  identityHeaders,
  tokenExpiresAt,
  fetchRemoteModels,
  remoteModelToProfile,
  sleep,
} from './codebuddy-core.mjs';

export const name = 'codebuddy-auth';
export const inject = ['tools', 'settings', 'credentials'];

const NS = 'llm-pi-ai';
const ROUTE = ['providers', 'codebuddy'];
const ACCESS_REF = 'CODEBUDDY_ACCESS_TOKEN';
const REFRESH_REF = 'CODEBUDDY_REFRESH_TOKEN';

function openBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? `open "${url}"`
      : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open "${url}"`;
    nodeExec(cmd, () => {});
  } catch {
    // best effort only; the URL is always returned for manual use
  }
}

export function apply(ctx) {
  let live = true;
  ctx.effect(() => () => { live = false; });

  const readCredential = async (ref) => {
    try {
      const hit = await ctx.credentials.resolve(ref);
      return hit ? hit.value : undefined;
    } catch {
      return undefined;
    }
  };

  /** Persist tokens through the credential seam (hot: next request sees them). */
  async function storeTokens(access, refresh) {
    await ctx.credentials.set(ACCESS_REF, access);
    if (refresh) await ctx.credentials.set(REFRESH_REF, refresh);
    else await ctx.credentials.unset(REFRESH_REF).catch(() => {});
  }

  /** Write JWT-derived identity headers + discovered models into the route. */
  async function syncRoute(access, { withModels = true } = {}) {
    const section = ctx.settings.get(NS);
    const route = section && section.providers ? section.providers.codebuddy : undefined;
    if (!route) {
      return 'llm-pi-ai.providers.codebuddy route is missing — add it to ~/.dsh/settings.yaml first (see the package README), then run sync-models';
    }
    const ops = [];
    for (const [key, value] of Object.entries(identityHeaders(access))) {
      ops.push({ op: 'set', path: [...ROUTE, 'headers', key], value });
    }
    let modelNote = 'models untouched';
    if (withModels) {
      try {
        const models = await fetchRemoteModels(access, DEFAULTS);
        if (models.length > 0) {
          ops.push({ op: 'set', path: [...ROUTE, 'models'], value: models.map(remoteModelToProfile) });
          modelNote = `synced ${models.length} models (${models.map((m) => m.id).join(', ')})`;
        }
      } catch (error) {
        modelNote = `model sync failed: ${error.message}`;
      }
    }
    if (ops.length > 0) await ctx.settings.mutate(NS, ops);
    return modelNote;
  }

  async function completeLogin(tokens) {
    const access = tokens.accessToken;
    const refresh = tokens.refreshToken || '';
    await storeTokens(access, refresh);
    const modelNote = await syncRoute(access);
    const expires = tokens.expiresIn
      ? Date.now() + tokens.expiresIn * 1000
      : tokenExpiresAt(access);
    return {
      ok: true,
      expiresAt: expires || undefined,
      identity: identityHeaders(access),
      refreshToken: refresh ? 'stored' : 'none returned by server',
      modelNote,
    };
  }

  async function doRefresh() {
    const refresh = await readCredential(REFRESH_REF);
    if (!refresh) return { ok: false, error: 'no refresh token stored; run action "login" instead' };
    const tokens = await refreshAccessToken(refresh, DEFAULTS);
    if (!tokens || !tokens.accessToken) {
      return { ok: false, error: 'refresh rejected; run action "login" to re-authenticate in a browser' };
    }
    const result = await completeLogin({ ...tokens, refreshToken: tokens.refreshToken || refresh });
    return { ok: true, refreshed: true, ...result };
  }

  ctx.tools.register({
    name: 'codebuddy',
    description:
      'Manage the CodeBuddy (Tencent IOA) model provider: browser OAuth login, token refresh, status, model-list sync, and logout. '
      + 'Use action "login" to start (returns a URL to open), "status" to inspect, "refresh" after expiry, "logout" to clear credentials.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['login', 'status', 'refresh', 'logout', 'sync-models'],
          description: 'login: start browser OAuth and wait; status: credential/route state; refresh: rotate the access token; logout: clear stored credentials; sync-models: re-pull /v3/config into the route.',
        },
        waitSeconds: {
          type: 'integer',
          description: 'How long action "login" waits for the browser flow inside this call (default 90, max 300). If it expires, call login again to keep waiting.',
        },
        openBrowser: {
          type: 'boolean',
          description: 'Try to open the login URL in the desktop browser (default true).',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          authUrl: { type: 'string' },
          state: { type: 'string' },
          pending: { type: 'boolean' },
          error: { type: 'string' },
          result: { type: 'object' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `codebuddy ${value.action}: ${value.ok ? 'ok' : 'failed'}${value.pending ? ' (pending browser login)' : ''}${value.authUrl ? `\nlogin URL: ${value.authUrl}` : ''}${value.error ? `\nerror: ${value.error}` : ''}${value.result ? `\n${JSON.stringify(value.result, null, 2)}` : ''}`,
      }],
    },
    async execute(args, exec) {
      const action = args.action;
      try {
        if (action === 'login') {
          const authState = await requestAuthState(DEFAULTS);
          const waitMs = Math.min(Math.max(args.waitSeconds ?? 90, 5), 300) * 1000;
          if (args.openBrowser !== false) openBrowser(authState.url);
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline && live && !(exec.signal && exec.signal.aborted)) {
            await sleep(3000);
            const hit = await pollTokenOnce(authState.state, DEFAULTS).catch(() => null);
            if (hit) return { action, ok: true, result: await completeLogin(hit) };
          }
          return {
            action,
            ok: true,
            pending: true,
            state: authState.state,
            authUrl: authState.url,
            result: { note: 'waiting for browser login; call login again to continue waiting' },
          };
        }
        if (action === 'status') {
          const accessInfo = await ctx.credentials.describe(ACCESS_REF).catch(() => ({ configured: false }));
          const refreshInfo = await ctx.credentials.describe(REFRESH_REF).catch(() => ({ configured: false }));
          const access = await readCredential(ACCESS_REF);
          const expiresAt = access ? tokenExpiresAt(access) : undefined;
          const section = ctx.settings.get(NS);
          const route = section && section.providers ? section.providers.codebuddy : undefined;
          return {
            action,
            ok: true,
            result: {
              accessConfigured: !!accessInfo.configured,
              refreshConfigured: !!refreshInfo.configured,
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              expired: expiresAt ? expiresAt <= Date.now() : undefined,
              identityHeaders: route && route.headers ? {
                'X-Tenant-Id': route.headers['X-Tenant-Id'],
                'X-Enterprise-Id': route.headers['X-Enterprise-Id'],
                'X-User-Id': route.headers['X-User-Id'],
              } : 'route missing',
              modelCount: route && Array.isArray(route.models) ? route.models.length : 0,
            },
          };
        }
        if (action === 'refresh') return { action, ...(await doRefresh()) };
        if (action === 'logout') {
          await ctx.credentials.unset(ACCESS_REF).catch(() => {});
          await ctx.credentials.unset(REFRESH_REF).catch(() => {});
          return { action, ok: true, result: { note: 'credentials cleared' } };
        }
        if (action === 'sync-models') {
          const access = await readCredential(ACCESS_REF);
          if (!access) return { action, ok: false, error: 'not logged in; run action "login" first' };
          return { action, ok: true, result: { modelNote: await syncRoute(access) } };
        }
        return { action, ok: false, error: `unknown action "${action}"` };
      } catch (error) {
        return { action, ok: false, error: error.message };
      }
    },
  });

  // Startup parity with the OpenCode plugin: keep a usable access token and a
  // fresh model list without waiting for a manual tool call.
  void (async () => {
    await sleep(2000);
    if (!live) return;
    try {
      const access = await readCredential(ACCESS_REF);
      const refresh = await readCredential(REFRESH_REF);
      const expiresAt = access ? tokenExpiresAt(access) : undefined;
      if (refresh && (!access || !expiresAt || expiresAt <= Date.now() + 5 * 60 * 1000)) {
        const out = await doRefresh();
        ctx.logger.info(`codebuddy-auth: startup refresh ${out.ok ? 'succeeded' : `failed: ${out.error}`}`);
        return;
      }
      if (access) {
        const note = await syncRoute(access);
        ctx.logger.info(`codebuddy-auth: startup model sync — ${note}`);
      }
    } catch (error) {
      ctx.logger.warn(`codebuddy-auth: startup pass skipped (${error.message})`);
    }
  })();
}

/**
 * dsh-codebuddy-auth — CodeBuddy (Tencent IOA) as a native DSH llm provider.
 *
 * Architecture (since 0.7.0): this plugin registers a native adapter on
 * `ctx.llm` for the `codebuddy` route — ported from shatyuka/dsh-llm-codebuddy
 * (MIT) — so it owns the chat wire itself: minimal identity headers, the CLI
 * client User-Agent, its own SSE streaming and message serialization. Earlier
 * versions rode the shared llm-pi-ai settings route, whose attribution headers
 * and serialization a plugin cannot control; the legacy route is migrated away
 * on startup.
 *
 * What stays from this package's own design:
 *   - credentials via ctx.credentials (CODEBUDDY_ACCESS_TOKEN / _REFRESH_TOKEN,
 *     resolved per request, hot-swapped, refreshed at startup + every 30 min);
 *   - the `codebuddy` model tool (login / status / refresh / logout /
 *     sync-models);
 *   - editions (China default; `--international` / config `edition: intl`);
 *   - the zero-dependency login CLI (bin/login-flow.mjs).
 */
import { exec as nodeExec } from 'node:child_process';
import {
  EDITIONS,
  cfgForEdition,
  requestAuthState,
  pollTokenOnce,
  refreshAccessToken,
  identityHeaders,
  tokenExpiresAt,
  fetchRemoteModels,
  sleep,
} from './codebuddy-core.mjs';
import { CodebuddyAdapter } from './codebuddy-adapter.mjs';

export const name = 'codebuddy-auth';
export const inject = ['llm', 'tools', 'credentials', 'settings'];

const NS_LEGACY = 'llm-pi-ai';
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

/**
 * Recursively drop `undefined` properties: a tool's canonical value must be
 * lossless JSON, and `undefined` (unlike `null`) does not survive a JSON
 * round-trip. Conditional fields are built with `x: maybe || undefined`
 * everywhere, so every return passes through here on its way out.
 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = prune(entry);
    }
    return out;
  }
  return value;
}

export async function apply(ctx, config = {}) {
  let live = true;
  ctx.effect(() => () => { live = false; });

  // Edition comes from the mount row's config (`edition: intl`), defaulting to
  // the China edition; the CLI's --international flag covers the same choice
  // for headless installs.
  const editionKey = config.edition === 'intl' ? 'intl' : 'cn';
  const edition = () => cfgForEdition(editionKey);

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

  /**
   * Migration: earlier versions created `llm-pi-ai.providers.codebuddy` in
   * settings.yaml. The native adapter owns the route now, and a stale settings
   * route would double-register the provider — remove it once on startup.
   */
  async function migrateAwayFromSettingsRoute() {
    try {
      const section = ctx.settings.get(NS_LEGACY);
      if (section && section.providers && section.providers.codebuddy !== undefined) {
        await ctx.settings.mutate(NS_LEGACY, [{ op: 'unset', path: ['providers', 'codebuddy'] }]);
        ctx.logger.info('codebuddy-auth: removed the legacy llm-pi-ai settings route (the native adapter owns the codebuddy provider now)');
      }
    } catch {
      // settings namespace absent: nothing to migrate
    }
  }

  // ------------------------------------------------------------------
  // The native adapter: it owns the chat wire (identity headers, CLI UA,
  // SSE streaming, message serialization) for the `codebuddy` provider.
  // ------------------------------------------------------------------
  const adapter = new CodebuddyAdapter({
    getAccessToken: () => readCredential(ACCESS_REF),
    connection: () => ({
      chatBaseURL: EDITIONS[editionKey].chatBaseURL,
      domain: EDITIONS[editionKey].domain,
      cliVersion: edition().cliVersion,
    }),
    readCatalog: async () => {
      const access = await readCredential(ACCESS_REF);
      if (access === undefined) throw new Error('not logged in');
      return fetchRemoteModels(access, edition());
    },
    identityFromToken: identityHeaders,
  });

  // CRITICAL ordering: the legacy llm-pi-ai settings route registers a
  // codebuddy adapter itself, and `registerAdapter` throws DUPLICATE_ADAPTER
  // on collision. The unset is awaited BEFORE registering (settings.mutate is
  // async, and this apply runs on the boot fiber). The pi-ai adapter also
  // watches settings and calls `registration.replace()` on change — usually
  // releasing the route right after our unset — but that runs on its own
  // listener, so a brief race remains. Retry a couple of times, then degrade
  // to a warning: a failed mount is worse than an absent registration.
  await migrateAwayFromSettingsRoute();
  let registered = false;
  for (let attempt = 1; attempt <= 3 && !registered; attempt++) {
    try {
      ctx.llm.registerAdapter(['codebuddy'], adapter);
      registered = true;
    } catch (error) {
      if (!error || (error.code !== 'DUPLICATE_ADAPTER' && !/already registered/.test(String(error.message)))) throw error;
      if (attempt === 3) {
        ctx.logger.warn('codebuddy-auth: another adapter still serves the codebuddy provider after cleanup; not registering ours (check for a duplicate plugin mount or a leftover llm-pi-ai settings route)');
      } else {
        await sleep(150);
      }
    }
  }

  async function completeLogin(tokens) {
    const access = tokens.accessToken;
    const refresh = tokens.refreshToken || '';
    await storeTokens(access, refresh);
    adapter.refreshCatalog();
    let modelNote = 'catalog refreshes on next request';
    try {
      const models = await adapter.listModels('codebuddy');
      modelNote = `catalog ready (${models.length} models)`;
    } catch {
      // catalog read is advisory here; login itself succeeded
    }
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
    const tokens = await refreshAccessToken(refresh, edition());
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
          description: 'login: start browser OAuth and wait; status: credential/catalog state; refresh: rotate the access token; logout: clear stored credentials; sync-models: re-pull the /v3/config catalog.',
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
        required: ['action', 'ok'],
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
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
      return prune(await runAction(args, exec));
    },
  });

  const runAction = async (args, exec) => {
      const action = args.action;
      try {
        if (action === 'login') {
          const cfg = edition();
          const authState = await requestAuthState(cfg);
          const waitMs = Math.min(Math.max(args.waitSeconds ?? 90, 5), 300) * 1000;
          if (args.openBrowser !== false) openBrowser(authState.url);
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline && live && !(exec.signal && exec.signal.aborted)) {
            await sleep(3000);
            const hit = await pollTokenOnce(authState.state, cfg).catch(() => null);
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
          let modelCount = 0;
          try {
            modelCount = (await adapter.listModels('codebuddy')).length;
          } catch {
            modelCount = 0;
          }
          return {
            action,
            ok: true,
            result: {
              accessConfigured: !!accessInfo.configured,
              refreshConfigured: !!refreshInfo.configured,
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              expired: expiresAt ? expiresAt <= Date.now() : undefined,
              edition: EDITIONS[editionKey].label,
              identityHeaders: access ? identityHeaders(access) : 'not logged in',
              modelCount,
            },
          };
        }
        if (action === 'refresh') return { action, ...(await doRefresh()) };
        if (action === 'logout') {
          await ctx.credentials.unset(ACCESS_REF).catch(() => {});
          await ctx.credentials.unset(REFRESH_REF).catch(() => {});
          adapter.refreshCatalog();
          return { action, ok: true, result: { note: 'credentials cleared' } };
        }
        if (action === 'sync-models') {
          const access = await readCredential(ACCESS_REF);
          if (!access) return { action, ok: false, error: 'not logged in; run action "login" first' };
          adapter.refreshCatalog();
          const models = await adapter.listModels('codebuddy');
          return { action, ok: true, result: { modelNote: `synced ${models.length} models (${models.map((m) => m.id).join(', ')})` } };
        }
        return { action, ok: false, error: `unknown action "${action}"` };
      } catch (error) {
        return { action, ok: false, error: error.message };
      }
  };

  // Startup pass: migrate the legacy settings route away, then keep a usable
  // access token without waiting for a manual tool call.
  void (async () => {
    if (!live) return;
    try {
      await migrateAwayFromSettingsRoute();
      const access = await readCredential(ACCESS_REF);
      const refresh = await readCredential(REFRESH_REF);
      const expiresAt = access ? tokenExpiresAt(access) : undefined;
      if (refresh && (!access || !expiresAt || expiresAt <= Date.now() + 5 * 60 * 1000)) {
        const out = await doRefresh();
        ctx.logger.info(`codebuddy-auth: startup refresh ${out.ok ? 'succeeded' : `failed: ${out.error}`}`);
        return;
      }
      if (access) {
        adapter.refreshCatalog();
        const count = (await adapter.listModels('codebuddy').catch(() => [])).length;
        ctx.logger.info(`codebuddy-auth: native codebuddy adapter ready (${count} models in catalog)`);
      } else {
        ctx.logger.info('codebuddy-auth: native codebuddy adapter mounted (log in to populate the catalog)');
      }
    } catch (error) {
      ctx.logger.warn(`codebuddy-auth: startup pass skipped (${error.message})`);
    }
  })();

  // Mid-process expiry guard: the access token outlives many sessions but not
  // all. The request path belongs to the adapter (it resolves the credential
  // per request), so the plugin's job is to keep the stored token young: check
  // every 30 minutes and rotate whenever less than an hour of validity remains.
  const EXPIRY_CHECK_MS = 30 * 60 * 1000;
  const EXPIRY_MARGIN_MS = 60 * 60 * 1000;
  let refreshing = false;
  const expiryCheck = async () => {
    if (!live || refreshing) return;
    refreshing = true;
    try {
      const refresh = await readCredential(REFRESH_REF);
      if (!refresh) return;
      const access = await readCredential(ACCESS_REF);
      const expiresAt = access ? tokenExpiresAt(access) : undefined;
      if (!access || !expiresAt || expiresAt <= Date.now() + EXPIRY_MARGIN_MS) {
        const out = await doRefresh();
        if (out.ok) ctx.logger.info('codebuddy-auth: proactive token refresh succeeded');
        else ctx.logger.warn(`codebuddy-auth: proactive refresh failed (${out.error}) — the next request will surface the provider error; ask the agent to run the codebuddy tool (refresh, or login if the refresh token is revoked)`);
      }
    } catch (error) {
      ctx.logger.warn(`codebuddy-auth: expiry check skipped (${error.message})`);
    } finally {
      refreshing = false;
    }
  };
  const timer = typeof ctx.get === 'function' ? ctx.get('timer') : undefined;
  if (timer && typeof timer.interval === 'function') {
    ctx.effect(() => timer.interval(expiryCheck, EXPIRY_CHECK_MS));
  } else {
    const handle = setInterval(expiryCheck, EXPIRY_CHECK_MS);
    if (typeof handle.unref === 'function') handle.unref();
    ctx.effect(() => clearInterval(handle));
  }
}

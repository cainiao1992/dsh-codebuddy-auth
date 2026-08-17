/**
 * Core CodeBuddy (Tencent IOA) OAuth + API helpers, shared by the dsh plugin
 * and the standalone CLI. Ported from kuops/opencode-codebuddy-auth.
 *
 * Plain ESM, no dependencies. Runs in Node >= 18 (native fetch).
 */

export const EDITIONS = {
  cn: {
    label: 'China',
    serverUrl: 'https://copilot.tencent.com',
    domain: 'www.codebuddy.cn',
    chatBaseURL: 'https://copilot.tencent.com/v2',
  },
  intl: {
    label: 'International',
    serverUrl: 'https://www.codebuddy.ai',
    domain: 'www.codebuddy.ai',
    chatBaseURL: 'https://www.codebuddy.ai/v2',
  },
};

/** Which edition a chat baseURL targets: 'intl' when it contains codebuddy.ai, else 'cn'. */
export function editionFromBaseURL(baseURL) {
  if (typeof baseURL === 'string' && baseURL.includes('codebuddy.ai')) return 'intl';
  return 'cn';
}

/**
 * Default (China) edition config: the edition endpoints plus the spoofed
 * client identity every core helper reads. THE single source for the client
 * version strings — buildRouteTemplate derives its headers from here too, so
 * bumping a version is a one-place edit.
 */
export const DEFAULTS = {
  ...EDITIONS.cn,
  platform: 'VSCode',
  appVersion: '4.10.35413651',
  ideName: 'VSCode',
  ideType: 'VSCode',
  ideVersion: '1.133.0',
  agentIntent: 'craft',
  envId: 'production',
  product: 'SaaS',
};

/** The core config for one edition: DEFAULTS with that edition's endpoints.
 *  Callers never hand-build `{ ...DEFAULTS, ...EDITIONS.x }` themselves. */
export function cfgForEdition(editionKey = 'cn') {
  return EDITIONS[editionKey] && editionKey !== 'cn'
    ? { ...DEFAULTS, ...EDITIONS[editionKey] }
    : DEFAULTS;
}

/**
 * Chat-plane headers a CodeBuddy request actually needs: identity only.
 * Mirrors the reference dsh-llm-codebuddy adapter — its chat requests carry
 * just Authorization (from apiKeyEnv) + X-Domain + X-User-Id. The IDE
 * identity block (X-IDE-*, X-Product*, X-Env-ID, X-Agent-Intent) belongs to
 * the /v3/config plane alone (see fetchRemoteModels): sending it on chat
 * requests declares the strictest-moderated IDE "craft agent" identity while
 * the transport's own User-Agent cannot match, an identity no real CodeBuddy
 * client ever produces. X-User-Id (and enterprise/tenant when present) is
 * stamped after login by the plugin's syncRoute.
 */
export const CHAT_IDENTITY_KEYS = ['X-Tenant-Id', 'X-Enterprise-Id', 'X-User-Id'];

/** Chat-plane header keys earlier plugin versions stamped onto the route and
 *  syncRoute now removes (unset) when it finds them on an existing route. */
export const LEGACY_CHAT_HEADERS = [
  'X-Requested-With',
  'X-Agent-Intent',
  'X-IDE-Type',
  'X-IDE-Name',
  'X-IDE-Version',
  'X-Product-Version',
  'X-Env-ID',
  'X-Product',
];

/** The llm-pi-ai provider-route template, built for a given edition ('cn'|'intl').
 *  Shared by the plugin (which creates the default China route on first boot)
 *  and the login CLI (which can pre-create an international route). */
export function buildRouteTemplate(editionKey = 'cn') {
  const edition = EDITIONS[editionKey] || EDITIONS.cn;
  return {
    displayName: 'CodeBuddy',
    api: 'openai-completions',
    baseURL: edition.chatBaseURL,
    apiKeyEnv: 'CODEBUDDY_ACCESS_TOKEN',
    headers: {
      'X-Domain': edition.domain,
    },
    models: [{ id: 'auto', name: 'Auto', contextWindow: 168000 }],
  };
}


const NO_AUTH_HEADERS = {
  Accept: 'application/json',
  'X-No-Authorization': 'true',
  'X-No-User-Id': 'true',
  'X-No-Enterprise-Id': 'true',
  'X-No-Department-Info': 'true',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode a JWT payload without verifying the signature. */
export function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function resolveTenantId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  if (!p) return '';
  const m = (p.iss || '').match(/realms\/sso-([^/]+)$/);
  return p.tenant_id || p.tenantId || (m ? m[1] : '') || '';
}

export function resolveEnterpriseId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  if (!p) return '';
  const roles = (p.realm_access && p.realm_access.roles) ||
    (p.resource_access && p.resource_access.account && p.resource_access.account.roles);
  if (roles) {
    for (const r of roles) {
      const m = r.match(/group-admin:([A-Za-z0-9-]+)/);
      if (m && m[1]) return m[1];
    }
  }
  return p.enterprise_id || p.enterpriseId || p.ent_id || p.entId || '';
}

export function resolveUserId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  return (p && (p.user_id || p.userId || p.uid || p.sub)) || '';
}

export function tokenExpiresAt(accessToken) {
  const p = decodeJwtPayload(accessToken);
  return p && typeof p.exp === 'number' ? p.exp * 1000 : undefined;
}

/** POST /v2/plugin/auth/state — begin the browser OAuth dance. */
export async function requestAuthState(cfg = DEFAULTS) {
  const params = new URLSearchParams({ platform: cfg.platform, ioa: '1' });
  const response = await fetch(`${cfg.serverUrl}/v2/plugin/auth/state?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...NO_AUTH_HEADERS },
  });
  if (!response.ok) throw new Error(`auth state request failed: ${response.status}`);
  const data = await response.json();
  if (data.code !== 0 || !data.data || !data.data.state) {
    throw new Error(`invalid auth state response: ${JSON.stringify(data)}`);
  }
  const url = data.data.authUrl ||
    `${cfg.serverUrl}/login?platform=${cfg.platform}&state=${data.data.state}&ioa=1`;
  return { state: data.data.state, url };
}

/** GET /v2/plugin/auth/token — one poll attempt; null while still pending. */
export async function pollTokenOnce(state, cfg = DEFAULTS) {
  const response = await fetch(`${cfg.serverUrl}/v2/plugin/auth/token?state=${state}`, {
    headers: NO_AUTH_HEADERS,
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (data.code === 0 && data.data && data.data.accessToken) return data.data;
  return null;
}

/**
 * Poll until the token lands or the flow expires.
 * @param {string} state
 * @param {(attempt: number) => void} [onTick] progress callback
 */
export async function pollForToken(state, { timeoutMs = 10 * 60 * 1000, intervalMs = 3000, onTick, cfg = DEFAULTS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    attempt += 1;
    if (onTick) onTick(attempt);
    try {
      const hit = await pollTokenOnce(state, cfg);
      if (hit) return hit;
    } catch {
      // transient network error — keep polling
    }
  }
  return null;
}

/** POST /v2/plugin/auth/token/refresh */
export async function refreshAccessToken(refreshToken, cfg = DEFAULTS) {
  try {
    const response = await fetch(`${cfg.serverUrl}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${refreshToken}`,
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.code !== 0) return null;
    return data.data || null;
  } catch {
    return null;
  }
}

/** Identity headers derivable from the JWT (stable for one account). */
export function identityHeaders(accessToken) {
  const headers = {};
  const tenantId = resolveTenantId(accessToken);
  const enterpriseId = resolveEnterpriseId(accessToken);
  const userId = resolveUserId(accessToken);
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (enterpriseId) headers['X-Enterprise-Id'] = enterpriseId;
  if (userId) headers['X-User-Id'] = userId;
  return headers;
}

/** GET /v3/config — craft-agent model discovery. Requires a CodeBuddy-style
 * User-Agent: the endpoint answers 400 to any other (verified empirically;
 * /v2/chat/completions itself accepts any UA). This is our own direct fetch,
 * so unlike route headers it is not subject to the dsh attribution override. */
export async function fetchRemoteModels(accessToken, cfg = DEFAULTS) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': `${cfg.ideName}/${cfg.ideVersion} CodeBuddy/${cfg.appVersion}`,
    'X-Agent-Intent': cfg.agentIntent,
    'X-IDE-Type': cfg.ideType,
    'X-IDE-Name': cfg.ideName,
    'X-IDE-Version': cfg.ideVersion,
    'X-Product-Version': cfg.appVersion,
    'X-Env-ID': cfg.envId,
    'X-Domain': cfg.domain,
    'X-Product': cfg.product,
    ...identityHeaders(accessToken),
  };
  const resp = await fetch(`${cfg.serverUrl}/v3/config`, { headers });
  if (!resp.ok) throw new Error(`/v3/config answered ${resp.status}`);
  const body = await resp.json();
  if (body.code !== 0 || !body.data) throw new Error(`/v3/config replied code ${body.code}`);
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craft = (body.data.agents || []).find((a) => a.name === cfg.agentIntent);
  const ids = (craft && craft.models) || [];
  if (ids.length === 0) return [];
  return ids.map((id) => modelMap.get(id)).filter((m) => m && m.supportsToolCall);
}

/** Map a CodeBuddy `/v3/config` effort value onto a pi-ai thinking level. */
const CB_EFFORT_TO_LEVEL = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' };

/**
 * Build the `reasoningEfforts` field for one model from its `/v3/config`
 * `reasoning` metadata.
 *
 * Models with `supportedEfforts` expose a real level control: those efforts
 * become the selectable levels, and `canDisableThinking` adds an `off`
 * (disable) level. A model whose metadata carries only a fixed `effort` — no
 * `supportedEfforts`, nothing to switch — is declared non-reasoning
 * *(`false`), which hides the level control entirely: honest, because
 * whatever the control displayed would be cosmetic — the request never
 * carries an effort for such a model, and it keeps using its fixed
 * server-side effort either way. Same for a model with no reasoning metadata
 * at all.
 *
 * The *default* level is deliberately NOT declared here: the selectable set
 * and the request default are separate concerns. DSH's native route-level
 * `reasoning` field (off|minimal|low|medium|high|xhigh|max) sets the request
 * default through the adapter, and when unset, CodeBuddy applies each model's
 * own server-side default (`defaultEffort`). Never filter the selectable
 * levels by a configured default — the default is one of the options, not a
 * replacement for them.
 *
 * CodeBuddy sends reasoning as `reasoning: { effort }` (the pi-ai
 * `openrouter` thinking format), so `compat` pairs every reasoning model with
 * `thinkingFormat: 'openrouter'` + `supportsReasoningEffort: true`.
 */
export function buildReasoningEfforts(m) {
  const r = m && m.reasoning;
  if (!r || !Array.isArray(r.supportedEfforts)) return false;
  const efforts = {};
  for (const e of r.supportedEfforts) {
    const level = CB_EFFORT_TO_LEVEL[e];
    if (level) efforts[level] = e;
  }
  // At least one real level must remain beyond "off" — an off-only control
  // cannot do what it says (off just omits the effort parameter).
  const selectable = Object.keys(efforts).filter((level) => level !== 'off');
  if (selectable.length === 0) return false;
  if (r.canDisableThinking) efforts.off = null;
  return efforts;
}

/** The openai-completions compat switches CodeBuddy needs for reasoning. */
export function codebuddyCompat() {
  return { thinkingFormat: 'openrouter', supportsReasoningEffort: true };
}

/** Map a /v3/config model entry onto an llm-pi-ai model profile. */
export function remoteModelToProfile(m) {
  const entry = {
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.maxInputTokens || 168000,
  };
  if (m.maxOutputTokens) entry.maxTokens = m.maxOutputTokens;
  if (m.supportsImages) entry.input = ['text', 'image'];
  const efforts = buildReasoningEfforts(m);
  if (efforts !== false) {
    entry.reasoningEfforts = efforts;
    entry.compat = codebuddyCompat();
  }
  return entry;
}

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
      'X-Requested-With': 'XMLHttpRequest',
      'X-Agent-Intent': 'craft',
      'X-IDE-Type': 'VSCode',
      'X-IDE-Name': 'VSCode',
      'X-IDE-Version': '1.119.0',
      'X-Product-Version': '4.9.29177644',
      'X-Env-ID': 'production',
      'X-Domain': edition.domain,
      'X-Product': 'SaaS',
    },
    models: [{ id: 'auto', name: 'Auto', contextWindow: 168000 }],
  };
}

/**
 * Default (China) edition config. Kept as a flat object for backward
 * compatibility with existing callers that pass `cfg` (serverUrl/domain/...)
 * into the core helpers.
 */
export const DEFAULTS = {
  ...EDITIONS.cn,
  platform: 'VSCode',
  appVersion: '4.9.29177644',
  ideName: 'VSCode',
  ideType: 'VSCode',
  ideVersion: '1.119.0',
  agentIntent: 'craft',
  envId: 'production',
  product: 'SaaS',
};


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

/** Map a /v3/config model entry onto an llm-pi-ai model profile. */
export function remoteModelToProfile(m) {
  const entry = {
    id: m.id,
    name: m.name || m.id,
    contextWindow: m.maxInputTokens || 168000,
  };
  if (m.maxOutputTokens) entry.maxTokens = m.maxOutputTokens;
  if (m.supportsImages) entry.input = ['text', 'image'];
  return entry;
}

#!/usr/bin/env node
/**
 * CodeBuddy (Tencent IOA) login CLI for dsh-codebuddy-auth — zero npm deps.
 *
 * Runs the same OAuth dance the in-harness `codebuddy` tool uses, for setups
 * where the harness is not running (headless bootstrap, CI token rotation):
 *
 *   1. POST /v2/plugin/auth/state — get a state + login URL
 *   2. open the URL in a browser (or print it with --no-browser)
 *   3. poll GET /v2/plugin/auth/token every 3s until the token lands
 *   4. write CODEBUDDY_ACCESS_TOKEN / CODEBUDDY_REFRESH_TOKEN into
 *      $DSH_HOME/.credentials.yaml (flat YAML, line-level edit, mode 0600)
 *   5. ensure the `llm-pi-ai.providers.codebuddy` route exists in
 *      $DSH_HOME/settings.yaml, targeting the selected edition
 *      (China by default; `--international` pre-creates an international route
 *      so a fresh install can go straight to codebuddy.ai without manual edits)
 *
 * Identity headers and the /v3/config model list are NOT touched here: the
 * mounted plugin syncs both from the stored token (at startup, or via the
 * `codebuddy` tool's login / sync-models actions).
 *
 * Usage:
 *   node bin/login-flow.mjs                 # fresh flow, opens the browser
 *   node bin/login-flow.mjs --no-browser    # fresh flow, prints the URL only
 *   node bin/login-flow.mjs --state FILE    # resume a flow started elsewhere
 *   node bin/login-flow.mjs --international # use the codebuddy.ai (international) endpoints
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EDITIONS,
  cfgForEdition,
  buildRouteTemplate,
  requestAuthState,
  pollForToken,
  tokenExpiresAt,
  decodeJwtPayload,
} from '../lib/codebuddy-core.mjs';

const ACCESS_REF = 'CODEBUDDY_ACCESS_TOKEN';
const REFRESH_REF = 'CODEBUDDY_REFRESH_TOKEN';

function credentialsPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml');
}

/**
 * Rewrite one flat `KEY: "value"` pair in the credentials document without a
 * YAML library: the file is a plain top-level mapping, so line-level surgery
 * with JSON-string quoting (a YAML double-quoted scalar) is exact.
 */
export function upsertCredentialLine(text, key, value) {
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const out = lines.filter((l) => !l.startsWith(`${key}:`));
  out.push(`${key}: ${JSON.stringify(value)}`);
  return `${out.join('\n')}\n`;
}

/** Persist both tokens; returns the path written. */
export function writeCredentials(access, refresh, filePath = credentialsPath()) {
  let text = '';
  if (existsSync(filePath)) text = readFileSync(filePath, 'utf8');
  text = upsertCredentialLine(text, ACCESS_REF, access);
  if (refresh) text = upsertCredentialLine(text, REFRESH_REF, refresh);
  writeFileSync(filePath, text);
  chmodSync(filePath, 0o600);
  return filePath;
}

function settingsPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings.yaml');
}

/** Serialize a plain object/array as indented YAML block lines (scalar/array
 *  of scalars only — enough for the codebuddy route template). */
function yamlLines(value, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        out.push(`${pad}-`);
        out.push(...yamlLines(item, indent + 2));
      } else {
        out.push(`${pad}- ${item}`);
      }
    }
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry === 'object') {
      out.push(`${pad}${key}:`);
      out.push(...yamlLines(entry, indent + 2));
    } else {
      out.push(`${pad}${key}: ${entry}`);
    }
  }
  return out;
}

/** The full codebuddy provider block for a target edition, as YAML lines. */
function codebuddyBlock(editionKey) {
  return yamlLines({ codebuddy: buildRouteTemplate(editionKey) }, 0).map((l) => `    ${l}`);
}

/**
 * Ensure `llm-pi-ai.providers.codebuddy` exists in the settings document and
 * targets the requested edition (default China). Zero-dependency, line-based
 * surgery that only touches the codebuddy route; other keys are left intact.
 * Returns the new document text (or the same text if no change was needed).
 */
export function ensureCodebuddyRoute(fileText, editionKey = 'cn') {
  const lines = (fileText || '').replace(/\n$/, '').split('\n');
  const targetBase = EDITIONS[editionKey] ? EDITIONS[editionKey].chatBaseURL : EDITIONS.cn.chatBaseURL;

  // Locate `llm-pi-ai:` at top level (indent 0) and its `  providers:` (indent 2).
  const llmIdx = lines.findIndex((l) => /^llm-pi-ai:\s*$/.test(l));
  let providersIdx = -1;
  if (llmIdx >= 0) {
    providersIdx = lines.findIndex((l, i) => i > llmIdx && /^  providers:\s*$/.test(l));
  }

  // Case: no `llm-pi-ai:` — append the whole tree (indent 0).
  if (llmIdx < 0) {
    const block = [
      'llm-pi-ai:',
      '  providers:',
      ...codebuddyBlock(editionKey),
    ];
    const base = lines.join('\n');
    return (base ? base + '\n' : '') + block.join('\n') + '\n';
  }

  // Case: `llm-pi-ai:` exists but no `  providers:` — add providers + route.
  if (providersIdx < 0) {
    // Insert before the next top-level key after llm-pi-ai, or at EOF.
    let insertAt = lines.length;
    for (let i = llmIdx + 1; i < lines.length; i++) {
      if (/^[A-Za-z0-9_-]+:\s*$/.test(lines[i])) { insertAt = i; break; }
    }
    lines.splice(insertAt, 0, '  providers:', ...codebuddyBlock(editionKey));
    return lines.join('\n') + '\n';
  }

  // Case: providers exists. Locate `    codebuddy:` (indent 4) under it.
  let cbIdx = -1;
  for (let i = providersIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(l) && !l.startsWith('    ')) break; // next provider
    if (/^    codebuddy:\s*$/.test(l)) { cbIdx = i; break; }
  }

  // Route already exists: point its baseURL at the requested edition and, if
  // present, keep X-Domain consistent with it (the plugin also enforces this
  // on sync, but making the file correct here avoids a transient mismatch).
  if (cbIdx >= 0) {
    const targetDomain = (EDITIONS[editionKey] || EDITIONS.cn).domain;
    let changed = false;
    for (let i = cbIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^    [A-Za-z0-9_-]+:\s*$/.test(l)) break; // next sibling key
      if (/^      baseURL:\s/.test(l)) {
        const newLine = `      baseURL: ${targetBase}`;
        if (l !== newLine) { lines[i] = newLine; changed = true; }
      } else if (/^        X-Domain:\s/.test(l)) {
        const newLine = `        X-Domain: ${targetDomain}`;
        if (l !== newLine) { lines[i] = newLine; changed = true; }
      }
    }
    return changed ? lines.join('\n') + '\n' : fileText;
  }

  // Route missing: insert the codebuddy block at the end of the providers list.
  let insertAt = lines.length;
  for (let i = providersIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(l)) { insertAt = i; break; } // before next provider
    if (/^[A-Za-z0-9_-]+:\s*$/.test(l) && !l.startsWith(' ')) { insertAt = i; break; } // before next top key
  }
  lines.splice(insertAt, 0, ...codebuddyBlock(editionKey));
  return lines.join('\n') + '\n';
}

/** Persist the codebuddy route into settings.yaml for a target edition. */
export function writeCodebuddyRoute(editionKey = 'cn', filePath = settingsPath()) {
  let text = '';
  if (existsSync(filePath)) text = readFileSync(filePath, 'utf8');
  const next = ensureCodebuddyRoute(text, editionKey);
  if (next !== text) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, next);
  }
  return filePath;
}


async function main() {
  const args = process.argv.slice(2);
  const noBrowser = args.includes('--no-browser');
  const international = args.includes('--international');
  const stateIdx = args.indexOf('--state');
  const stateFile = stateIdx >= 0 ? args[stateIdx + 1] : null;

  // Region: China edition (default) vs international (codebuddy.ai). Region
  // values are centralized in EDITIONS; --international just picks that one.
  const cfg = cfgForEdition(international ? 'intl' : 'cn');
  if (international) console.log(`[login] using ${EDITIONS.intl.label} endpoints (${EDITIONS.intl.serverUrl})`);
  else console.log(`[login] using ${EDITIONS.cn.label} edition endpoints (${EDITIONS.cn.serverUrl})`);

  let state;
  if (stateFile && existsSync(stateFile)) {
    state = readFileSync(stateFile, 'utf8').trim();
    console.log(`[login] resuming state ${state}`);
  } else {
    const authState = await requestAuthState(cfg);
    state = authState.state;
    console.log(`[login] login URL: ${authState.url}`);
    if (!noBrowser) {
      try {
        const { exec } = await import('node:child_process');
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start' : 'xdg-open';
        const target = process.platform === 'win32' ? `"${authState.url}"` : authState.url;
        exec(`${cmd} ${target}`, () => {});
        console.log('[login] attempted to open your browser');
      } catch {
        console.log('[login] could not open a browser; open the URL above manually');
      }
    }
  }

  const hit = await pollForToken(state, { timeoutMs: 9 * 60 * 1000, cfg });
  if (!hit) {
    console.error('[login] FAILED: timed out waiting for browser login (state is one-shot; run again)');
    process.exitCode = 2;
    return;
  }

  const access = hit.accessToken;
  const refresh = hit.refreshToken || '';
  const path = writeCredentials(access, refresh);
  const exp = tokenExpiresAt(access);
  const sub = decodeJwtPayload(access);
  console.log(`[login] credentials written to ${path}`);
  console.log(`[login] token expires: ${exp ? new Date(exp).toISOString() : 'unknown (JWT has no exp)'}`);
  console.log(`[login] refresh token: ${refresh ? 'stored' : 'none returned'}`);
  if (sub && (sub.user_id || sub.sub)) {
    console.log(`[login] user id: ${sub.user_id || sub.sub}`);
  }
  const editionKey = international ? 'intl' : 'cn';
  const routePath = writeCodebuddyRoute(editionKey);
  console.log(`[login] ${EDITIONS[editionKey].label} route ensured in ${routePath} (baseURL ${EDITIONS[editionKey].chatBaseURL})`);
  console.log('[login] next: start (or restart) dsh — the plugin syncs identity headers and the model list from this token at startup, or ask the agent to run the codebuddy tool (login / sync-models).');
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await main();

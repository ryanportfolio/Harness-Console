// usage-dash: one local page for Claude Code + Codex usage across accounts.
// Node >= 20, no dependencies. Loopback only. Tokens never leave this machine.

import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TokenScanner } from "./tokens.mjs";
import { Pricing } from "./pricing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const execP = promisify(exec);

// ---------- config ----------

const config = JSON.parse(await readFile(path.join(here, "accounts.json"), "utf8"));
const PORT = config.port ?? 4545;
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
for (const a of config.accounts) a.dir = path.resolve(a.dir.replace(/^~(?=[\\/]|$)/, HOME));
{
  const seen = new Set();
  for (const a of config.accounts) {
    const key = a.name.replace(/[^\w.-]+/g, "_");
    if (seen.has(key)) throw new Error(`accounts.json: account name '${a.name}' collides with another entry after sanitizing; names must be unique`);
    seen.add(key);
  }
}
const STATE_DIR = path.join(here, ".state");
await mkdir(STATE_DIR, { recursive: true });

const CLAUDE_POLL_MS = (config.claudePollSeconds ?? 180) * 1000; // /api/oauth/usage 429s below ~180s
const CODEX_POLL_MS = (config.codexPollSeconds ?? 60) * 1000;
const HTTP_TIMEOUT_MS = 15_000;
const TOKEN_SCAN_MS = (config.tokenScanSeconds ?? 300) * 1000;

// ---------- shared ----------

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, ok: res.ok, headers: res.headers, json, text };
}

function jwtPayload(token) {
  try {
    const part = token.split(".")[1];
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch { return null; }
}

async function writeAtomic(file, content) {
  const tmp = `${file}.usage-dash-tmp.${process.pid}.${Date.now()}`;
  let mode;
  try { mode = (await stat(file)).mode & 0o777; } catch { /* new file */ }
  await writeFile(tmp, content, { encoding: "utf8", mode: mode ?? 0o600 });
  await rename(tmp, file);
}

function retryAfterMs(headers, fallbackMs) {
  const v = headers?.get?.("retry-after");
  if (!v) return fallbackMs;
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : fallbackMs;
}

// ---------- Claude Code ----------

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code's own OAuth client id
const CLAUDE_BETA = "oauth-2025-04-20";
const CLAUDE_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const CLAUDE_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

let claudeUserAgent = "claude-code/2.1.0";
try {
  const { stdout } = await execP("claude --version", { timeout: 8000 }); // shell: claude is a .cmd shim on Windows
  const m = stdout.match(/(\d+\.\d+\.\d+)/);
  if (m) claudeUserAgent = `claude-code/${m[1]}`;
} catch { /* keep fallback */ }

async function claudeReadCreds(dir) {
  const file = path.join(dir, ".credentials.json");
  const root = JSON.parse(await readFile(file, "utf8"));
  const o = root.claudeAiOauth;
  if (!o?.accessToken) throw new Error("no claudeAiOauth.accessToken; run `claude` in this config dir to log in");
  return { file, root, o };
}

// Account identity comes from the token, not from .claude.json (that file goes stale after account switches).
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
async function claudeProfile(state, o) {
  const key = o.accessToken.slice(-16);
  if (state.profileKey === key) return state.profile;
  let r;
  try {
    r = await fetchJson(CLAUDE_PROFILE_URL, {
      headers: { authorization: `Bearer ${o.accessToken}`, accept: "application/json", "anthropic-beta": CLAUDE_BETA, "user-agent": claudeUserAgent },
    });
  } catch { return null; } // optional enrichment: never fail the usage poll
  if (!r.ok) return null; // token changed and lookup failed: no stale email from a previous account
  state.profileKey = key;
  state.profile = { email: r.json?.account?.email ?? null, org: r.json?.organization?.name ?? null };
  return state.profile;
}

function claudeExpired(o) {
  return typeof o.expiresAt === "number" && o.expiresAt <= Date.now() + CLAUDE_EXPIRY_SKEW_MS;
}

async function claudeRefresh(acct, creds) {
  const { o, file, root } = creds;
  const originalAccess = o.accessToken;
  if (!o.refreshToken) throw new Error("token expired and no refreshToken; run `claude` to log in");
  const body = { grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: CLAUDE_CLIENT_ID };
  if (Array.isArray(o.scopes) && o.scopes.length) body.scope = o.scopes.join(" ");
  const r = await fetchJson(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "anthropic-beta": CLAUDE_BETA },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = r.json?.error;
    const terminal = (r.status === 400 || r.status === 401) && String(err).toLowerCase() === "invalid_grant";
    const e = new Error(`token refresh failed (${r.status}): ${r.text.slice(0, 160)}`);
    e.terminal = terminal;
    throw e;
  }
  const j = r.json;
  o.accessToken = j.access_token;
  if (j.refresh_token) o.refreshToken = j.refresh_token;
  o.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
  if (j.scope) o.scopes = j.scope.split(" ");
  // Re-read before writing: if the CLI logged in, switched account, or refreshed meanwhile, keep its version.
  let latest;
  try { latest = JSON.parse(await readFile(file, "utf8")); } catch { latest = null; }
  const cur = latest?.claudeAiOauth;
  if (cur && (cur.refreshToken !== body.refresh_token || cur.accessToken !== originalAccess)) {
    log(`[${acct.name}] credentials changed on disk during refresh; using the CLI's version`);
    return { file, root: latest, o: cur };
  }
  root.claudeAiOauth = o;
  await writeAtomic(file, JSON.stringify(root, null, 2)); // CLI reads this file fresh; same write the CLI does
  log(`[${acct.name}] refreshed Claude OAuth token`);
  return creds;
}

async function claudeFetch(acct, state) {
  if (state.backoffUntil && Date.now() < state.backoffUntil) {
    throw new Error(state.backoffReason);
  }
  let creds = await claudeReadCreds(acct.dir);
  if (claudeExpired(creds.o)) {
    if (state.refreshDeadForToken === creds.o.refreshToken) {
      throw new Error("refresh token rejected (invalid_grant); run `claude` in this config dir to log in again");
    }
    try {
      creds = await claudeRefresh(acct, creds);
    } catch (e) {
      if (e.terminal) state.refreshDeadForToken = creds.o.refreshToken;
      else { state.backoffUntil = Date.now() + CLAUDE_RATE_LIMIT_BACKOFF_MS; state.backoffReason = e.message; }
      throw e;
    }
  }
  const o = creds.o;
  const r = await fetchJson(CLAUDE_USAGE_URL, {
    headers: {
      authorization: `Bearer ${o.accessToken}`,
      accept: "application/json",
      "anthropic-beta": CLAUDE_BETA,
      "user-agent": claudeUserAgent,
    },
  });
  if (r.status === 429) {
    const ms = retryAfterMs(r.headers, CLAUDE_RATE_LIMIT_BACKOFF_MS);
    state.backoffUntil = Date.now() + ms;
    state.backoffReason = `rate limited by usage API; retrying in ${Math.round(ms / 1000)}s`;
    throw new Error(state.backoffReason);
  }
  if (r.status === 401) throw new Error("usage API 401: token invalid; run `claude` in this config dir");
  if (!r.ok) throw new Error(`usage API ${r.status}: ${r.text.slice(0, 160)}`);
  const j = r.json ?? {};
  const win = (w, label) => w && (w.utilization != null || w.resets_at || w.resetsAt)
    ? { label, usedPercent: w.utilization ?? 0, resetsAt: w.resets_at ?? w.resetsAt ?? null }
    : null;
  const windows = [
    win(j.five_hour ?? j.fiveHour, "Session (5h)"),
    win(j.seven_day ?? j.sevenDay, "Weekly"),
    win(j.seven_day_opus ?? j.sevenDayOpus, "Weekly Opus"),
    win(j.seven_day_sonnet ?? j.sevenDaySonnet, "Weekly Sonnet"),
  ].filter(Boolean);
  const extra = j.extra_usage ?? j.extraUsage;
  const notes = [];
  if (extra?.is_enabled ?? extra?.isEnabled) {
    notes.push(`Extra usage: ${extra.used_credits ?? extra.usedCredits ?? 0} / ${extra.monthly_limit ?? extra.monthlyLimit ?? "?"} ${extra.currency ?? ""}`.trim());
  }
  return {
    plan: o.subscriptionType ?? "",
    email: (await claudeProfile(state, o))?.email ?? null,
    tokenExpiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
    windows,
    notes,
    warnings: [],
  };
}

// ---------- Codex ----------

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_UA = "usage-dash";
const CODEX_EXPIRY_WARN_MS = 24 * 60 * 60 * 1000;

const CODEX_PLAN = {
  free: "ChatGPT Free", go: "Codex Go", plus: "ChatGPT Plus", pro: "ChatGPT Pro", pro_lite: "ChatGPT Pro Lite", prolite: "ChatGPT Pro Lite", team: "ChatGPT Team",
  business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", education: "ChatGPT Education",
};

async function codexReadCreds(dir) {
  const file = path.join(dir, "auth.json");
  const root = JSON.parse(await readFile(file, "utf8"));
  if (typeof root.OPENAI_API_KEY === "string" && root.OPENAI_API_KEY.trim()) {
    throw new Error("auth.json holds an API key, not a ChatGPT login; rate-limit windows need `codex login`");
  }
  const t = root.tokens;
  if (!t?.access_token) throw new Error("no tokens.access_token; run `codex login` with CODEX_HOME set to this dir");
  const access = jwtPayload(t.access_token);
  const id = jwtPayload(t.id_token ?? "") ?? {};
  const auth = id["https://api.openai.com/auth"] ?? {};
  return {
    accessToken: t.access_token,
    accountId: t.account_id || auth.chatgpt_account_id || null,
    email: id.email ?? null,
    planType: auth.chatgpt_plan_type ?? null,
    expiresAt: access?.exp ? access.exp * 1000 : null,
    lastRefresh: root.last_refresh ?? null,
  };
}

function codexWindow(w, label) {
  if (!w || typeof w !== "object") return null;
  const used = w.used_percent ?? w.usage_percent;
  const secs = w.limit_window_seconds;
  const reset = w.reset_at;
  if (used == null && secs == null && reset == null) return null; // placeholder
  const mins = secs != null ? Math.round(secs / 60) : null;
  const auto = mins == null ? label : mins >= 7 * 24 * 60 ? "Weekly" : mins >= 60 ? `Session (${Math.round(mins / 60)}h)` : `${mins}m window`;
  return { label: label ?? auto, usedPercent: used ?? 0, resetsAt: reset != null ? new Date(reset * 1000).toISOString() : null, windowMinutes: mins };
}

async function codexFetch(acct, state) {
  if (state.backoffUntil && Date.now() < state.backoffUntil) throw new Error(state.backoffReason);
  const c = await codexReadCreds(acct.dir);
  const warnings = [];
  if (c.expiresAt != null) {
    if (c.expiresAt <= Date.now()) throw new Error(`access token expired ${new Date(c.expiresAt).toISOString()}; run \`codex\` (with CODEX_HOME=${acct.dir}) so the CLI refreshes it`);
    if (c.expiresAt - Date.now() < CODEX_EXPIRY_WARN_MS) warnings.push(`token expires ${new Date(c.expiresAt).toLocaleString()}; run codex to refresh`);
  }
  const headers = { authorization: `Bearer ${c.accessToken}`, accept: "application/json", "user-agent": CODEX_UA };
  if (c.accountId) headers["chatgpt-account-id"] = c.accountId;

  const r = await fetchJson(`${CODEX_BASE_URL}/wham/usage`, { headers });
  if (r.status === 401) throw new Error("usage API 401: token invalid; run `codex login` for this CODEX_HOME");
  if (r.status === 429) {
    const ms = retryAfterMs(r.headers, 5 * 60 * 1000);
    state.backoffUntil = Date.now() + ms;
    state.backoffReason = `rate limited by usage API; retrying in ${Math.round(ms / 1000)}s`;
    throw new Error(state.backoffReason);
  }
  if (!r.ok) throw new Error(`usage API ${r.status}: ${r.text.slice(0, 160)}`);
  const j = r.json ?? {};

  let windows = [];
  if (j.rate_limit) {
    windows = [codexWindow(j.rate_limit.primary_window, null), codexWindow(j.rate_limit.secondary_window, null)].filter(Boolean);
  } else if (Array.isArray(j.rate_limits)) {
    windows = j.rate_limits.map((w) => codexWindow(w, null)).filter(Boolean);
  } else if (j.used_percent != null) {
    windows = [{ label: "Usage", usedPercent: j.used_percent, resetsAt: null }];
  }
  // stable ordering: session first, weekly second
  windows.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));

  const notes = [];
  const credits = j.credits;
  if (credits?.has_credits && !credits.unlimited && credits.balance != null) notes.push(`Credits: $${Number(credits.balance).toFixed(2)}`);

  // banked rate-limit resets (30-day expiry after grant)
  try {
    const rc = await fetchJson(`${CODEX_BASE_URL}/wham/rate-limit-reset-credits`, { headers });
    if (rc.ok && rc.json) {
      const avail = Number(rc.json.available_count ?? 0);
      const list = Array.isArray(rc.json.credits) ? rc.json.credits : [];
      const soonest = list
        .filter((x) => !x.status || String(x.status).toLowerCase() === "available")
        .map((x) => Date.parse(x.expires_at ?? ""))
        .filter((t) => Number.isFinite(t) && t > Date.now())
        .sort((a, b) => a - b)[0];
      if (avail > 0) notes.push(`${avail} banked reset${avail === 1 ? "" : "s"}${soonest ? `, first expires ${new Date(soonest).toLocaleDateString()}` : ""}`);
    }
  } catch { /* optional enrichment */ }

  const planKey = j.plan_type ?? c.planType;
  return {
    plan: planKey ? (CODEX_PLAN[planKey] ?? `ChatGPT ${planKey}`) : "",
    email: c.email,
    tokenExpiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    windows,
    notes,
    warnings,
  };
}

// ---------- poller ----------

const PROVIDERS = { claude: { fetch: claudeFetch, pollMs: CLAUDE_POLL_MS }, codex: { fetch: codexFetch, pollMs: CODEX_POLL_MS } };

const snapshots = new Map(); // name -> { ok, fetchedAt, data | error, dir, kind }
const pollState = new Map();

function stateFile(acct) {
  return path.join(STATE_DIR, `${acct.name.replace(/[^\w.-]+/g, "_")}.json`);
}

async function loadCachedSnapshot(acct) {
  try {
    const s = JSON.parse(await readFile(stateFile(acct), "utf8"));
    if (s?.ok) snapshots.set(acct.name, { ...s, stale: true });
  } catch { /* none */ }
}

async function pollOnce(acct) {
  const p = PROVIDERS[acct.kind];
  const st = pollState.get(acct.name) ?? {};
  pollState.set(acct.name, st);
  try {
    const data = await p.fetch(acct, st);
    const snap = { name: acct.name, kind: acct.kind, dir: acct.dir, ok: true, fetchedAt: new Date().toISOString(), data };
    snapshots.set(acct.name, snap);
    await writeAtomic(stateFile(acct), JSON.stringify(snap));
  } catch (e) {
    const prev = snapshots.get(acct.name);
    snapshots.set(acct.name, {
      name: acct.name, kind: acct.kind, dir: acct.dir, ok: false,
      fetchedAt: new Date().toISOString(),
      error: e?.code === "ENOENT" ? `no credentials at ${acct.dir}; log in there first` : String(e.message ?? e),
      data: prev?.data ?? null, lastGoodAt: prev?.ok ? prev.fetchedAt : prev?.lastGoodAt ?? null,
    });
    log(`[${acct.name}] ${e.message ?? e}`);
  }
}

function schedule(acct) {
  const p = PROVIDERS[acct.kind];
  if (!p) { log(`[${acct.name}] unknown kind '${acct.kind}'`); return; }
  const tick = async () => { await pollOnce(acct); setTimeout(tick, p.pollMs).unref?.(); };
  tick();
}

for (const acct of config.accounts) {
  await loadCachedSnapshot(acct);
  schedule(acct);
}

// ---------- tokens ----------

await mkdir(path.join(STATE_DIR, "tokens"), { recursive: true });
const pricing = new Pricing(path.join(STATE_DIR, "pricing.json"), writeAtomic, log);
await pricing.load();
// One scanner per distinct transcript dir. Accounts that share a dir (logging
// out and back in with another email) cannot be told apart in the transcripts,
// so totals are reported per provider, not per account.
const scanners = new Map();
for (const a of config.accounts) {
  const key = `${a.kind}:${a.dir.toLowerCase()}`;
  if (scanners.has(key)) continue;
  const file = path.join(STATE_DIR, "tokens", `${a.kind}-${a.dir.replace(/[^\w.-]+/g, "_")}.json`);
  scanners.set(key, new TokenScanner({ name: `${a.kind} ${a.dir}`, kind: a.kind, dir: a.dir }, file, writeAtomic, log));
}
for (const s of scanners.values()) await s.load();

async function scanAll() {
  await pricing.refresh();
  for (const s of scanners.values()) await s.scan();
}
(async function tokenTick() {
  try { await scanAll(); } catch (e) { log(`tokens: scan failed: ${e.message ?? e}`); }
  finally { setTimeout(tokenTick, TOKEN_SCAN_MS).unref?.(); }
})();

function tokensPayload(days) {
  return {
    now: new Date().toISOString(),
    pricing: { status: pricing.status, fetchedAt: pricing.fetchedAt ? new Date(pricing.fetchedAt).toISOString() : null },
    providers: ["claude", "codex"].map((kind) => mergeSummaries(kind, [...scanners.values()].filter((s) => s.acct.kind === kind).map((s) => ({ dir: s.acct.dir, ...s.summary(days, pricing) })))),
  };
}

function mergeSummaries(kind, parts) {
  const out = { kind, dirs: parts.map((p) => p.dir), days: parts[0]?.days ?? 0, uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0, reasoning: 0, total: 0, costUsd: 0, unpriced: 0, byModel: {}, series: [], files: 0, lastScanAt: null };
  for (const p of parts) {
    for (const k of ["uncachedIn", "cachedIn", "cacheWrite", "out", "reasoning", "total", "costUsd", "unpriced", "files"]) out[k] += p[k];
    for (const [m, v] of Object.entries(p.byModel)) {
      const b = out.byModel[m] ??= { total: 0, costUsd: 0 };
      b.total += v.total; b.costUsd += v.costUsd;
    }
    p.series.forEach((d, i) => {
      const s = out.series[i] ??= { day: d.day, total: 0, costUsd: 0 };
      s.total += d.total; s.costUsd += d.costUsd;
    });
    if (p.lastScanAt && (!out.lastScanAt || p.lastScanAt > out.lastScanAt)) out.lastScanAt = p.lastScanAt;
  }
  return out;
}

// ---------- http ----------

const indexHtml = await readFile(path.join(here, "index.html"), "utf8");

createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/usage") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ now: new Date().toISOString(), accounts: config.accounts.map((a) => snapshots.get(a.name) ?? { name: a.name, kind: a.kind, ok: false, error: "not fetched yet" }) }));
    return;
  }
  if (url.pathname === "/api/tokens") {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(tokensPayload(days)));
    return;
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    Promise.all([...config.accounts.map(pollOnce), scanAll().catch((e) => log(`tokens: scan failed: ${e.message ?? e}`))]).then(() => { res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => log(`usage-dash on http://127.0.0.1:${PORT}  (${config.accounts.length} accounts, UA ${claudeUserAgent})`));

// usage-dash: one local page for Claude Code + Codex usage across accounts.
// Node >= 20, no dependencies. Loopback only. Accounts come from the local CLIProxyAPI, which holds
// the logins and their tokens; this process never reads a credential or refreshes a token.

import { readFile, writeFile, rename, mkdir, stat, readdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TokenScanner, transcriptDirs } from "./tokens.mjs";
import { Pricing } from "./pricing.mjs";
import { localRequest } from "./guard.mjs";
import { listAuthFiles, upstreamGet, proxyLocation } from "./proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------

const PORT = Number(process.env.USAGE_PORT) || 4545;
const STATE_DIR = process.env.USAGE_STATE_DIR || path.join(here, ".state");
// Before the tracker moved into usage/, its state lived at the repository root. Move it once:
// token records outlive their transcripts, so a rescan cannot rebuild them.
const LEGACY_STATE = path.join(here, "..", ".state");
if (!process.env.USAGE_STATE_DIR && !(await stat(STATE_DIR).catch(() => null)) && (await stat(path.join(LEGACY_STATE, "tokens")).catch(() => null))) {
  await rename(LEGACY_STATE, STATE_DIR).catch((e) => console.error(`could not move ${LEGACY_STATE} to ${STATE_DIR}: ${e.message}`));
}
await mkdir(STATE_DIR, { recursive: true });

const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000; // /api/oauth/usage 429s on fast polling
const TOKEN_SCAN_MS = 300 * 1000;
// The sign-in watch posts /api/refresh every 5 s; a healthy login is re-fetched at most this often.
const REFETCH_HEALTHY_MS = 60 * 1000;

// ---------- shared ----------

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function writeAtomic(file, content) {
  const tmp = `${file}.usage-dash-tmp.${process.pid}.${Date.now()}`;
  let mode;
  try { mode = (await stat(file)).mode & 0o777; } catch { /* new file */ }
  await writeFile(tmp, content, { encoding: "utf8", mode: mode ?? 0o600 });
  await rename(tmp, file);
}

// Upstream headers arrive through the proxy as a plain object, values possibly arrays.
function retryAfterMs(headers, fallbackMs) {
  const k = Object.keys(headers ?? {}).find((h) => h.toLowerCase() === "retry-after");
  const v = k ? [headers[k]].flat()[0] : null;
  if (!v) return fallbackMs;
  const n = Number(v);
  if (Number.isFinite(n)) return n * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : fallbackMs;
}

// One usage call through the proxy with the shared error handling: 429 parks the account.
async function usageBody(file, state) {
  if (state.backoffUntil && Date.now() < state.backoffUntil) throw new Error(state.backoffReason);
  const r = await upstreamGet(file.auth_index, file.provider, "usage");
  if (r.status === 429) {
    const ms = retryAfterMs(r.headers, RATE_LIMIT_BACKOFF_MS);
    state.backoffUntil = Date.now() + ms;
    state.backoffReason = `rate limited by usage API; retrying in ${Math.round(ms / 1000)}s`;
    throw new Error(state.backoffReason);
  }
  if (r.status === 401) throw new Error("usage API 401: the proxy's token for this login was rejected; sign in again in the proxy panel");
  if (!r.ok) throw new Error(`usage API ${r.status}: ${r.text.slice(0, 160)}`);
  return r.json ?? {};
}

// ---------- Claude Code ----------

function claudeWindows(j) {
  const win = (w, label) => w && (w.utilization != null || w.resets_at || w.resetsAt)
    ? { label, usedPercent: w.utilization ?? 0, resetsAt: w.resets_at ?? w.resetsAt ?? null }
    : null;
  const windows = [
    win(j.five_hour ?? j.fiveHour, "Session (5h)"),
    win(j.seven_day ?? j.sevenDay, "Weekly"),
    win(j.seven_day_opus ?? j.sevenDayOpus, "Weekly Opus"),
    win(j.seven_day_sonnet ?? j.sevenDaySonnet, "Weekly Sonnet"),
  ].filter(Boolean);
  // Model-scoped caps (Fable today) arrive only in `limits[]` as weekly_scoped rows; the legacy
  // seven_day_<model> keys stay null for them.
  for (const l of Array.isArray(j.limits) ? j.limits : []) {
    const name = l?.scope?.model?.display_name ?? l?.scope?.surface?.display_name ?? l?.scope?.surface;
    if (!name || typeof name !== "string" || l.percent == null) continue;
    const label = `${l.group === "session" ? "Session" : "Weekly"} ${name}`;
    if (windows.some((w) => w.label === label)) continue;
    windows.push({ label, usedPercent: l.percent, resetsAt: l.resets_at ?? null, severity: l.severity ?? null });
  }
  const extra = j.extra_usage ?? j.extraUsage;
  const notes = [];
  if (extra?.is_enabled ?? extra?.isEnabled) {
    notes.push(`Extra usage: ${extra.used_credits ?? extra.usedCredits ?? 0} / ${extra.monthly_limit ?? extra.monthlyLimit ?? "?"} ${extra.currency ?? ""}`.trim());
  }
  return { windows, notes, warnings: [] };
}

const CLAUDE_PLAN = { claude_max: "Claude Max", claude_pro: "Claude Pro", claude_team: "Claude Team", claude_enterprise: "Claude Enterprise" };

// The plan never changes under one login, so the profile is fetched once per login per process.
const claudePlans = new Map(); // auth_index -> plan
async function claudePlan(file) {
  if (claudePlans.has(file.auth_index)) return claudePlans.get(file.auth_index);
  let r;
  try { r = await upstreamGet(file.auth_index, "claude", "profile"); } catch { return ""; } // optional enrichment
  if (!r.ok || !r.json) return "";
  const org = r.json.organization ?? {}, acct = r.json.account ?? {};
  const type = org.organization_type ?? "";
  const base = CLAUDE_PLAN[type] ?? (acct.has_claude_max ? "Claude Max" : acct.has_claude_pro ? "Claude Pro" : type);
  const mult = /_(\d+x)$/.exec(org.rate_limit_tier ?? "")?.[1]; // default_claude_max_20x
  const plan = base && mult ? `${base} ${mult}` : base;
  claudePlans.set(file.auth_index, plan);
  return plan;
}

async function claudeFetch(file, state) {
  const j = await usageBody(file, state);
  return { plan: await claudePlan(file), data: claudeWindows(j) };
}

// ---------- Codex ----------

const CODEX_PLAN = {
  free: "ChatGPT Free", go: "Codex Go", plus: "ChatGPT Plus", pro: "ChatGPT Pro", pro_lite: "ChatGPT Pro Lite", prolite: "ChatGPT Pro Lite", team: "ChatGPT Team",
  business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", education: "ChatGPT Education", promax: "ChatGPT Pro Max",
};
const codexPlan = (key) => (key ? (CODEX_PLAN[key] ?? `ChatGPT ${key}`) : "");

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

function codexWindows(j) {
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
  // `balance` is a credit count (a decimal string such as "62500.0000000000"), not money: the body has no currency field.
  if (credits?.has_credits && !credits.unlimited && credits.balance != null) notes.push(`Credits: ${Number(credits.balance).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  // banked rate-limit resets
  const avail = Number(j.rate_limit_reset_credits?.available_count ?? 0);
  if (avail > 0) notes.push(`${avail} banked reset${avail === 1 ? "" : "s"}`);
  return { windows, notes, warnings: [] };
}

async function codexFetch(file, state) {
  const j = await usageBody(file, state);
  return { plan: codexPlan(file.id_token?.plan_type ?? j.plan_type), data: codexWindows(j) };
}

// ---------- poller ----------

const FETCH = { claude: claudeFetch, codex: codexFetch };
const CACHE_FILE = path.join(STATE_DIR, "usage-cache.json");

// Earlier versions kept one snapshot file per configured account name (Claude_1.json) and could
// leave temp files behind; this version keeps one cache file.
for (const name of await readdir(STATE_DIR)) {
  const file = path.join(STATE_DIR, name);
  if (name.includes(".usage-dash-tmp.")) { await unlink(file).catch(() => {}); continue; }
  if (!name.endsWith(".json") || name === "usage-cache.json" || name === "pricing.json") continue;
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    if (j && typeof j === "object" && "name" in j && "kind" in j && "dir" in j) { await unlink(file); log(`removed legacy snapshot ${name}`); }
  } catch { /* not ours */ }
}

const accounts = new Map(); // id -> public account entry (see /api/usage)
const pollState = new Map(); // id -> { backoffUntil, backoffReason }
let proxy = { ok: false, ...(await proxyLocation()), error: "not checked yet", checkedAt: null };

// Last good data per account survives restarts and proxy outages.
try {
  const c = JSON.parse(await readFile(CACHE_FILE, "utf8"));
  for (const a of Object.values(c.accounts ?? {})) {
    if (a?.id && a.data) accounts.set(a.id, { ...a, ok: false, stale: true, fetchedAt: null, error: null });
  }
} catch { /* none */ }

async function saveCache() {
  const out = {};
  for (const a of accounts.values()) if (a.data) out[a.id] = a;
  await writeAtomic(CACHE_FILE, JSON.stringify({ version: 1, accounts: out }));
}

function accountId(f) {
  return `${f.provider}:${String(f.email || f.label || f.name || f.auth_index).toLowerCase()}`;
}

async function pollAccount(f, entry) {
  const prev = accounts.get(entry.id);
  if (entry.disabled) {
    return { ...entry, ok: false, stale: !!prev?.data, fetchedAt: prev?.fetchedAt ?? null, lastGoodAt: prev?.lastGoodAt ?? null, error: null, data: prev?.data ?? null };
  }
  // Fetched fine moments ago and the proxy does not flag it: keep those numbers, refresh the listing fields.
  if (prev?.ok && !entry.proxyMessage && !entry.unavailable && prev.fetchedAt && Date.now() - Date.parse(prev.fetchedAt) < REFETCH_HEALTHY_MS) {
    return { ...prev, ...entry, plan: entry.plan || prev.plan || "" };
  }
  const st = pollState.get(entry.id) ?? {};
  pollState.set(entry.id, st);
  const now = new Date().toISOString();
  try {
    const { plan, data } = await FETCH[f.provider](f, st);
    return { ...entry, plan: plan || prev?.plan || "", ok: true, stale: false, fetchedAt: now, lastGoodAt: now, error: null, data };
  } catch (e) {
    log(`[${entry.id}] ${e.message ?? e}`);
    return { ...entry, plan: entry.plan || prev?.plan || "", ok: false, stale: !!prev?.data, fetchedAt: now, lastGoodAt: prev?.lastGoodAt ?? null, error: String(e.message ?? e), data: prev?.data ?? null };
  }
}

async function poll() {
  const checkedAt = new Date().toISOString();
  const loc = await proxyLocation();
  let files;
  try {
    files = (await listAuthFiles()).filter((f) => FETCH[f.provider]);
  } catch (e) {
    const error = String(e.message ?? e);
    proxy = { ok: false, ...loc, error, checkedAt };
    for (const a of accounts.values()) accounts.set(a.id, { ...a, ok: false, stale: true, error });
    log(`proxy: ${error}`);
    return;
  }
  const count = new Map();
  for (const f of files) count.set(accountId(f), (count.get(accountId(f)) ?? 0) + 1);
  const next = await Promise.all(files.map((f) => {
    const base = accountId(f), duplicate = count.get(base) > 1;
    const entry = {
      id: duplicate ? `${base}#${f.auth_index}` : base,
      kind: f.provider,
      email: f.email || null,
      label: f.label || null,
      plan: f.provider === "codex" ? codexPlan(f.id_token?.plan_type) : (claudePlans.get(f.auth_index) ?? ""),
      disabled: !!f.disabled,
      duplicate,
      proxyStatus: f.status ?? null,
      proxyMessage: f.status_message || null,
      unavailable: !!f.unavailable,
    };
    return pollAccount(f, entry);
  }));
  // A login the proxy no longer lists is gone, from the page and from the cache. The proxy status and
  // the accounts from this check are published together, so /api/usage never pairs a checked proxy
  // with an account list that check has not filled yet; until then the previous accounts stay visible.
  accounts.clear();
  for (const a of next) accounts.set(a.id, a);
  proxy = { ok: true, ...loc, error: null, checkedAt };
  for (const id of pollState.keys()) if (!accounts.has(id)) pollState.delete(id);
  await saveCache().catch((e) => log(`cache: ${e.message}`));
}

// Concurrent refreshes share one poll.
let polling = null;
function pollAll() {
  polling ??= poll().catch((e) => log(`poll failed: ${e.message ?? e}`)).finally(() => { polling = null; });
  return polling;
}

function usagePayload() {
  const order = { claude: 0, codex: 1 };
  const list = [...accounts.values()].sort((a, b) => order[a.kind] - order[b.kind] || String(a.email ?? "").toLowerCase().localeCompare(String(b.email ?? "").toLowerCase()) || a.id.localeCompare(b.id));
  return { now: new Date().toISOString(), proxy, accounts: list };
}

pollAll();

// ---------- tokens ----------

await mkdir(path.join(STATE_DIR, "tokens"), { recursive: true });
const pricing = new Pricing(path.join(STATE_DIR, "pricing.json"), writeAtomic, log);
await pricing.load();
// One scanner per transcript dir. Accounts that share a dir (logging out and back in with another
// email) cannot be told apart in the transcripts, so totals are reported per provider, not per account.
const scanners = [];
for (const { kind, dir } of await transcriptDirs()) {
  const file = path.join(STATE_DIR, "tokens", `${kind}-${dir.replace(/[^\w.-]+/g, "_")}.json`);
  scanners.push(new TokenScanner({ name: `${kind} ${dir}`, kind, dir }, file, writeAtomic, log));
}
for (const s of scanners) await s.load();

async function scanAll() {
  await pricing.refresh();
  for (const s of scanners) await s.scan();
}
// One scan at a time: the timer and refreshes join a running scan instead of starting another.
// A cold scan of a large transcript history takes minutes.
let scanning = null;
function scanTokens() {
  scanning ??= scanAll().catch((e) => log(`tokens: scan failed: ${e.message ?? e}`)).finally(() => { scanning = null; });
  return scanning;
}
(async function tokenTick() {
  await scanTokens();
  setTimeout(tokenTick, TOKEN_SCAN_MS).unref?.();
})();

function tokensPayload(days) {
  return {
    now: new Date().toISOString(),
    scanning: !!scanning,
    pricing: { status: pricing.status, fetchedAt: pricing.fetchedAt ? new Date(pricing.fetchedAt).toISOString() : null },
    providers: ["claude", "codex"].map((kind) => mergeSummaries(kind, scanners.filter((s) => s.acct.kind === kind).map((s) => ({ dir: s.acct.dir, ...s.summary(days, pricing) })))),
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
const cardsJs = await readFile(path.join(here, "cards.mjs"), "utf8");

createServer((req, res) => {
  // Only loopback pages (the Harness Console on any port) may frame the tracker.
  res.setHeader("content-security-policy", "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*");
  if (!localRequest(req, PORT)) { res.writeHead(403, { "content-type": "text/plain" }); res.end("local access only"); return; }
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/usage") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(usagePayload()));
    return;
  }
  if (url.pathname === "/api/tokens") {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(tokensPayload(days)));
    return;
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    // Answers once the accounts are polled; the token scan goes on in the background.
    scanTokens();
    pollAll().then(() => { res.writeHead(204); res.end(); });
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(indexHtml);
    return;
  }
  if (url.pathname === "/cards.mjs" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(cardsJs);
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => log(`usage-dash on http://127.0.0.1:${PORT}  (accounts from CLIProxyAPI at ${proxy.url})`));

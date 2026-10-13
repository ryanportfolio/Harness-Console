// Every number the README shows, read from the source that defines it.
// A regex that stops matching throws, so a renamed constant fails the build
// instead of leaving a stale figure in the art.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function num(text, re, label) {
  const m = text.match(re);
  if (!m) throw new Error(`facts: ${label} not found`);
  return Number(m[1]);
}
function str(text, re, label) {
  const m = text.match(re);
  if (!m) throw new Error(`facts: ${label} not found`);
  return m[1];
}
function must(text, re, label) {
  if (!re.test(text)) throw new Error(`facts: ${label}`);
}

export function collectFacts() {
  const server = read("usage/server.mjs");
  const proxySrc = read("usage/proxy.mjs");
  const cards = read("usage/cards.mjs");
  const tokens = read("usage/tokens.mjs");
  const pricing = read("usage/pricing.mjs");
  const page = read("usage/index.html");

  // Polling: no timer. The server polls once at startup and on POST /api/refresh, which the page
  // sends on load, on "Refresh now" and every few seconds while it watches for a sign-in.
  must(server, /^pollAll\(\);$/m, "usage/server.mjs no longer polls once at startup");
  must(server, /"\/api\/refresh" && req\.method === "POST"[\s\S]{0,200}pollAll\(\)/, "usage/server.mjs /api/refresh no longer polls");
  if (/set(?:Timeout|Interval)\([^)]*poll/i.test(server)) throw new Error("facts: usage/server.mjs polls on a timer again; the README says it does not");
  must(page, /load\(\)\.then\(\(\) => fetch\("\/api\/refresh"/, "usage/index.html no longer refreshes on page load");
  must(server, /polling \?\?= poll\(\)/, "usage/server.mjs no longer shares one poll between concurrent refreshes");
  must(server, /scanning \?\?= scanAll\(\)/, "usage/server.mjs no longer runs one token scan at a time");
  must(server, /scanTokens\(\);\s*\n\s*pollAll\(\)\.then/, "usage/server.mjs /api/refresh no longer starts a scan without waiting for it");
  const refetchHealthySeconds = num(server, /REFETCH_HEALTHY_MS = (\d+) \* 1000/, "REFETCH_HEALTHY_MS");
  const backoffMinutes = num(server, /RATE_LIMIT_BACKOFF_MS = (\d+) \* 60 \* 1000/, "RATE_LIMIT_BACKOFF_MS");
  const tokenScanSeconds = num(server, /TOKEN_SCAN_MS = (\d+) \* 1000/, "TOKEN_SCAN_MS");
  const port = num(server, /const PORT = Number\(process\.env\.USAGE_PORT\) \|\| (\d+)/, "port");
  const cacheFile = str(server, /CACHE_FILE = path\.join\(STATE_DIR, "([^"]+)"\)/, "cache file name");
  must(server, /process\.env\.USAGE_STATE_DIR/, "USAGE_STATE_DIR override missing from usage/server.mjs");
  const retentionDays = num(tokens, /RETENTION_MS = (\d+) \* 24 \* 3600 \* 1000/, "RETENTION_MS");
  must(tokens, /\["claude", "CLAUDE_CONFIG_DIR", "\.claude"\], \["codex", "CODEX_HOME", "\.codex"\]/, "transcript dirs in usage/tokens.mjs changed");
  must(tokens, /\^\\\\\$\{base\}-\\\\d\+\$/, "numbered transcript dirs (~/.claude-<n>) no longer scanned");

  // The page: refresh cadence, sign-in watch, bar thresholds.
  const pageFetchSeconds = num(page, /setInterval\(load, (\d+)_000\)/, "page fetch interval");
  const countdownSeconds = num(page, /setInterval\(render, (\d+)_000\)/, "countdown interval");
  const watchIntervalSeconds = num(page, /watchForLogin\(\{[^}]*intervalMs: (\d+)/, "sign-in watch interval") / 1000;
  const watchTimeoutMinutes = num(page, /watchForLogin\(\{[^}]*timeoutMs: (\d+)/, "sign-in watch timeout") / 60000;
  if (!Number.isInteger(watchIntervalSeconds) || !Number.isInteger(watchTimeoutMinutes)) throw new Error("facts: sign-in watch timing is not whole seconds and minutes");
  const [, badAt, warnAt] = (cards.match(/p >= (\d+) \? "bad" : p >= (\d+) \? "warn"/) ?? []).map(Number);
  if (!warnAt || !badAt) throw new Error("facts: warn/bad thresholds not found in usage/cards.mjs");
  // The bar colours the page draws (:root custom properties); the masthead legend uses these exact values.
  const barColors = Object.fromEntries(["ok", "warn", "bad", "track"].map((k) => [k, str(page, new RegExp(`--${k}: (#[0-9a-f]{6});`), `--${k} colour in usage/index.html`)]));
  must(page, /\.bar > i \{[^}]*background: var\(--ok\)[\s\S]{0,80}\.bar\.warn > i \{ background: var\(--warn\); \} \.bar\.bad > i \{ background: var\(--bad\); \}/, "usage/index.html bars no longer use --ok, --warn and --bad");
  must(cards, /return p >= \d+ \? "bad" : p >= \d+ \? "warn" : "";/, "usage/cards.mjs bars under the warn threshold no longer use the default (--ok) colour");
  // README names the colours in words; a new hex needs a new name here.
  const COLOR_NAMES = { "#ba9d6a": "tan", "#8f774b": "brown", "#1e211e": "near-black" };
  const barColorNames = Object.fromEntries(["ok", "warn", "bad"].map((k) => {
    const name = COLOR_NAMES[barColors[k]];
    if (!name) throw new Error(`facts: no README colour name for --${k} ${barColors[k]} in usage/index.html`);
    return [k, name];
  }));
  // Status order the README states: disabled, stale ("As of"), proxy unreachable, rate limited, sign-in needed, live.
  must(cards, /statusText: a\.disabled \? "Disabled in proxy" : stale \? `As of [^`]*` : !proxy\.ok \? "Proxy unreachable" : rateLimited \? "Rate limited" : broken \? "Sign-in needed" : !a\.ok \? "Fetch failed" : "Live"/, "usage/cards.mjs status order changed");
  // Sign-in is for a rejected credential only: a usage API 401 or 403, a token the proxy cannot produce,
  // or the proxy's auth-failure markers. Cooldown and upstream-error flags are not.
  must(cards, /const broken = !a\.disabled && signInNeeded\(a\);/, "usage/cards.mjs offers sign-in on different conditions now");
  must(cards, /const AUTH_MARKER = \/\^\(unauthorized\|payment_required\|invalid\[_ \]grant\|token expired\)\\b\/i;/, "usage/cards.mjs auth-failure markers changed");
  must(cards, /const COOLDOWN_MARKER = \/\^\(quota exhausted\|quota\|transient upstream error\|/, "usage/cards.mjs cooldown markers changed");
  // The README lists every rule of signInNeeded, in this order, with these word lists.
  must(cards, /const AUTH_REASONS = \["unauthorized", "payment_required", "invalid_grant"\];/, "usage/cards.mjs auth-failure cooldown reasons changed");
  must(cards, /const AUTH_TEXT = \/\\b40\[13\]\\b\|unauthori\[sz\]ed\|authenticat\|permission\|forbidden\|invalid\[_ \]grant\|revoked\|expired\/i;/, "usage/cards.mjs auth words in a raw proxy message changed");
  must(cards, /export function signInNeeded\(a\) \{\s*if \(!a\) return false;\s*if \(a\.authRejected\) return true;\s*const msg = String\(a\.proxyMessage \?\? ""\)\.trim\(\);\s*const cooldowns = a\.proxyCooldowns \?\? \[\];\s*if \(AUTH_MARKER\.test\(msg\) \|\| cooldowns\.some\(\(c\) => AUTH_REASONS\.includes\(c\.reason\) \|\| c\.httpStatus === 401 \|\| c\.httpStatus === 403\)\) return true;\s*if \(cooldowns\.length \|\| COOLDOWN_MARKER\.test\(msg\)\) return false;\s*if \(msg\) return AUTH_TEXT\.test\(msg\);\s*\/\/[^\n]*\n\s*return !!a\.unavailable && !a\.proxyRetryAt;\s*\}/, "usage/cards.mjs signInNeeded rules changed");
  must(cards, /export const healthy = \(a\) => !!a\?\.ok && !signInNeeded\(a\);/, "usage/cards.mjs sign-in watch success test changed");
  must(server, /if \(r\.status === 401 \|\| r\.status === 403\) throw Object\.assign\([^\n]*\{ authRejected: true \}\);/, "usage/server.mjs no longer reads a usage API 401 or 403 as a rejected credential");
  must(server, /if \(\/api-call HTTP 400: auth token\/\.test\(e\.message\)\) e\.authRejected = true;/, "usage/server.mjs no longer reads a missing proxy token as a rejected credential");
  // "Proxy unreachable" covers every failure to list the logins.
  must(server, /files = \(await listAuthFiles\(\)\)\.filter\(\(f\) => FETCH\[f\.provider\]\);\s*\} catch \(e\) \{\s*const error = String\(e\.message \?\? e\);\s*proxy = \{ ok: false,/, "usage/server.mjs no longer marks the proxy down on any listing failure");
  must(proxySrc, /if \(!Array\.isArray\(j\?\.files\)\) throw new Error/, "usage/proxy.mjs no longer rejects a malformed login list");
  must(proxySrc, /if \(!key\) throw new Error/, "usage/proxy.mjs no longer fails without a management key");
  // Codex calls name the login's ChatGPT account.
  must(proxySrc, /if \(provider === "codex" && accountId\) header\["chatgpt-account-id"\] = String\(accountId\);/, "usage/proxy.mjs no longer sends chatgpt-account-id on Codex calls");
  must(server, /usageBody\(file, state, file\.id_token\?\.chatgpt_account_id\)/, "usage/server.mjs no longer takes the Codex account id from id_token");
  must(cards, /const rateLimited = !a\.ok && !!a\.rateLimited;/, "usage/cards.mjs no longer reads the server's rate-limit flag");
  must(cards, /panelUrl && !rateLimited \?/, "usage/cards.mjs offers sign-in to a rate-limited login now");
  must(cards, /dim: stale \|\| !!a\.disabled \|\| \(!proxy\.ok && !d\)/, "usage/cards.mjs greys different rows now");
  // The refetch skip conditions the README lists.
  must(server, /if \(prev\?\.ok && !signInNeeded\(entry\) && prev\.fetchedAt && Date\.now\(\) - Date\.parse\(prev\.fetchedAt\) < REFETCH_HEALTHY_MS\)/, "usage/server.mjs skips a refetch on different conditions now");
  // Token caches of a transcript folder that is gone still count.
  must(server, /const owner = await cacheOwner\(file\);[^\n]*\n[^\n]*\n\s*addScanner\(owner\.kind, owner\.dir, file\);/, "usage/server.mjs no longer counts saved token records of a deleted folder");
  // Retry claims: a failed profile fetch is not cached; a failed price fetch leaves fetchedAt alone.
  must(server, /catch \{ return ""; \}[^\n]*\n\s*if \(!r\.ok \|\| !r\.json\) return "";[\s\S]{0,400}claudePlans\.set\(/, "usage/server.mjs caches a failed Claude profile fetch now");
  must(pricing, /if \(!force && Date\.now\(\) - this\.fetchedAt < TTL_MS\) return;/, "usage/pricing.mjs TTL check changed");
  must(server, /async function scanAll\(\) \{\s*await pricing\.refresh\(\);/, "usage/server.mjs no longer refreshes prices on every scan");
  const summaryFullAt = num(cards, /claude\.find\(\(r\) => r\.pct >= (\d+)\)/, "summary weekly threshold");
  const pricingTtlHours =num(pricing, /TTL_MS = (\d+) \* 3600 \* 1000/, "pricing TTL");
  const priceAlias = pricing.match(/DEFAULT_ALIASES = \{ "([^"]+)": "([^"]+)"/);
  if (!priceAlias) throw new Error("facts: DEFAULT_ALIASES not found in usage/pricing.mjs");

  const claudeWindows = [...server.matchAll(/win\(j\.\w+ \?\? j\.\w+, "([^"]+)"\)/g)].map((m) => m[1]);
  if (claudeWindows.length !== 4) throw new Error(`facts: expected 4 Claude windows, found ${claudeWindows.length}`);
  must(server, /Array\.isArray\(j\.limits\)/, "usage/server.mjs no longer reads model-scoped limits[]");

  // The proxy: where it is found, how it is asked.
  const proxy = {
    dirEnv: str(proxySrc, /process\.env\.(USAGE_PROXY_DIR)/, "USAGE_PROXY_DIR"),
    dirName: str(proxySrc, /"AppData", "Local"\), "([^"]+)"\)/, "proxy folder name"),
    host: str(proxySrc, /DEFAULT_HOST = "([^"]+)"/, "proxy default host"),
    port: num(proxySrc, /DEFAULT_PORT = (\d+)/, "proxy default port"),
    configFile: str(proxySrc, /path\.join\(PROXY_DIR, "([^"]+\.yaml)"\)/, "proxy config file"),
    keyFile: str(proxySrc, /path\.join\(PROXY_DIR, "([^"]+\.txt)"\)/, "proxy key file"),
    panelPath: str(proxySrc, /panelUrl: `\$\{url\}([^`]+)`/, "proxy panel path"),
    tokenPlaceholder: str(proxySrc, /Authorization: "Bearer (\$TOKEN\$)"/, "token placeholder"),
  };
  must(proxySrc, /process\.env\.LOCALAPPDATA/, "usage/proxy.mjs no longer looks under LOCALAPPDATA");
  const routes = [...proxySrc.matchAll(/management\(conn, "([\w-]+)"(, \{ method: "(\w+)")?/g)].map((m) => ({ route: m[1], method: m[3] ?? "GET" }));
  if (routes.length !== 2) throw new Error(`facts: expected 2 proxy management calls, found ${routes.length}`);
  must(proxySrc, /JSON\.stringify\(\{ authIndex: String\(authIndex\), method: "GET", url, header \}\)/, "usage/proxy.mjs upstream calls are no longer GET");

  // The only upstream URLs: a fixed table in usage/proxy.mjs, plus LiteLLM's price table.
  const table = str(proxySrc, /const UPSTREAM = \{([\s\S]*?)\n\};/, "UPSTREAM table in usage/proxy.mjs");
  const upstream = [...table.matchAll(/(\w+): \{([^}]*)\}/g)].flatMap((p) => [...p[2].matchAll(/(\w+): "(https:\/\/[^"]+)"/g)].map((m) => ({ kind: p[1], name: m[1], url: m[2] })));
  if (upstream.length !== 3) throw new Error(`facts: expected 3 upstream URLs in usage/proxy.mjs, found ${upstream.length}`);
  const rates = str(pricing, /RATES_URL =\s*"([^"]+)"/, "RATES_URL");

  // Every vendor call goes through the proxy: one fetch in proxy.mjs (the management API), one in
  // pricing.mjs (LiteLLM), none anywhere else. No source names a CLI credential file or a refresh token.
  const sources = ["usage/server.mjs", "usage/proxy.mjs", "usage/cards.mjs", "usage/tokens.mjs", "usage/pricing.mjs", "usage/guard.mjs"];
  const fetches = Object.fromEntries(sources.map((f) => [f, (read(f).match(/\bfetch\(/g) ?? []).length]));
  const expectedFetches = { "usage/proxy.mjs": 1, "usage/pricing.mjs": 1 };
  for (const f of sources) if (fetches[f] !== (expectedFetches[f] ?? 0)) throw new Error(`facts: ${f} has ${fetches[f]} fetch calls, expected ${expectedFetches[f] ?? 0}`);
  for (const f of [...sources, "usage/index.html"]) {
    if (/\.credentials\.json|auth\.json|refresh_token|oauth\/token/.test(read(f))) throw new Error(`facts: ${f} names a credential file or token endpoint; README says the tracker touches neither`);
  }

  // No dependencies: every import is a node: builtin or a local file.
  for (const f of sources) {
    for (const m of read(f).matchAll(/^import .* from "([^"]+)";/gm)) {
      if (!m[1].startsWith("node:") && !m[1].startsWith("./")) throw new Error(`facts: ${f} imports ${m[1]}; README claims zero dependencies`);
    }
  }
  if (fs.existsSync(path.join(ROOT, "package.json"))) throw new Error("facts: package.json exists; README claims zero dependencies");

  // The app at the root follows the same rule; its files use single quotes.
  const appSources = ["launcher.mjs", "server.mjs", "core.mjs", "harness.mjs", "sync.mjs", "dsh.mjs"];
  for (const f of appSources) {
    for (const m of read(f).matchAll(/^import .* from ['"]([^'"]+)['"];/gm)) {
      if (!m[1].startsWith("node:") && !m[1].startsWith("./")) throw new Error(`facts: ${f} imports ${m[1]}; README claims zero dependencies`);
    }
  }
  const launcher = read("launcher.mjs");
  const appPort = num(launcher, /launchHarnessConsole\(\{ port = (\d+)/, "app port");
  if (!/Number\(process\.env\.USAGE_PORT\)/.test(launcher) || !/Number\(process\.env\.USAGE_PORT\)/.test(server)) throw new Error("facts: USAGE_PORT override missing from launcher.mjs or usage/server.mjs");
  const tabs = [...read("public/index.html").matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
  if (tabs.length !== 5) throw new Error(`facts: expected 5 app tabs, found ${tabs.length}`);

  const pick = (kind, name) => {
    const hit = upstream.find((x) => x.kind === kind && x.name === name);
    if (!hit) throw new Error(`facts: upstream ${kind} ${name} not found in usage/proxy.mjs`);
    return hit;
  };
  const claudeUsage = pick("claude", "usage"), codexUsage = pick("codex", "usage");
  const what = { "claude usage": "Claude windows, extra usage", "claude profile": "Claude plan (once per login; retried after a failure)", "codex usage": "Codex windows, plan, credits, banked resets" };
  const host = (x) => new URL(x).host;
  const upstreamRows = upstream.map((x) => {
    const label = what[`${x.kind} ${x.name}`];
    if (!label) throw new Error(`facts: no README label for upstream ${x.kind} ${x.name}`);
    return { method: "GET", host: host(x.url), path: new URL(x.url).pathname, what: `${label}, through the proxy` };
  });
  const routeWhat = { "auth-files": "list the proxy's logins", "api-call": `one upstream call below, made by the proxy with the login's token` };
  const endpoints = [
    ...routes.map((r) => {
      if (!routeWhat[r.route]) throw new Error(`facts: no README label for proxy route ${r.route}`);
      return { method: r.method, host: `${proxy.host}:${proxy.port}`, path: `/v0/management/${r.route}`, what: routeWhat[r.route] };
    }),
    ...upstreamRows,
    { method: "GET", host: host(rates), path: new URL(rates).pathname, what: `model prices (LiteLLM): after a successful fetch, not again for ${pricingTtlHours} hours; after a failure, on the next transcript scan` },
  ];

  return {
    tokenScanSeconds, refetchHealthySeconds, backoffMinutes, port, cacheFile, retentionDays,
    pageFetchSeconds, countdownSeconds, watchIntervalSeconds, watchTimeoutMinutes, warnAt, badAt, barColors, barColorNames, summaryFullAt, pricingTtlHours,
    priceAlias: { from: priceAlias[1], to: priceAlias[2] }, claudeWindows, proxy, endpoints,
    claudeHost: host(claudeUsage.url), codexHost: host(codexUsage.url),
    claudeUsagePath: new URL(claudeUsage.url).pathname, codexUsagePath: new URL(codexUsage.url).pathname,
    sourceFiles: sources.length + 1, appPort, tabs,
  };
}

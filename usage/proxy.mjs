// CLIProxyAPI management client. The proxy holds every Claude and Codex login and refreshes their
// tokens; the tracker only lists the logins and asks the proxy to make fixed usage calls with them.
// The proxy substitutes $TOKEN$ with the login's token, so no credential reaches this process.
// Config and key are re-read on every call: a proxy restart or a new key needs no tracker restart.

import { readFile } from "node:fs/promises";
import path from "node:path";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROXY_DIR = process.env.USAGE_PROXY_DIR || path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "CLIProxyAPI");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8317;
const HTTP_TIMEOUT_MS = 15_000;

// The only upstream calls the tracker makes. Callers pick by provider and name; no URL comes from outside.
const CLAUDE_HEADERS = { "User-Agent": "claude-cli/2.1.280 (external, cli)", "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" };
const CODEX_HEADERS = { "User-Agent": "usage-dash" };
const UPSTREAM = {
  claude: {
    usage: "https://api.anthropic.com/api/oauth/usage",
    profile: "https://api.anthropic.com/api/oauth/profile",
  },
  codex: {
    usage: "https://chatgpt.com/backend-api/wham/usage",
  },
};
export const UPSTREAM_URLS = Object.values(UPSTREAM).flatMap((p) => Object.values(p));

// Minimal reader for config.yaml: top-level `host:` and `port:` lines only. The tracker talks to the
// proxy over loopback, so a wildcard or remote bind address still means 127.0.0.1.
function parseConfig(text) {
  let host = DEFAULT_HOST, port = DEFAULT_PORT;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(host|port):\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))/.exec(line);
    if (!m) continue;
    const v = m[2] ?? m[3] ?? m[4] ?? "";
    if (m[1] === "host" && ["127.0.0.1", "localhost", "::1"].includes(v)) host = v;
    if (m[1] === "port" && /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536) port = Number(v);
  }
  return { host, port };
}

const baseUrl = ({ host, port }) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

// Where the proxy is, before (or without) reading the key. Never throws.
export async function proxyLocation() {
  let text = "";
  try { text = await readFile(path.join(PROXY_DIR, "config.yaml"), "utf8"); } catch { /* defaults */ }
  const url = baseUrl(parseConfig(text));
  return { url, panelUrl: `${url}/management.html#/oauth` };
}

async function connect() {
  const loc = await proxyLocation();
  const keyFile = path.join(PROXY_DIR, "dashboard-key.txt");
  let key;
  try { key = (await readFile(keyFile, "utf8")).trim(); } catch { key = ""; }
  if (!key) throw new Error(`no management key in ${keyFile}; is CLIProxyAPI installed?`);
  return { ...loc, key };
}

async function management(conn, route, init = {}) {
  let res;
  try {
    res = await fetch(`${conn.url}/v0/management/${route}`, {
      ...init,
      headers: { authorization: `Bearer ${conn.key}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`proxy not reachable at ${conn.url} (${e.cause?.code ?? e.name ?? "error"})`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error(`proxy ${route} HTTP ${res.status}: ${typeof json?.error === "string" ? json.error : text.slice(0, 160)}`);
  return json;
}

// Every login the proxy holds (all providers; the caller filters).
export async function listAuthFiles() {
  const conn = await connect();
  const j = await management(conn, "auth-files");
  if (!Array.isArray(j?.files)) throw new Error("proxy auth-files: no files list in response");
  return j.files;
}

// One allowlisted upstream GET with the login's token. Returns the upstream status, headers and body.
// `accountId` (Codex only) names the ChatGPT account: a login in a workspace or with several accounts
// otherwise gets the default account's usage.
export async function upstreamGet(authIndex, provider, name, accountId = null) {
  const url = UPSTREAM[provider]?.[name];
  if (!url) throw new Error(`no upstream call '${name}' for provider '${provider}'`);
  const conn = await connect();
  const header = { ...(provider === "claude" ? CLAUDE_HEADERS : CODEX_HEADERS), Authorization: "Bearer $TOKEN$" };
  if (provider === "codex" && accountId) header["chatgpt-account-id"] = String(accountId);
  const j = await management(conn, "api-call", { method: "POST", body: JSON.stringify({ authIndex: String(authIndex), method: "GET", url, header }) });
  if (typeof j?.status_code !== "number") throw new Error(`proxy api-call: no upstream status${typeof j?.error === "string" ? `: ${j.error}` : ""}`);
  // The body is the upstream response as a string of JSON, or already parsed.
  let body = j.body ?? null;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (typeof body === "string") { try { body = body ? JSON.parse(body) : null; } catch { body = null; } }
  return { status: j.status_code, ok: j.status_code >= 200 && j.status_code < 300, headers: j.header ?? {}, json: body, text };
}

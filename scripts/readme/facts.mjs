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

export function collectFacts() {
  const server = read("usage/server.mjs");
  const tokens = read("usage/tokens.mjs");
  const pricing = read("usage/pricing.mjs");
  const page = read("usage/index.html");

  // usage/accounts.json is committed and the server reads it with `config.X ?? literal`,
  // so the README states the effective value, not the fallback.
  const config = JSON.parse(read("usage/accounts.json"));
  const configured = (key, fallback) => {
    if (config[key] === undefined) return fallback;
    if (!Number.isInteger(config[key]) || config[key] < 0) throw new Error(`facts: usage/accounts.json ${key} is not a non-negative integer`);
    return config[key];
  };
  // A poll interval of 0 turns that timer off: the server fetches once at startup,
  // then only on /api/refresh (page load and "Refresh now").
  const poll = (key) => {
    const defaultSeconds = num(server, new RegExp(`config\\.${key} \\?\\? (\\d+)`), key);
    const seconds = configured(key, defaultSeconds);
    return { on: seconds > 0, seconds, defaultSeconds, label: seconds > 0 ? `${seconds} s` : "on load" };
  };
  if (!/if \(p\.pollMs > 0\) setTimeout\(tick, p\.pollMs\)/.test(server)) throw new Error("facts: usage/server.mjs no longer skips the poll timer at 0");
  const claudePoll = poll("claudePollSeconds");
  const codexPoll = poll("codexPollSeconds");
  const tokenScanSeconds = configured("tokenScanSeconds", num(server, /config\.tokenScanSeconds \?\? (\d+)/, "tokenScanSeconds"));
  const port = configured("port", num(server, /config\.port \?\? (\d+)/, "port"));
  const retentionDays = num(tokens, /RETENTION_MS = (\d+) \* 24 \* 3600 \* 1000/, "RETENTION_MS");
  const codexExpiryWarnHours = num(server, /CODEX_EXPIRY_WARN_MS = (\d+) \* 60 \* 60 \* 1000/, "CODEX_EXPIRY_WARN_MS");
  const pageFetchSeconds = num(page, /setInterval\(load, (\d+)_000\)/, "page fetch interval");
  const countdownSeconds = num(page, /setInterval\(render, (\d+)_000\)/, "countdown interval");
  const warnAt = num(page, /p >= (\d+) \? "warn"/, "warn threshold");
  const badAt = num(page, /p >= (\d+) \? "bad"/, "bad threshold");
  const pricingTtlHours = num(pricing, /TTL_MS = (\d+) \* 3600 \* 1000/, "pricing TTL");

  const claudeWindows = [...server.matchAll(/win\(j\.\w+ \?\? j\.\w+, "([^"]+)"\)/g)].map((m) => m[1]);
  if (claudeWindows.length !== 4) throw new Error(`facts: expected 4 Claude windows, found ${claudeWindows.length}`);

  const urls = {
    claudeUsage: server.match(/CLAUDE_USAGE_URL = "([^"]+)"/)?.[1],
    claudeToken: server.match(/CLAUDE_TOKEN_URL = "([^"]+)"/)?.[1],
    claudeProfile: server.match(/CLAUDE_PROFILE_URL = "([^"]+)"/)?.[1],
    codexBase: server.match(/CODEX_BASE_URL = "([^"]+)"/)?.[1],
    rates: pricing.match(/RATES_URL =\s*"([^"]+)"/)?.[1],
  };
  for (const [k, v] of Object.entries(urls)) if (!v) throw new Error(`facts: url ${k} not found`);
  const codexPaths = [...new Set([...server.matchAll(/CODEX_BASE_URL\}(\/[\w/-]+)`/g)].map((m) => m[1]))];
  if (codexPaths.length !== 2) throw new Error(`facts: expected 2 Codex paths, found ${codexPaths.length}`);

  // The token refresh is the only POST the server makes.
  const posts = (server.match(/method: "POST"/g) ?? []).length;
  if (posts !== 1) throw new Error(`facts: expected exactly one POST in usage/server.mjs, found ${posts}`);

  // No dependencies: every import is a node: builtin or a local file.
  const sources = ["usage/server.mjs", "usage/tokens.mjs", "usage/pricing.mjs"];
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

  const lines = [...sources, "usage/index.html"].reduce((n, f) => n + read(f).split("\n").filter((l) => l.trim()).length, 0);

  const host = (u) => new URL(u).host;
  const endpoints = [
    { method: "GET", host: host(urls.claudeUsage), path: new URL(urls.claudeUsage).pathname, what: "Claude windows" },
    { method: "GET", host: host(urls.claudeProfile), path: new URL(urls.claudeProfile).pathname, what: "Claude email" },
    { method: "POST", host: host(urls.claudeToken), path: new URL(urls.claudeToken).pathname, what: "Claude token refresh" },
    { method: "GET", host: host(urls.codexBase), path: new URL(urls.codexBase).pathname + codexPaths[0], what: "Codex windows, plan, credits" },
    { method: "GET", host: host(urls.codexBase), path: new URL(urls.codexBase).pathname + codexPaths[1], what: "Codex banked resets" },
    { method: "GET", host: host(urls.rates), path: new URL(urls.rates).pathname, what: "model prices (LiteLLM)" },
  ];

  return {
    claudePoll, codexPoll, tokenScanSeconds, port, retentionDays, codexExpiryWarnHours,
    pageFetchSeconds, countdownSeconds, warnAt, badAt, pricingTtlHours, claudeWindows, endpoints, lines,
    sourceFiles: sources.length + 1, appPort, tabs,
  };
}

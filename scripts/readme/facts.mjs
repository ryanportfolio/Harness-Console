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
  const server = read("server.mjs");
  const tokens = read("tokens.mjs");
  const pricing = read("pricing.mjs");
  const page = read("index.html");

  const claudePollSeconds = num(server, /config\.claudePollSeconds \?\? (\d+)/, "claudePollSeconds");
  const codexPollSeconds = num(server, /config\.codexPollSeconds \?\? (\d+)/, "codexPollSeconds");
  const tokenScanSeconds = num(server, /config\.tokenScanSeconds \?\? (\d+)/, "tokenScanSeconds");
  const port = num(server, /config\.port \?\? (\d+)/, "port");
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
  if (posts !== 1) throw new Error(`facts: expected exactly one POST in server.mjs, found ${posts}`);

  // No dependencies: every import is a node: builtin or a local file.
  const sources = ["server.mjs", "tokens.mjs", "pricing.mjs"];
  for (const f of sources) {
    for (const m of read(f).matchAll(/^import .* from "([^"]+)";/gm)) {
      if (!m[1].startsWith("node:") && !m[1].startsWith("./")) throw new Error(`facts: ${f} imports ${m[1]}; README claims zero dependencies`);
    }
  }
  if (fs.existsSync(path.join(ROOT, "package.json"))) throw new Error("facts: package.json exists; README claims zero dependencies");

  const lines = [...sources, "index.html"].reduce((n, f) => n + read(f).split("\n").filter((l) => l.trim()).length, 0);

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
    claudePollSeconds, codexPollSeconds, tokenScanSeconds, port, retentionDays, codexExpiryWarnHours,
    pageFetchSeconds, countdownSeconds, warnAt, badAt, pricingTtlHours, claudeWindows, endpoints, lines,
    sourceFiles: sources.length + 1,
  };
}

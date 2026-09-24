// Token totals from the CLIs' on-disk transcripts.
//
// Neither provider exposes token counts over an API, so this scans what the
// CLIs write locally: Claude Code under <dir>/projects/**/*.jsonl, Codex under
// <dir>/sessions/**/*.jsonl. Parsed records are cached per file in
// .state/tokens/<account>.json keyed by (size, mtime); a grown file re-parses
// only its appended bytes. Cached records outlive the transcript they came
// from, so history survives the CLIs' own log cleanup.
//
// Parsing rules (dedupe keys, Codex delta summing, fork-copy suppression)
// follow T3 Code's usageTranscripts.ts (pingdotgg/t3code, MIT) and ccusage.

import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const CACHE_VERSION = 2; // v2: records carry the one-hour cache-write portion
const RETENTION_MS = 400 * 24 * 3600 * 1000; // keep records this long after their timestamp
const FORK_COPY_MAX_GAP_MS = 1000;

const int = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const ts = (v) => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; };

// record: [timestampMs, model, uncachedIn, cachedIn, cacheWrite, out, reasoning, dedupeKey|null, cacheWrite1h]
// cacheWrite1h is the part of cacheWrite written with a one-hour TTL (Claude only); it is priced higher.
const total = (r) => r[2] + r[3] + r[4] + r[5];

// ---------- Claude Code ----------

// Every content block of one assistant message is its own line carrying the
// same usage object; dedupe by message id + request id, first wins.
function parseClaudeLine(line) {
  if (!line.includes('"usage"')) return null;
  let o; try { o = JSON.parse(line); } catch { return null; }
  if (o?.type !== "assistant") return null;
  const m = o.message, u = m?.usage;
  if (!u || typeof u !== "object") return null;
  const t = ts(o.timestamp);
  const model = typeof m.model === "string" ? m.model : "";
  if (t === null || !model || model.startsWith("<")) return null;
  const key = m.id || o.requestId ? `${m.id ?? ""}:${o.requestId ?? ""}` : null;
  const cw = int(u.cache_creation_input_tokens);
  const r = [t, model, int(u.input_tokens), int(u.cache_read_input_tokens), cw, int(u.output_tokens), 0, key, Math.min(cw, int(u.cache_creation?.ephemeral_1h_input_tokens))];
  return total(r) ? r : null;
}

// ---------- Codex ----------

const codexInit = () => ({ model: "", sig: null, sawMeta: false, forkSuppress: false, forkAnchor: 0 });

function isForkMeta(p) {
  if (typeof p.forked_from_id === "string") return true;
  return typeof p.source?.subagent?.thread_spawn?.parent_thread_id === "string";
}

// token_count events carry no model: carry it from the latest turn_context.
// Sum last_token_usage deltas; identical consecutive payloads are re-emits.
// A forked rollout opens with the parent's history re-stamped to the fork
// instant in one burst; drop events until a >1s gap.
function parseCodexLine(line, s) {
  let o; try { o = JSON.parse(line); } catch { return null; }
  const p = o?.payload;
  if (!p || typeof p !== "object") return null;
  if (o.type === "session_meta") {
    if (s.sawMeta) return null;
    s.sawMeta = true;
    const t = ts(o.timestamp);
    if (t !== null && isForkMeta(p)) { s.forkSuppress = true; s.forkAnchor = t; }
    return null;
  }
  if (o.type === "turn_context") { if (typeof p.model === "string") s.model = p.model; return null; }
  if (p.type !== "token_count") return null;
  const last = p.info?.last_token_usage;
  if (!last || typeof last !== "object") return null;
  const t = ts(o.timestamp);
  if (t === null || !s.model) return null;
  const sig = JSON.stringify(last);
  if (sig === s.sig) return null;
  s.sig = sig;
  if (s.forkSuppress) {
    if (t - s.forkAnchor < FORK_COPY_MAX_GAP_MS) { s.forkAnchor = t; return null; }
    s.forkSuppress = false;
  }
  const inp = int(last.input_tokens), cached = int(last.cached_input_tokens), cw = int(last.cache_write_input_tokens), out = int(last.output_tokens);
  const r = [t, s.model, Math.max(0, inp - cached - cw), cached, cw, out, Math.min(out, int(last.reasoning_output_tokens)), null, 0];
  return total(r) ? r : null;
}

// ---------- file scanning ----------

const LAYOUT = {
  claude: { sub: "projects", parse: (line) => parseClaudeLine(line), init: () => null, gates: ['"usage"'] },
  codex: { sub: "sessions", parse: (line, s) => parseCodexLine(line, s), init: codexInit, gates: ['"token_count"', '"turn_context"', '"session_meta"'] },
};

async function listJsonl(root) {
  let names;
  try { names = await readdir(root, { recursive: true }); } catch { return []; }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => path.join(root, n));
}

// Parse newline-terminated lines from byte `offset`. A trailing partial line
// (writer mid-append) is left for the next scan: the returned offset stops at
// the last newline.
async function parseFrom(file, offset, layout, state) {
  const records = [];
  const seen = new Set();
  let rest = Buffer.alloc(0), consumed = offset;
  const handle = (line) => {
    if (!layout.gates.some((g) => line.includes(g))) return;
    const r = layout.parse(line, state);
    if (!r) return;
    if (r[7] !== null) { if (seen.has(r[7])) return; seen.add(r[7]); }
    records.push(r);
  };
  for await (const chunk of createReadStream(file, { start: offset })) {
    const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    let from = 0, nl;
    while ((nl = buf.indexOf(0x0a, from)) !== -1) {
      handle(buf.toString("utf8", from, nl));
      consumed += nl + 1 - from;
      from = nl + 1;
    }
    rest = buf.subarray(from);
  }
  return { records, offset: consumed };
}

export class TokenScanner {
  constructor(acct, cacheFile, writeAtomic, log) {
    this.acct = acct;
    this.cacheFile = cacheFile;
    this.writeAtomic = writeAtomic;
    this.log = log;
    this.files = new Map(); // path -> { size, mtimeMs, offset, state, records }
    this.lastScanAt = null;
    this.scanning = null;
  }

  async load() {
    try {
      const c = JSON.parse(await readFile(this.cacheFile, "utf8"));
      if (c.version === CACHE_VERSION) for (const [p, f] of Object.entries(c.files)) this.files.set(p, f);
    } catch { /* cold */ }
  }

  async save() {
    const files = Object.fromEntries(this.files);
    await this.writeAtomic(this.cacheFile, JSON.stringify({ version: CACHE_VERSION, files }));
  }

  scan() {
    if (!this.scanning) this.scanning = this.#scan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async #scan() {
    const layout = LAYOUT[this.acct.kind];
    if (!layout) return;
    const t0 = Date.now();
    const cutoff = t0 - RETENTION_MS;
    let changed = 0;
    for (const file of await listJsonl(path.join(this.acct.dir, layout.sub))) {
      let st; try { st = await stat(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const prev = this.files.get(file);
      if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
      const resume = prev && st.size > prev.size && prev.offset <= st.size;
      const state = resume ? (prev.state ?? layout.init()) : layout.init();
      try {
        const { records, offset } = await parseFrom(file, resume ? prev.offset : 0, layout, state);
        this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, offset, state, records: resume ? prev.records.concat(records) : records });
        changed++;
      } catch (e) { this.log(`[${this.acct.name}] tokens: ${file}: ${e.message}`); }
    }
    for (const [p, f] of this.files) {
      const newest = f.records.reduce((m, r) => Math.max(m, r[0]), 0);
      if (newest < cutoff && f.mtimeMs < cutoff) this.files.delete(p);
    }
    this.lastScanAt = new Date().toISOString();
    if (changed) { await this.save(); this.log(`[${this.acct.name}] tokens: ${changed} files parsed in ${Date.now() - t0}ms`); }
  }

  // Totals for the last `days` local calendar days, today included.
  summary(days, pricing) {
    const dayOf = makeDayFormatter();
    // Calendar-day arithmetic via setDate so DST transitions keep local midnights.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today); start.setDate(start.getDate() - (days - 1));
    const since = start.getTime();
    const seen = new Set();
    const zero = () => ({ uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0, reasoning: 0, total: 0, costUsd: 0, unpriced: 0 });
    const add = (b, r, cost) => {
      b.uncachedIn += r[2]; b.cachedIn += r[3]; b.cacheWrite += r[4]; b.out += r[5]; b.reasoning += r[6]; b.total += total(r);
      if (cost === null) b.unpriced += total(r); else b.costUsd += cost;
    };
    const all = zero(), byModel = {}, byDay = {};
    for (const f of this.files.values()) {
      for (const r of f.records) {
        if (r[0] < since) continue;
        if (r[7] !== null) { if (seen.has(r[7])) continue; seen.add(r[7]); }
        const cost = pricing?.cost(r[1], r[2], r[3], r[4], r[5], r[8] ?? 0) ?? null;
        add(all, r, cost);
        add(byModel[r[1]] ??= zero(), r, cost);
        add(byDay[dayOf(r[0])] ??= zero(), r, cost);
      }
    }
    const series = [];
    for (let i = 0; i < days; i++) {
      const dt = new Date(start); dt.setDate(start.getDate() + i);
      const d = dayOf(dt.getTime()); series.push({ day: d, total: byDay[d]?.total ?? 0, costUsd: byDay[d]?.costUsd ?? 0 });
    }
    return { days, ...all, byModel, series, lastScanAt: this.lastScanAt, files: this.files.size };
  }
}

function makeDayFormatter() {
  const f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
  return (t) => f.format(new Date(t));
}

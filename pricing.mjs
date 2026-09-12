// API-equivalent prices per model from LiteLLM's public table, cached on disk
// for a day. Subscription plans are not billed per token; the figure only
// says what the same traffic would cost on the API.

import { readFile } from "node:fs/promises";

const RATES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 3600 * 1000;

export class Pricing {
  constructor(cacheFile, writeAtomic, log) {
    this.cacheFile = cacheFile;
    this.writeAtomic = writeAtomic;
    this.log = log;
    this.rates = new Map(); // model -> { in, out, cr, cw } USD per token
    this.fetchedAt = 0;
    this.status = "unavailable";
    this.lookup = new Map();
  }

  async load() {
    try {
      const c = JSON.parse(await readFile(this.cacheFile, "utf8"));
      this.#set(c.rates, c.fetchedAt, "cached");
    } catch { /* cold */ }
  }

  async refresh(force = false) {
    if (!force && Date.now() - this.fetchedAt < TTL_MS) return;
    try {
      const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      const rates = {};
      for (const [k, v] of Object.entries(doc)) {
        if (typeof v?.input_cost_per_token !== "number" || typeof v?.output_cost_per_token !== "number") continue;
        rates[k] = {
          in: v.input_cost_per_token, out: v.output_cost_per_token,
          cr: typeof v.cache_read_input_token_cost === "number" ? v.cache_read_input_token_cost : v.input_cost_per_token,
          cw: typeof v.cache_creation_input_token_cost === "number" ? v.cache_creation_input_token_cost : v.input_cost_per_token,
        };
      }
      this.#set(rates, Date.now(), "live");
      await this.writeAtomic(this.cacheFile, JSON.stringify({ fetchedAt: this.fetchedAt, rates }));
      this.log(`pricing: ${this.rates.size} models from LiteLLM`);
    } catch (e) {
      this.log(`pricing: fetch failed (${e.message}); ${this.rates.size ? "using cached table" : "no prices"}`);
    }
  }

  #set(rates, fetchedAt, status) {
    this.rates = new Map(Object.entries(rates));
    this.fetchedAt = fetchedAt;
    this.status = status;
    this.lookup.clear();
  }

  // Exact key first, then any provider-prefixed key ("anthropic/<model>").
  rate(model) {
    if (this.lookup.has(model)) return this.lookup.get(model);
    let r = this.rates.get(model) ?? null;
    if (!r) for (const [k, v] of this.rates) if (k.endsWith(`/${model}`)) { r = v; break; }
    this.lookup.set(model, r);
    return r;
  }

  cost(model, uncachedIn, cachedIn, cacheWrite, out) {
    const r = this.rate(model);
    if (!r) return null;
    return uncachedIn * r.in + cachedIn * r.cr + cacheWrite * r.cw + out * r.out;
  }
}

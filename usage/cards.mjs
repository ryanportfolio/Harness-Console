// Card view model for the Usage page: turns an /api/usage payload into display strings, so the
// page only builds markup and node tests can check every label. No imports; runs in the browser and Node.

const toMs = (t) => (typeof t === "number" ? t : Date.parse(t));

// "4d 19h", "3h 5m", "12m", "40s"
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
const ago = (iso, now) => (iso ? `${span(now - toMs(iso))} ago` : "");

function level(p) { return p >= 90 ? "bad" : p >= 70 ? "warn" : ""; }

// A reset time at or before now means the old percentage no longer holds; the next fetch has the new one.
function windowView(w, now) {
  const reset = w.resetsAt ? toMs(w.resetsAt) : null;
  if (reset != null && reset <= now) {
    return { label: w.label, pct: null, pctText: "unknown", resetText: `reset ${span(now - reset)} ago, waiting for new data`, level: "" };
  }
  const pct = Number(w.usedPercent) || 0;
  let resetText = "";
  if (reset != null) {
    const s = Math.round((reset - now) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const t = new Date(reset);
    const clock = d >= 1 ? t.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) : t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    resetText = `resets in ${d ? d + "d " : ""}${h}h ${m}m (${clock})`;
  }
  return { label: w.label, pct, pctText: `${Math.round(pct)}% used`, resetText, level: level(pct) };
}

// CLIProxyAPI (v8) marks a login unavailable and sets status_message for a rejected credential and for
// a quota cooldown or upstream error alike (sdk/cliproxy/auth/conductor_cooldown.go applyAuthFailureState).
// These tell them apart: the markers it writes itself, then the reason of each live cooldown
// (sdk/cliproxy/auth/cooldown_view.go), then the text of a raw upstream message as a last resort.
const AUTH_MARKER = /^(unauthorized|payment_required|invalid[_ ]grant|token expired)\b/i;
const COOLDOWN_MARKER = /^(quota exhausted|quota|transient upstream error|cloudflare challenge|request failed|not_found|model_not_supported)$/i;
const AUTH_REASONS = ["unauthorized", "payment_required", "invalid_grant"];
const AUTH_TEXT = /\b40[13]\b|unauthori[sz]ed|authenticat|permission|forbidden|invalid[_ ]grant|revoked|expired/i;

// Only a rejected credential needs a new sign-in: the usage API answered 401 or 403, or the proxy's
// fields say so. A login flagged for a cooldown or an upstream error does not.
export function signInNeeded(a) {
  if (!a) return false;
  if (a.authRejected) return true;
  const msg = String(a.proxyMessage ?? "").trim();
  const cooldowns = a.proxyCooldowns ?? [];
  if (AUTH_MARKER.test(msg) || cooldowns.some((c) => AUTH_REASONS.includes(c.reason) || c.httpStatus === 401 || c.httpStatus === 403)) return true;
  if (cooldowns.length || COOLDOWN_MARKER.test(msg)) return false;
  if (msg) return AUTH_TEXT.test(msg);
  // Unavailable with no message: a retry time means a cooldown; none means a token the proxy cannot use.
  return !!a.unavailable && !a.proxyRetryAt;
}

// A login that fetched fine and needs no new sign-in. The sign-in watch waits for exactly this
// before it reports success.
export const healthy = (a) => !!a?.ok && !signInNeeded(a);

// "Fri 10:00 PM" (the weekday only when the time is not today), "10:00 PM"
function clockText(t, now) {
  const sameDay = new Date(now).toDateString() === t.toDateString();
  return sameDay ? t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : t.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

// "4d 1h 40m", "3h 5m", "12m"
function untilText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
}

// One ledger cell. A stale row and a passed reset both show the last number as "Last: N%"; a passed
// reset has no current percentage at all.
function cellView(column, w, now, stale) {
  if (!w) return { column, pct: null, pctText: "—", resetText: "", level: "", missing: true };
  const used = Number(w.usedPercent) || 0;
  const reset = w.resetsAt ? toMs(w.resetsAt) : null;
  if (reset != null && reset <= now) return { column, pct: null, pctText: `Last: ${Math.round(used)}%`, resetText: "current reset unknown", level: "", missing: false };
  const resetText = reset != null ? `${clockText(new Date(reset), now)} · in ${untilText(reset - now)}` : "";
  return { column, pct: used, pctText: stale ? `Last: ${Math.round(used)}%` : `${Math.round(used)}% used`, resetText, level: level(used), missing: false };
}

// "Friday at 10:00 PM", "today at 3:00 PM", "tomorrow at 1:00 AM"
function dayAt(ms, now) {
  const t = new Date(ms), n = new Date(now);
  const tomorrow = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  const day = t.toDateString() === n.toDateString() ? "today" : t.toDateString() === tomorrow.toDateString() ? "tomorrow" : t.toLocaleDateString([], { weekday: "long" });
  return `${day} at ${t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

// The ledger's one-line summary: Codex weekly room left, then the Claude login most worth watching.
function summaryText(accounts, cards, now) {
  // Live rows with a current weekly number: { kind, title, pct, reset }
  const rows = cards.flatMap((c, i) => {
    const cell = c.cells.find((x) => x.column === "Weekly");
    const w = (accounts[i].data?.windows ?? []).find((x) => x.label === "Weekly");
    return c.statusText === "Live" && cell && cell.pct != null ? [{ kind: c.kind, title: c.title, pct: Math.round(cell.pct), reset: w?.resetsAt ? toMs(w.resetsAt) : null }] : [];
  });
  const parts = [];
  const codex = rows.filter((r) => r.kind === "codex").sort((a, b) => a.pct - b.pct);
  if (codex.length) {
    const room = Math.max(0, 100 - codex[0].pct);
    parts.push(codex.length > 1 ? `Codex has ${room}% weekly room left on ${codex[0].title}.` : `Codex has ${room}% weekly room left.`);
  }
  const claude = rows.filter((r) => r.kind === "claude" && Number.isFinite(r.reset)).sort((a, b) => a.reset - b.reset);
  const full = claude.find((r) => r.pct >= 90);
  if (full) parts.push(`${full.title} is at ${full.pct}% weekly and resets ${dayAt(full.reset, now)}.`);
  else if (claude.length) parts.push(`${claude[0].title} resets ${dayAt(claude[0].reset, now)}.`);
  else {
    // A weekly number with no reset time (an unused week can report none): name the fullest.
    const top = rows.filter((r) => r.kind === "claude").sort((a, b) => b.pct - a.pct)[0];
    if (top) parts.push(`${top.title} is at ${top.pct}% weekly.`);
  }
  if (parts.length) return parts.join(" ");
  // Live rows can still lack a current weekly number: a session window only, or a weekly reset already passed.
  return cards.some((c) => c.statusText === "Live") ? "No live account has a current weekly number right now." : "No account has live numbers right now.";
}

// A 429 parks a login until retryAt (set by the server). Nothing fetches it when that time comes: the
// next page load, Refresh now or sign-in watch does. A login that needs a new sign-in gets no Refresh
// hint: refreshing cannot fix it.
function rateLimitText(retryAt, now, hint = true) {
  const t = retryAt ? toMs(retryAt) : NaN;
  if (!Number.isFinite(t)) return "Rate limited by the usage API.";
  const until = `Rate limited by the usage API until ${clockText(new Date(t), now)}`;
  if (!hint) return t > now ? `${until} (in ${span(t - now)}).` : `${until}.`;
  return t > now ? `${until} (in ${span(t - now)}). Press Refresh now after that.` : `${until}. Press Refresh now to fetch it again.`;
}

// The proxy's own error strings (usage/proxy.mjs), said plainly.
function proxyProblem(error) {
  const e = String(error ?? "");
  if (/ECONNREFUSED/.test(e)) return "Nothing answered on that port. Start CLIProxyAPI, then press Refresh now.";
  if (/Timeout|ETIMEDOUT/i.test(e)) return "The proxy did not answer in time.";
  if (/HTTP 40[13]/.test(e)) return "The proxy refused the management key in dashboard-key.txt.";
  return e;
}

export function viewModel(payload, now = Date.parse(payload.now)) {
  now = toMs(now);
  const proxy = payload.proxy ?? {};
  let banner = null;
  if (!proxy.ok) banner = proxy.checkedAt ? `Proxy not running at ${proxy.url}. ${proxyProblem(proxy.error)}`.trim() : `Checking the proxy at ${proxy.url}`;

  const accounts = payload.accounts ?? [];
  // Ledger columns: the two windows every plan has, then any other label in first-seen order.
  const columns = ["Session (5h)", "Weekly"];
  for (const a of accounts) for (const w of a.data?.windows ?? []) if (!columns.includes(w.label)) columns.push(w.label);

  const cards = accounts.map((a) => {
    const d = a.data;
    const stale = !a.ok && !!d;
    const when = a.lastGoodAt ?? a.fetchedAt;
    const staleLabel = stale ? (when ? `as of ${ago(when, now)}` : "as of an unknown time") : null;
    const notes = [...(d?.notes ?? [])];
    if (a.disabled) notes.unshift("disabled in proxy");
    // Signing in again fixes a rejected login, not a down proxy, a rate limit or a cooldown.
    const broken = !a.disabled && signInNeeded(a);
    const rateLimited = !a.ok && !!a.rateLimited;
    // While the proxy is down every card carries the same error; the banner says it once.
    const error = a.disabled || !proxy.ok ? null : [a.ok ? null : rateLimited ? rateLimitText(a.retryAt, now, !broken) : a.error, a.proxyMessage ? `Proxy says: ${a.proxyMessage}` : null, a.unavailable ? "The proxy marks this login unavailable." : null].filter(Boolean).join("\n") || null;
    // A rate limit alone never sets broken, so a rate-limited login that is also rejected still gets the button.
    const signIn = broken && proxy.ok && proxy.panelUrl ? { url: proxy.panelUrl } : null;
    return {
      id: a.id,
      kind: a.kind,
      title: a.email || a.label || a.id,
      plan: a.plan || "",
      ok: !!a.ok,
      stale,
      // Greyed: old numbers, a disabled login, or no numbers while the proxy is down.
      dim: stale || !!a.disabled || (!proxy.ok && !d),
      staleLabel,
      meta: stale ? staleLabel : a.ok && a.fetchedAt ? `fetched ${ago(a.fetchedAt, now)}` : "",
      disabled: !!a.disabled,
      duplicate: !!a.duplicate,
      warning: a.duplicate ? "Same account as another login in the proxy." : null,
      warnings: d?.warnings ?? [],
      error,
      signIn,
      hasData: !!d,
      windows: (d?.windows ?? []).map((w) => windowView(w, now)),
      notes,
      cells: columns.map((col) => cellView(col, (d?.windows ?? []).find((w) => w.label === col), now, stale)),
      // A rejected login says "Sign-in needed" over old numbers or a rate limit: signing in is what it needs,
      // and the account line already shows the numbers' age. A cooldown with an ok fetch is Live, the proxy's
      // message beside it; a failed fetch with nothing to show is "Fetch failed".
      statusText: a.disabled ? "Disabled in proxy" : broken && proxy.ok ? "Sign-in needed" : stale ? `As of ${when ? ago(when, now) : "an unknown time"}` : !proxy.ok ? "Proxy unreachable" : rateLimited ? "Rate limited" : !a.ok ? "Fetch failed" : "Live",
    };
  });
  // Before the first proxy check nothing is known yet, so neither the ledger nor the header may read as a real empty state.
  const checked = !!proxy.checkedAt;
  const emptyText = !checked ? "Checking the proxy for your accounts..."
    : !proxy.ok ? "No saved data yet. Start CLIProxyAPI to see your accounts."
    : "No Claude or Codex account in the proxy yet. Press Add account to sign one in.";
  const metaText = checked ? `${cards.filter((c) => c.statusText === "Live").length}/${cards.length} accounts live` : "Checking accounts...";
  const summary = checked ? summaryText(accounts, cards, now) : "Checking the proxy for your accounts...";
  return { banner, columns, cards, summary, emptyText, metaText };
}

// After the user opens the proxy's sign-in page: poll until a login appears that was not there
// before, or the account being signed in again fetches fine, or the timeout passes. "Fine" is
// healthy(): an ok fetch while the proxy still reports a rejected credential does not count; one
// under a cooldown or upstream-error flag does.
export async function watchForLogin({ poll, knownIds = [], targetId = null, intervalMs = 5000, timeoutMs = 600000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const known = new Set(knownIds);
  const start = now();
  for (;;) {
    await sleep(intervalMs);
    let payload = null;
    try { payload = await poll(); } catch { /* server busy or restarting; try again next tick */ }
    for (const a of payload?.accounts ?? []) {
      if (!healthy(a)) continue;
      if (!known.has(a.id)) return { found: true, account: a };
      if (targetId && a.id === targetId && a.fetchedAt && Date.parse(a.fetchedAt) > start) return { found: true, account: a };
    }
    if (now() - start >= timeoutMs) return { found: false };
  }
}

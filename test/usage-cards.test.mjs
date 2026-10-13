import test from 'node:test';
import assert from 'node:assert/strict';
import { viewModel, watchForLogin } from '../usage/cards.mjs';

const now = Date.parse('2026-10-12T12:00:00Z');
const H = 3600_000;
const iso = ms => new Date(now + ms).toISOString();
const proxy = { ok: true, url: 'http://127.0.0.1:8317', panelUrl: 'http://127.0.0.1:8317/management.html#/oauth', error: null, checkedAt: iso(0) };
const acct = over => ({
  id: 'claude:a@x.com', kind: 'claude', email: 'a@x.com', label: 'a@x.com', plan: 'Claude Max', disabled: false, duplicate: false,
  proxyStatus: 'active', proxyMessage: null, unavailable: false, ok: true, stale: false, fetchedAt: iso(-60_000), lastGoodAt: iso(-60_000), error: null,
  data: { windows: [{ label: 'Weekly', usedPercent: 100, resetsAt: iso(-2 * H) }, { label: 'Session (5h)', usedPercent: 75, resetsAt: iso(3 * H) }], notes: [], warnings: [] },
  ...over,
});
const view = (accounts, p = proxy) => viewModel({ now: iso(0), proxy: p, accounts }, now);

test('cards: a passed reset shows no percentage and never "resets now", on fresh and stale cards', () => {
  for (const a of [acct({}), acct({ ok: false, stale: true, error: 'usage API 401' })]) {
    const c = view([a]).cards[0];
    const weekly = c.windows.find(w => w.label === 'Weekly');
    assert.equal(weekly.pct, null);
    assert.equal(weekly.pctText, 'unknown');
    assert.equal(weekly.resetText, 'reset 2h 0m ago, waiting for new data');
    assert.doesNotMatch(JSON.stringify(c), /resets now/i);
  }
});

test('cards: a future window keeps its percentage and level', () => {
  const c = view([acct({ data: { windows: [{ label: 'A', usedPercent: 75, resetsAt: iso(3 * H) }, { label: 'B', usedPercent: 92, resetsAt: iso(H) }, { label: 'C', usedPercent: 10, resetsAt: iso(H) }], notes: [], warnings: [] } })]).cards[0];
  assert.deepEqual(c.windows.map(w => [w.pct, w.pctText, w.level]), [[75, '75% used', 'warn'], [92, '92% used', 'bad'], [10, '10% used', '']]);
  assert.match(c.windows[0].resetText, /^resets in 3h 0m \(/);
  assert.equal(c.title, 'a@x.com');
  assert.equal(c.plan, 'Claude Max');
  assert.equal(c.stale, false);
  assert.equal(c.signIn, null);
  assert.equal(c.meta, 'fetched 1m ago');
});

test('cards: a failed fetch with cached data is stale "as of <age>" and offers sign-in to the proxy panel', () => {
  const c = view([acct({ ok: false, stale: true, fetchedAt: iso(-1000), lastGoodAt: iso(-115 * H), error: 'usage API 401: sign in again' })]).cards[0];
  assert.equal(c.stale, true);
  assert.equal(c.staleLabel, 'as of 4d 19h ago');
  assert.equal(c.meta, 'as of 4d 19h ago');
  assert.deepEqual(c.signIn, { url: proxy.panelUrl });
  assert.match(c.error, /usage API 401/);
  // lastGoodAt missing: fall back to fetchedAt
  assert.equal(view([acct({ ok: false, lastGoodAt: null, fetchedAt: iso(-5 * 60_000), error: 'x' })]).cards[0].staleLabel, 'as of 5m ago');
});

test('cards: a proxy message or unavailable flag offers sign-in and shows the message', () => {
  const c = view([acct({ proxyMessage: 'token expired' })]).cards[0];
  assert.deepEqual(c.signIn, { url: proxy.panelUrl });
  assert.match(c.error, /token expired/);
  assert.deepEqual(view([acct({ unavailable: true })]).cards[0].signIn, { url: proxy.panelUrl });
  // a rate limit is not fixed by signing in
  assert.equal(view([acct({ ok: false, rateLimited: true, retryAt: iso(5 * 60_000), error: 'rate limited by usage API' })]).cards[0].signIn, null);
});

test('cards: a rate-limited login with no numbers reads "Rate limited", offers no sign-in, and its retry text follows the clock', () => {
  const a = acct({ ok: false, data: null, lastGoodAt: null, rateLimited: true, retryAt: iso(10 * 60_000), error: 'rate limited by usage API' });
  const early = viewModel({ now: iso(0), proxy, accounts: [a] }, now).cards[0];
  const later = viewModel({ now: iso(0), proxy, accounts: [a] }, now + 7 * 60_000).cards[0];
  for (const c of [early, later]) {
    assert.equal(c.statusText, 'Rate limited');
    assert.equal(c.signIn, null);
    assert.doesNotMatch(c.error, /retrying|automatic/i);
  }
  assert.match(early.error, /in 10m/);
  assert.match(later.error, /in 3m/);
  assert.notEqual(early.error, later.error);
  // once retryAt passes, the text says to refresh, not that it will retry
  const past = viewModel({ now: iso(0), proxy, accounts: [a] }, now + 11 * 60_000).cards[0];
  assert.match(past.error, /Press Refresh now/);
  // an error that merely starts like a rate limit is not one without the flag
  assert.deepEqual(view([acct({ ok: false, data: null, error: 'rate limited by usage API' })]).cards[0].signIn, { url: proxy.panelUrl });
  // a rate-limited row with numbers keeps "As of"
  assert.match(view([acct({ ok: false, stale: true, rateLimited: true, retryAt: iso(60_000) })]).cards[0].statusText, /^As of /);
});

test('cards: proxy down, a login with no numbers reads "Proxy unreachable", greyed, no sign-in; one with numbers stays "As of"', () => {
  const down = { ...proxy, ok: false, error: 'proxy not reachable at http://127.0.0.1:8317 (ECONNREFUSED)' };
  const vm = view([
    acct({ id: 'claude:none', ok: false, stale: true, data: null, lastGoodAt: null, error: down.error }),
    acct({ id: 'claude:some', ok: false, stale: true, error: down.error }),
  ], down);
  const [none, some] = vm.cards;
  assert.equal(none.statusText, 'Proxy unreachable');
  assert.equal(none.dim, true);
  assert.equal(none.signIn, null);
  assert.equal(some.statusText, 'As of 1m ago');
  assert.equal(some.dim, true);
  assert.equal(some.signIn, null);
  // proxy up: a live row is not greyed, a disabled one is
  assert.equal(view([acct({})]).cards[0].dim, false);
  assert.equal(view([acct({ disabled: true, ok: false })]).cards[0].dim, true);
});

test('cards: disabled login is greyed "disabled in proxy" with no sign-in', () => {
  const c = view([acct({ disabled: true, ok: false })]).cards[0];
  assert.equal(c.disabled, true);
  assert.equal(c.signIn, null);
  assert.equal(c.error, null);
  assert.ok(c.notes.includes('disabled in proxy'));
});

test('cards: duplicate logins carry a warning', () => {
  const cards = view([acct({ id: 'claude:a@x.com#1', duplicate: true }), acct({ id: 'claude:a@x.com#2', duplicate: true }), acct({ id: 'claude:b@x.com', email: 'b@x.com' })]).cards;
  assert.match(cards[0].warning, /same account as another login in the proxy/i);
  assert.match(cards[1].warning, /same account/i);
  assert.equal(cards[2].warning, null);
});

test('cards: proxy down shows a banner, keeps cached cards stale, offers no sign-in', () => {
  const vm = view([acct({ ok: false, stale: true, error: 'proxy not reachable at http://127.0.0.1:8317 (ECONNREFUSED)' })], { ...proxy, ok: false, error: 'proxy not reachable at http://127.0.0.1:8317 (ECONNREFUSED)' });
  assert.match(vm.banner, /^Proxy not running at http:\/\/127\.0\.0\.1:8317\. Nothing answered on that port/);
  assert.equal(vm.cards[0].stale, true);
  assert.equal(vm.cards[0].signIn, null);
  assert.equal(vm.cards[0].error, null); // said once, in the banner
  assert.equal(view([acct({})]).banner, null);
});

// Fake clock: sleep advances time instead of waiting.
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async ms => { t += ms; }, iso: () => new Date(t).toISOString() };
}

test('watchForLogin: finds a new login once it fetches fine', async () => {
  const c = clock();
  let polls = 0;
  const poll = async () => {
    polls++;
    const accounts = [{ id: 'claude:a@x.com', ok: true, fetchedAt: c.iso() }];
    if (polls >= 2) accounts.push({ id: 'claude:new@x.com', email: 'new@x.com', ok: polls >= 3, fetchedAt: c.iso() });
    return { accounts };
  };
  const r = await watchForLogin({ poll, knownIds: ['claude:a@x.com'], sleep: c.sleep, now: c.now });
  assert.equal(r.found, true);
  assert.equal(r.account.email, 'new@x.com');
  assert.equal(polls, 3);
});

test('watchForLogin: finds the renewed target once it fetches fine after the start', async () => {
  const c = clock();
  const start = c.iso();
  let polls = 0;
  const poll = async () => {
    polls++;
    if (polls === 1) throw new Error('server restarting'); // errors are retried
    // ok but fetched before the watch began: not yet renewed
    if (polls === 2) return { accounts: [{ id: 'claude:a@x.com', ok: true, fetchedAt: start }] };
    return { accounts: [{ id: 'claude:a@x.com', ok: polls >= 4, fetchedAt: c.iso() }] };
  };
  const r = await watchForLogin({ poll, knownIds: ['claude:a@x.com'], targetId: 'claude:a@x.com', sleep: c.sleep, now: c.now });
  assert.equal(r.found, true);
  assert.equal(r.account.id, 'claude:a@x.com');
  assert.equal(polls, 4);
});

test('watchForLogin: gives up after the timeout, polling every interval', async () => {
  const c = clock();
  const start = c.now();
  let polls = 0;
  const poll = async () => { polls++; return { accounts: [{ id: 'claude:a@x.com', ok: false, fetchedAt: c.iso() }] }; };
  const r = await watchForLogin({ poll, knownIds: ['claude:a@x.com'], targetId: 'claude:a@x.com', sleep: c.sleep, now: c.now });
  assert.deepEqual(r, { found: false });
  assert.equal(polls, 120); // 10 min at 5 s
  assert.equal(c.now() - start, 600_000);
});

// Ledger: columns, cells, status and summary.
const win = (label, usedPercent, resetMs) => ({ label, usedPercent, resetsAt: iso(resetMs) });
const ledger = () => view([
  acct({ data: { windows: [win('Session (5h)', 10, 2 * H), win('Weekly', 95, 4 * 24 * H), win('Weekly Fable', 0, 4 * 24 * H)], notes: [], warnings: [] } }),
  acct({ id: 'claude:b@x.com', email: 'b@x.com', ok: false, stale: true, lastGoodAt: iso(-5 * 24 * H), error: 'usage API 401: sign in again',
    data: { windows: [win('Session (5h)', 0, -H), win('Weekly', 100, -2 * H), win('Weekly Opus', 40, 24 * H)], notes: [], warnings: [] } }),
  acct({ id: 'claude:c@x.com', email: 'c@x.com', ok: false, lastGoodAt: null, data: null, error: 'usage API 401: sign in again' }),
  acct({ id: 'claude:off@x.com', email: 'off@x.com', disabled: true, ok: false, stale: true }),
  acct({ id: 'codex:x@x.com', kind: 'codex', email: 'x@x.com', plan: 'ChatGPT Pro Max', data: { windows: [win('Weekly', 52, 5 * 24 * H)], notes: ['2 banked resets'], warnings: [] } }),
]);

test('ledger: columns are Session (5h), Weekly, then other labels in first-seen order', () => {
  const vm = ledger();
  assert.deepEqual(vm.columns, ['Session (5h)', 'Weekly', 'Weekly Fable', 'Weekly Opus']);
  assert.deepEqual(view([]).columns, ['Session (5h)', 'Weekly']);
  for (const c of vm.cards) assert.deepEqual(c.cells.map(x => x.column), vm.columns);
});

test('ledger: live cells say "N% used" with a clock and countdown; a missing window is "—"', () => {
  const vm = ledger();
  const [session, weekly, fable, opus] = vm.cards[0].cells;
  assert.deepEqual([session.pct, session.pctText, session.level, session.missing], [10, '10% used', '', false]);
  assert.match(session.resetText, / · in 2h 0m$/);
  assert.deepEqual([weekly.pct, weekly.pctText, weekly.level], [95, '95% used', 'bad']);
  assert.match(weekly.resetText, /^\S+ .+ · in 4d 0h 0m$/); // "Fri 8:00 AM · in 4d 0h 0m"
  assert.equal(fable.pctText, '0% used');
  assert.deepEqual(opus, { column: 'Weekly Opus', pct: null, pctText: '—', resetText: '', level: '', missing: true });
  const codex = vm.cards.find(c => c.kind === 'codex');
  assert.deepEqual(codex.cells.map(x => x.pctText), ['—', '52% used', '—', '—']);
  assert.deepEqual(vm.cards.find(c => c.id === 'claude:c@x.com').cells.map(x => x.pctText), ['—', '—', '—', '—']);
});

test('ledger: stale cells start with "Last:", passed resets are "current reset unknown" with no percent', () => {
  const vm = ledger();
  const stale = vm.cards.find(c => c.id === 'claude:b@x.com');
  assert.deepEqual(stale.cells.map(x => x.pctText), ['Last: 0%', 'Last: 100%', '—', 'Last: 40%']);
  assert.deepEqual(stale.cells.map(x => x.resetText.startsWith('current reset unknown')), [true, true, false, false]);
  assert.deepEqual(stale.cells.map(x => x.pct), [null, null, null, 40]);
  // a passed reset on a live row too
  const live = view([acct({})]).cards[0].cells.find(x => x.column === 'Weekly');
  assert.deepEqual([live.pct, live.pctText, live.resetText], [null, 'Last: 100%', 'current reset unknown']);
  assert.doesNotMatch(JSON.stringify(vm), /resets now/i);
});

test('ledger: status is Live, As of <age>, Sign-in needed or Disabled in proxy', () => {
  const vm = ledger();
  const status = Object.fromEntries(vm.cards.map(c => [c.id, c.statusText]));
  assert.deepEqual(status, {
    'claude:a@x.com': 'Live', 'claude:b@x.com': 'As of 5d 0h ago', 'claude:c@x.com': 'Sign-in needed', 'claude:off@x.com': 'Disabled in proxy', 'codex:x@x.com': 'Live',
  });
  assert.equal(view([acct({ proxyMessage: 'token expired' })]).cards[0].statusText, 'Sign-in needed');
  assert.deepEqual(vm.cards.find(c => c.id === 'claude:b@x.com').signIn, { url: proxy.panelUrl });
  assert.deepEqual(vm.cards.find(c => c.id === 'claude:c@x.com').signIn, { url: proxy.panelUrl });
  assert.deepEqual(vm.cards.find(c => c.kind === 'codex').notes, ['2 banked resets']);
});

test('ledger: summary states Codex weekly room left and the fullest Claude weekly reset', () => {
  const vm = ledger();
  assert.match(vm.summary, /^Codex has 48% weekly room left\. a@x\.com is at 95% weekly and resets \S.* at \d{1,2}:\d{2}/);
  // nobody at 90%: the soonest live Claude weekly reset
  const calm = view([acct({ data: { windows: [win('Weekly', 20, 3 * 24 * H)], notes: [], warnings: [] } }), acct({ id: 'claude:z@x.com', email: 'z@x.com', data: { windows: [win('Weekly', 30, 24 * H)], notes: [], warnings: [] } })]);
  assert.match(calm.summary, /^z@x\.com resets (tomorrow|today|\S+day) at /);
  // nothing live, odd data: still a plain sentence
  const empty = [view([]), view([acct({ ok: false, data: null })], { ...proxy, ok: false }), view([acct({ data: { windows: [{ label: 'Weekly', usedPercent: undefined, resetsAt: null }], notes: [], warnings: [] } })])];
  for (const v of [vm, calm, ...empty]) {
    assert.equal(typeof v.summary, 'string');
    assert.ok(v.summary.length > 10, v.summary);
    assert.doesNotMatch(v.summary, /undefined|NaN|null/);
  }
  assert.equal(empty[0].summary, 'No account has live numbers right now.');
});

test('ledger: empty text and header meta say "checking" until the first proxy check, then the real state', () => {
  const unchecked = view([], { ok: false, url: proxy.url, error: 'not checked yet', checkedAt: null });
  assert.equal(unchecked.emptyText, 'Checking the proxy for your accounts...');
  assert.equal(unchecked.metaText, 'Checking accounts...');
  // The summary also waits for the first check, with or without cached accounts.
  const cached = view([acct({ ok: false, stale: true, data: { windows: [win('Weekly', 20, 24 * H)], notes: [], warnings: [] } })], { ok: false, url: proxy.url, error: 'not checked yet', checkedAt: null });
  for (const v of [unchecked, cached]) {
    assert.equal(v.summary, 'Checking the proxy for your accounts...');
    assert.doesNotMatch(v.summary, /No account has live numbers/);
  }
  const down = view([], { ...proxy, ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8317' });
  assert.equal(down.emptyText, 'No saved data yet. Start CLIProxyAPI to see your accounts.');
  assert.equal(down.metaText, '0/0 accounts live');
  const none = view([]);
  assert.equal(none.emptyText, 'No Claude or Codex account in the proxy yet. Press Add account to sign one in.');
  assert.equal(none.metaText, '0/0 accounts live');
  // Live counts rows whose status is Live: an ok fetch the proxy flags, a disabled login and a stale row do not count.
  const mixed = view([
    acct({}),
    acct({ id: 'claude:b@x.com', email: 'b@x.com', proxyMessage: 'token expired' }),
    acct({ id: 'claude:c@x.com', email: 'c@x.com', disabled: true }),
    acct({ id: 'claude:d@x.com', email: 'd@x.com', ok: false, stale: true, error: 'usage API 401' }),
  ]);
  assert.deepEqual(mixed.cards.map(c => c.statusText), ['Live', 'Sign-in needed', 'Disabled in proxy', 'As of 1m ago']);
  assert.equal(mixed.metaText, '1/4 accounts live');
});

test('watchForLogin: an ok fetch while the proxy still flags the target is not a sign-in', async () => {
  const c = clock();
  let polls = 0, msg = 'token expired', unavailable = false;
  const poll = async () => {
    polls++;
    if (polls === 3) { msg = ''; unavailable = true; }
    if (polls === 4) unavailable = false;
    return { accounts: [{ id: 'claude:a@x.com', ok: true, proxyMessage: msg, unavailable, fetchedAt: c.iso() }, { id: 'claude:new@x.com', ok: true, proxyMessage: 'token expired', fetchedAt: c.iso() }] };
  };
  const r = await watchForLogin({ poll, knownIds: ['claude:a@x.com'], targetId: 'claude:a@x.com', sleep: c.sleep, now: c.now });
  assert.equal(r.found, true);
  assert.equal(r.account.id, 'claude:a@x.com'); // the flagged new login never counted
  assert.equal(polls, 4);
  assert.equal(r.account.proxyMessage, '');
});

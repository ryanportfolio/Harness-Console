import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TokenScanner, transcriptDirs } from '../usage/tokens.mjs';
import { viewModel, watchForLogin } from '../usage/cards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['https://api.anthropic.com/api/oauth/usage', 'https://api.anthropic.com/api/oauth/profile', 'https://chatgpt.com/backend-api/wham/usage']);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});

const claudeUsage = { five_hour: { utilization: 12, resets_at: '2026-10-13T00:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-10-18T00:00:00Z' } };
const codexUsage = { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 52, limit_window_seconds: 604800, reset_at: 1792296711 }, secondary_window: null }, rate_limit_reset_credits: { available_count: 2 }, credits: { has_credits: true, unlimited: false, balance: '62500.0000000000' } };
const profile = { account: { has_claude_max: true }, organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } };

// Stub CLIProxyAPI management API: checks the Bearer key, serves fixtures, logs every api-call.
function startStub(key, fx, calls, port = 0) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${key}`) return reply(401, { error: 'missing management key' });
      if (req.method === 'GET' && req.url === '/v0/management/auth-files') return reply(200, { files: fx.files });
      if (req.method === 'POST' && req.url === '/v0/management/api-call') {
        // fx.delayMs slows every upstream answer, as a real usage API does.
        const send = (code, obj) => (fx.delayMs ? setTimeout(() => reply(code, obj), fx.delayMs) : reply(code, obj));
        const j = JSON.parse(body);
        const accountKey = Object.keys(j.header ?? {}).find(k => k.toLowerCase() === 'chatgpt-account-id');
        calls.push({ url: j.url, authIndex: j.authIndex, auth: j.header?.Authorization, accountHeader: accountKey ? j.header[accountKey] : undefined });
        // fx.apiError: the proxy itself refuses the call, as when it has no usable token for the login.
        if (fx.apiError?.[j.authIndex]) return send(400, { error: fx.apiError[j.authIndex] });
        const fail = fx.fail[j.authIndex];
        if (fail) return send(200, { status_code: fail, header: fx.failHeader?.[j.authIndex] ?? {}, body: '{"error":"upstream down"}' });
        if (j.url.endsWith('/oauth/profile')) return send(200, { status_code: 200, header: {}, body: JSON.stringify(profile) });
        if (j.url.endsWith('/oauth/usage')) return send(200, { status_code: 200, header: {}, body: JSON.stringify(claudeUsage) });
        if (j.url.endsWith('/wham/usage')) return send(200, { status_code: 200, header: {}, body: codexUsage }); // already-parsed body
        return send(400, { error: 'unexpected url' });
      }
      reply(404, { error: 'not found' });
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function stopStub(server) {
  const closed = new Promise(r => server.close(r));
  server.closeAllConnections();
  return closed;
}

function startTracker(env, output) {
  const child = spawn(process.execPath, [path.join(root, 'usage', 'server.mjs')], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { output.text += d; });
  child.stderr.on('data', d => { output.text += d; });
  return child;
}

async function waitFor(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('tracker reads accounts from a stubbed CLIProxyAPI, keeps stale data, never leaks the key', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-proxy-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  const claudeDir = path.join(tmp, 'claude'), codexDir = path.join(tmp, 'codex');
  for (const d of [proxyDir, stateDir, home, claudeDir, codexDir]) await mkdir(d, { recursive: true });

  // Legacy state: a per-name snapshot and a stray temp file go; pricing.json stays (fresh, so no network fetch).
  await writeFile(path.join(stateDir, 'Claude_1.json'), JSON.stringify({ name: 'Claude 1', kind: 'claude', dir: 'x', ok: true }));
  await writeFile(path.join(stateDir, 'Codex_1.json.usage-dash-tmp.1.2'), '{}');
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: { 'claude-x': { in: 1e-6, out: 1e-6, cr: 1e-7, cw: 1e-6 } } }));
  // ~/.claude-2 is scanned for transcripts.
  await mkdir(path.join(home, '.claude-2', 'projects', 'p'), { recursive: true });
  await writeFile(path.join(home, '.claude-2', 'projects', 'p', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'r1', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n');

  const fx = {
    files: [
      { provider: 'claude', email: 'Alice@Example.com', label: 'alice', name: 'a.json', auth_index: 'ca', disabled: false, status: 'active', status_message: '', unavailable: false },
      { provider: 'claude', email: 'zed@example.com', label: 'zed', name: 'z.json', auth_index: 'cz', disabled: true, status: 'disabled', status_message: 'off', unavailable: false },
      { provider: 'codex', email: 'bob@example.com', label: 'bob', name: 'b.json', auth_index: 'xb', disabled: false, status: 'active', status_message: '', unavailable: false, id_token: { plan_type: 'pro', chatgpt_account_id: 'acct-bob-1' } },
      { provider: 'codex', email: 'dup@example.com', name: 'd1.json', auth_index: 'd1', disabled: false, status: 'active' },
      { provider: 'codex', email: 'DUP@example.com', name: 'd2.json', auth_index: 'd2', disabled: false, status: 'active' },
      { provider: 'gemini', email: 'g@example.com', name: 'g.json', auth_index: 'g1', disabled: false, status: 'active' },
    ],
    fail: {},
  };
  const calls = [];
  let stub = await startStub(key, fx, calls);
  const stubPort = stub.address().port;
  await writeFile(path.join(proxyDir, 'config.yaml'), `# test\nhost: "127.0.0.1"\nport: ${stubPort}\nremote-management:\n  port: 1\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), `${key}\r\n`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, USERPROFILE: home, HOME: home };
  const output = { text: '' };
  let child = startTracker(env, output);
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const bodies = [];
  const usage = async () => { const text = await (await fetch(`${base}/api/usage`)).text(); bodies.push(text); return JSON.parse(text); };
  const refresh = async () => {
    const r = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } });
    assert.equal(r.status, 204);
  };
  const byId = (u, id) => u.accounts.find(a => a.id === id);

  // 1. Startup poll lists claude/codex logins with emails, plans and windows.
  let u = await waitFor(async () => { const j = await usage(); return j.proxy.ok && j.accounts.length && j.accounts.filter(a => !a.disabled).every(a => a.fetchedAt) && j; }, 'first poll');
  assert.equal(u.proxy.url, `http://127.0.0.1:${stubPort}`);
  assert.equal(u.proxy.panelUrl, `http://127.0.0.1:${stubPort}/management.html#/oauth`);
  assert.equal(u.proxy.error, null);
  assert.deepEqual(u.accounts.map(a => a.id), ['claude:ca', 'claude:cz', 'codex:xb', 'codex:d1', 'codex:d2']);
  const alice = byId(u, 'claude:ca');
  assert.equal(alice.ok, true);
  assert.equal(alice.stale, false);
  assert.equal(alice.email, 'Alice@Example.com');
  assert.equal(alice.label, 'alice');
  assert.equal(alice.plan, 'Claude Max 20x');
  assert.deepEqual(alice.data.windows.map(w => [w.label, w.usedPercent]), [['Session (5h)', 12], ['Weekly', 40]]);
  const bob = byId(u, 'codex:xb');
  assert.equal(bob.ok, true);
  assert.equal(bob.plan, 'ChatGPT Pro');
  assert.equal(bob.data.windows[0].usedPercent, 52);
  // The live body's balance is a decimal string with no currency field: a count, not dollars.
  assert.deepEqual(bob.data.notes, ['Credits: 62,500', '2 banked resets']);
  assert.equal(byId(u, 'codex:d1').duplicate, true);
  assert.equal(byId(u, 'codex:d2').duplicate, true);
  assert.equal(bob.duplicate, false);

  // 2. A disabled login is listed but never sent to api-call.
  const zed = byId(u, 'claude:cz');
  assert.equal(zed.disabled, true);
  assert.equal(zed.ok, false);
  assert.equal(zed.error, null);
  assert.equal(zed.proxyStatus, 'disabled');
  assert.equal(zed.proxyMessage, 'off');
  assert(calls.every(c => c.authIndex !== 'cz' && c.authIndex !== 'g1'), 'disabled and non-claude/codex logins never reach api-call');
  assert(calls.every(c => c.auth === 'Bearer $TOKEN$'), 'the proxy supplies the token');
  // Codex usage calls name the login's ChatGPT account when the proxy knows it; Claude calls never do.
  const codexUsageCalls = idx => calls.filter(c => c.authIndex === idx && c.url.endsWith('/wham/usage'));
  assert(codexUsageCalls('xb').length > 0);
  for (const c of codexUsageCalls('xb')) assert.equal(c.accountHeader, 'acct-bob-1');
  assert(codexUsageCalls('d1').length > 0);
  for (const c of [...codexUsageCalls('d1'), ...codexUsageCalls('d2')]) assert.equal(c.accountHeader, undefined, 'no account id, no header');
  assert(calls.some(c => c.url.includes('anthropic.com')));
  for (const c of calls.filter(c => c.url.includes('anthropic.com'))) assert.equal(c.accountHeader, undefined, 'Claude calls carry no chatgpt-account-id');

  // Legacy snapshot files gone, pricing kept; ~/.claude-2 transcripts counted.
  const left = await readdir(stateDir);
  // Only the stray temp file planted above: the running tracker's own cache write can briefly hold a fresh one.
  assert(!left.includes('Claude_1.json') && !left.includes('Codex_1.json.usage-dash-tmp.1.2'), left.join(','));
  assert(left.includes('pricing.json'));
  const tokens = await waitFor(async () => { const j = await (await fetch(`${base}/api/tokens?days=7`)).json(); return j.providers[0].total && j; }, 'token scan');
  assert.equal(tokens.providers[0].total, 150);
  assert(tokens.providers[0].dirs.includes(path.join(home, '.claude-2')));

  // 3. An api-call failure after a success keeps the data, marked stale. A healthy login fetched
  // under a minute ago is not re-fetched, so the proxy flags this one first.
  fx.fail.ca = 500;
  fx.files[0].status_message = 'token expired';
  await refresh();
  u = await usage();
  const aliceStale = byId(u, 'claude:ca');
  assert.equal(aliceStale.ok, false);
  assert.equal(aliceStale.stale, true);
  assert.equal(aliceStale.lastGoodAt, alice.lastGoodAt);
  assert(aliceStale.lastGoodAt);
  assert.match(aliceStale.error, /usage API 500/);
  assert.equal(aliceStale.data.windows.length, 2);
  delete fx.fail.ca;
  fx.files[0].status_message = '';

  // 4. A login removed from auth-files disappears from /api/usage and from the cache.
  fx.files = fx.files.filter(f => f.auth_index !== 'xb');
  await refresh();
  u = await usage();
  assert.equal(byId(u, 'codex:xb'), undefined);
  assert.equal(byId(u, 'claude:ca').ok, true);
  const cache = await readFile(path.join(stateDir, 'usage-cache.json'), 'utf8');
  assert(!cache.includes('bob@example.com') && cache.includes('Alice@Example.com'));

  // 5. Proxy down: proxy.ok false, cached accounts kept and marked stale with the error.
  await stopStub(stub);
  await refresh();
  u = await usage();
  assert.equal(u.proxy.ok, false);
  assert.match(u.proxy.error, /not reachable/);
  assert.equal(u.accounts.length, 4);
  for (const a of u.accounts) { assert.equal(a.ok, false); assert.equal(a.stale, true); assert.equal(a.error, u.proxy.error); }
  assert.equal(byId(u, 'claude:ca').data.windows.length, 2);

  // 6. Restart with the proxy still down: the cache file brings the accounts back.
  child.kill();
  await new Promise(r => child.once('exit', r));
  child = startTracker(env, output);
  u = await waitFor(async () => { const j = await usage(); return j.proxy.checkedAt && j; }, 'restart poll');
  assert.equal(u.proxy.ok, false);
  assert.equal(byId(u, 'claude:ca').data.windows.length, 2);
  assert.equal(byId(u, 'claude:ca').stale, true);

  // 7. Wrong key: the proxy answers 401 and the error says so without echoing the key.
  stub = await startStub('other-key', fx, calls, stubPort);
  await refresh();
  u = await usage();
  assert.equal(u.proxy.ok, false);
  assert.match(u.proxy.error, /401/);

  // The key never leaves the tracker; only allowlisted upstream URLs went through api-call.
  child.kill();
  await new Promise(r => child.once('exit', r));
  for (const b of bodies) assert(!b.includes(key), 'key in /api/usage body');
  assert(!output.text.includes(key), 'key in tracker output');
  assert(calls.length > 0);
  for (const c of calls) assert(ALLOWED.has(c.url), `api-call url not allowlisted: ${c.url}`);
});

test('two quick refreshes do not re-fetch a healthy login but do fetch a newly added one', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-throttle-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  for (const d of [proxyDir, stateDir, home, path.join(tmp, 'claude'), path.join(tmp, 'codex')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  const fx = { files: [{ provider: 'claude', email: 'a@example.com', name: 'a.json', auth_index: 'ca', disabled: false, status: 'active', status_message: '', unavailable: false }], fail: {} };
  const calls = [];
  const stub = await startStub(key, fx, calls);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const usage = async () => (await fetch(`${base}/api/usage`)).json();
  const refresh = async () => assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } })).status, 204);
  const usageCalls = idx => calls.filter(c => c.authIndex === idx && c.url.endsWith('/usage')).length;

  const first = await waitFor(async () => { const j = await usage(); return j.accounts[0]?.ok && j; }, 'first poll');
  assert.equal(usageCalls('ca'), 1);
  fx.files.push({ provider: 'codex', email: 'b@example.com', name: 'b.json', auth_index: 'xb', disabled: false, status: 'active', status_message: '', unavailable: false, id_token: { plan_type: 'promax' } });
  await refresh();
  await refresh();
  const u = await usage();
  assert.equal(usageCalls('ca'), 1, 'healthy login fetched under a minute ago is not fetched again');
  assert.equal(u.accounts.find(a => a.id === 'claude:ca').fetchedAt, first.accounts[0].fetchedAt);
  assert.equal(usageCalls('xb'), 1, 'new login fetched once, then left alone');
  const b = u.accounts.find(a => a.id === 'codex:xb');
  assert.equal(b.ok, true);
  assert.equal(b.plan, 'ChatGPT Pro Max');
  // A login the proxy flags is fetched again on the next refresh.
  fx.files[0].status_message = 'token expired';
  await refresh();
  assert.equal(usageCalls('ca'), 2);
  assert.equal((await usage()).accounts.find(a => a.id === 'claude:ca').proxyMessage, 'token expired');
});

test('a slow usage API never shows a checked proxy with an unfilled account list', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-slow-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  for (const d of [proxyDir, stateDir, home, path.join(tmp, 'claude'), path.join(tmp, 'codex')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  const fx = {
    files: [
      { provider: 'claude', email: 'a@example.com', name: 'a.json', auth_index: 'ca', disabled: false, status: 'active', status_message: '', unavailable: false },
      { provider: 'codex', email: 'b@example.com', name: 'b.json', auth_index: 'xb', disabled: false, status: 'active', status_message: '', unavailable: false, id_token: { plan_type: 'pro' } },
    ],
    fail: {},
    delayMs: 1500,
  };
  const stub = await startStub(key, fx, []);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const usage = async () => (await fetch(`${base}/api/usage`)).json();

  // First poll: sample every 100 ms until both logins have numbers.
  const samples = [];
  const done = await waitFor(async () => {
    const j = await usage();
    samples.push(j);
    return j.accounts.length === 2 && j.accounts.every(a => a.fetchedAt) && j;
  }, 'first poll');
  const bad = samples.filter(j => j.proxy.ok && j.proxy.checkedAt && j.accounts.length === 0);
  assert.equal(bad.length, 0, `${bad.length} of ${samples.length} samples showed a checked proxy with no accounts`);
  assert(samples.some(j => !j.proxy.checkedAt), 'some samples landed before the first check finished');
  assert.equal(done.proxy.ok, true);

  // A later slow poll keeps the previous accounts and check time until the new list is ready.
  fx.files.push({ provider: 'claude', email: 'c@example.com', name: 'c.json', auth_index: 'cc', disabled: false, status: 'active', status_message: '', unavailable: false });
  const refreshed = fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } });
  const later = [];
  const after = await waitFor(async () => {
    const j = await usage();
    later.push(j);
    return j.accounts.length === 3 && j;
  }, 'second poll');
  assert.equal((await refreshed).status, 204);
  for (const j of later) {
    if (j.accounts.length === 3) continue;
    assert.equal(j.accounts.length, 2, 'previous accounts stay visible during a poll');
    assert.equal(j.proxy.checkedAt, done.proxy.checkedAt, 'check time moves only with the new account list');
  }
  assert(after.proxy.checkedAt > done.proxy.checkedAt);
  assert(after.accounts.find(a => a.id === 'claude:cc').fetchedAt);
});

test('refresh answers while a token scan is still running, and /api/tokens says it is scanning', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-scan-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  const claudeDir = path.join(tmp, 'claude'), codexDir = path.join(tmp, 'codex');
  for (const d of [proxyDir, stateDir, home, claudeDir, codexDir]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  // Enough transcript files that a cold scan takes seconds.
  const FILES = 4000;
  const line = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n';
  for (let p = 0; p < FILES / 500; p++) {
    const dir = path.join(claudeDir, 'projects', `p${p}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 500 }, (_, i) => writeFile(path.join(dir, `s${i}.jsonl`), line)));
  }
  const fx = { files: [{ provider: 'claude', email: 'a@example.com', name: 'a.json', auth_index: 'ca', disabled: false, status: 'active', status_message: '', unavailable: false }], fail: {} };
  const stub = await startStub(key, fx, []);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const tokens = async () => (await fetch(`${base}/api/tokens?days=7`)).json();

  // The startup scan begins before the server listens, so the first answer finds it running.
  const first = await waitFor(tokens, 'tracker up');
  assert.equal(first.scanning, true);
  const r = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } });
  assert.equal(r.status, 204);
  const during = await tokens();
  assert.equal(during.scanning, true, 'refresh answered before the token scan finished');
  assert(during.providers[0].files < FILES, `scan not finished yet (${during.providers[0].files} files)`);
  // The scan the refresh asked for is the running one; it finishes with every file counted.
  const done = await waitFor(async () => { const j = await tokens(); return !j.scanning && j; }, 'scan end', 45000);
  assert.equal(done.providers[0].files, FILES);
  assert.equal(done.providers[0].total, FILES * 2);
});

test('a login keeps its id, numbers and lastGoodAt when its same-email twin goes; a 429 stores retryAt, not a frozen countdown', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-twin-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  for (const d of [proxyDir, stateDir, home, path.join(tmp, 'claude'), path.join(tmp, 'codex')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  const fx = {
    files: [
      { provider: 'claude', email: 'twin@example.com', name: 't1.json', auth_index: 't1', disabled: false, status: 'active', status_message: '', unavailable: false },
      { provider: 'claude', email: 'Twin@example.com', name: 't2.json', auth_index: 't2', disabled: false, status: 'active', status_message: '', unavailable: false },
      { provider: 'codex', email: 'busy@example.com', name: 'r.json', auth_index: 'r1', disabled: false, status: 'active', status_message: '', unavailable: false },
    ],
    fail: { r1: 429 },
    failHeader: { r1: { 'Retry-After': ['120'] } },
  };
  const calls = [];
  const stub = await startStub(key, fx, calls);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const usage = async () => (await fetch(`${base}/api/usage`)).json();
  const refresh = async () => assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } })).status, 204);
  const byId = (u, id) => u.accounts.find(a => a.id === id);

  const before = Date.now();
  const first = await waitFor(async () => { const j = await usage(); return j.accounts.length === 3 && j.accounts.every(a => a.fetchedAt) && j; }, 'first poll');
  // Found by auth_index, not by id format, so the old email-based ids fail on the id change itself.
  const survivor = first.accounts.find(a => a.kind === 'claude' && a.id.endsWith('t1'));
  const twin = first.accounts.find(a => a.kind === 'claude' && a.id.endsWith('t2'));
  assert.equal(survivor.ok, true);
  assert.equal(survivor.duplicate, true);
  assert.equal(twin.duplicate, true);
  assert(survivor.lastGoodAt);

  // The 429: a flag and a timestamp from Retry-After; the error text holds no seconds count.
  const busy = first.accounts.find(a => a.kind === 'codex');
  assert.equal(busy.ok, false);
  assert.equal(busy.rateLimited, true);
  const retryAt = Date.parse(busy.retryAt);
  assert(retryAt >= before + 119_000 && retryAt <= Date.now() + 121_000, busy.retryAt);
  assert.doesNotMatch(busy.error, /\d+\s*s\b|retrying in/);
  assert.equal(survivor.rateLimited, false);

  // The twin goes and the survivor's fetch fails. The proxy flags it so the under-a-minute skip does not apply.
  fx.files = fx.files.filter(f => f.auth_index !== 't2');
  fx.files[0].status_message = 'token expired';
  fx.fail.t1 = 500;
  await refresh();
  const u = await usage();
  const after = byId(u, survivor.id);
  assert(after, `survivor id changed: ${u.accounts.map(a => a.id).join(',')}`);
  assert.equal(after.ok, false);
  assert.equal(after.stale, true);
  assert.equal(after.duplicate, false);
  assert.equal(after.lastGoodAt, survivor.lastGoodAt);
  assert.deepEqual(after.data, survivor.data);
  const cache = JSON.parse(await readFile(path.join(stateDir, 'usage-cache.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache.accounts), [survivor.id]);
  assert.equal(cache.accounts[survivor.id].lastGoodAt, survivor.lastGoodAt);
  assert.deepEqual(cache.accounts[survivor.id].data, survivor.data);

  // Still parked: the same retryAt, and no second call to the usage API.
  assert.equal(byId(u, busy.id).retryAt, busy.retryAt);
  assert.equal(calls.filter(c => c.authIndex === 'r1').length, 1);
});

test('transcript dirs: the CLI default dirs are scanned even before they exist, and counted once they appear', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-dirs-test-'));
  t.after(() => rm(tmp, { recursive: true, force: true }).catch(() => {}));
  const home = path.join(tmp, 'home');
  await mkdir(path.join(home, '.claude-3'), { recursive: true });
  // Neither ~/.claude nor ~/.codex exists; a numbered dir that does is kept, one that does not is never listed.
  assert.deepEqual(await transcriptDirs({ USERPROFILE: home }), [
    { kind: 'claude', dir: path.join(home, '.claude') },
    { kind: 'claude', dir: path.join(home, '.claude-3') },
    { kind: 'codex', dir: path.join(home, '.codex') },
  ]);
  const claudeEnv = path.join(tmp, 'later-claude'), codexEnv = path.join(tmp, 'later-codex');
  assert.deepEqual(await transcriptDirs({ USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeEnv, CODEX_HOME: codexEnv }), [
    { kind: 'claude', dir: claudeEnv },
    { kind: 'claude', dir: path.join(home, '.claude-3') },
    { kind: 'codex', dir: codexEnv },
  ]);

  const logs = [];
  const writeAtomic = (file, text) => writeFile(file, text);
  const s = new TokenScanner({ name: 'claude later', kind: 'claude', dir: claudeEnv }, path.join(tmp, 'cache.json'), writeAtomic, m => logs.push(m));
  await s.load();
  await s.scan();
  assert.equal(s.summary(7, null).files, 0);
  assert.equal(s.summary(7, null).total, 0);
  await mkdir(path.join(claudeEnv, 'projects', 'p'), { recursive: true });
  await writeFile(path.join(claudeEnv, 'projects', 'p', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: 'r1', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n');
  await s.scan();
  assert.equal(s.summary(7, null).files, 1);
  assert.equal(s.summary(7, null).total, 10);
  assert.deepEqual(logs.filter(m => /error|ENOENT/i.test(m)), []);
});

test('a cooldown flag keeps a login Live and inside the 60 s skip; an auth-failure flag reads Sign-in needed', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-cooldown-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  for (const d of [proxyDir, stateDir, home, path.join(tmp, 'claude'), path.join(tmp, 'codex')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  // The fields CLIProxyAPI v8.0.15 lists for a 429 cooldown and for a rejected credential.
  const later = new Date(Date.now() + 30 * 60_000).toISOString();
  const cooldown = auth_index => ({ provider: 'claude', email: `${auth_index}@example.com`, name: `${auth_index}.json`, auth_index, disabled: false, status: 'error', status_message: 'quota exhausted', unavailable: true, next_retry_after: later, cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: later, remaining_seconds: 1800, http_status: 429 }] });
  const rejected = auth_index => ({ provider: 'claude', email: `${auth_index}@example.com`, name: `${auth_index}.json`, auth_index, disabled: false, status: 'error', status_message: 'unauthorized', unavailable: true, next_retry_after: later, cooldowns: [{ scope: 'credential', reason: 'unauthorized', retry_at: later, remaining_seconds: 1800, http_status: 401 }] });
  const fx = { files: [cooldown('cd'), rejected('au')], fail: {} };
  const calls = [];
  const stub = await startStub(key, fx, calls);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const usage = async () => (await fetch(`${base}/api/usage`)).json();
  const refresh = async () => assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } })).status, 204);
  const usageCalls = idx => calls.filter(c => c.authIndex === idx && c.url.endsWith('/usage')).length;
  // Before both fixture reset times, so the numbers read as current whatever today's date is.
  const vmAt = Date.parse('2026-10-12T00:00:00Z');

  await waitFor(async () => { const j = await usage(); return j.accounts.length === 2 && j.accounts.every(a => a.ok) && j; }, 'first poll');
  await refresh();
  await refresh();
  assert.equal(usageCalls('cd'), 1, 'a cooldown-flagged login fetched under a minute ago is not fetched again');
  assert.equal(usageCalls('au'), 3, 'a login with a rejected credential is fetched on every refresh');

  const vm = viewModel(await usage(), vmAt);
  const cd = vm.cards.find(c => c.id === 'claude:cd'), au = vm.cards.find(c => c.id === 'claude:au');
  assert.equal(cd.statusText, 'Live');
  assert.equal(cd.signIn, null);
  assert.deepEqual(cd.cells.map(x => x.pctText), ['12% used', '40% used']);
  assert.match(cd.error, /Proxy says: quota exhausted/);
  assert.equal(au.statusText, 'Sign-in needed');
  assert.deepEqual(au.signIn, { url: `http://127.0.0.1:${stub.address().port}/management.html#/oauth` });

  // The sign-in watch, as the page runs it: a new login under a cooldown counts, one with a rejected credential does not.
  const poll = async () => { await refresh(); return usage(); };
  fx.files.push(cooldown('cn'));
  const added = await watchForLogin({ poll, knownIds: ['claude:cd', 'claude:au'], intervalMs: 50, timeoutMs: 10_000 });
  assert.equal(added.found, true);
  assert.equal(added.account.id, 'claude:cn');
  fx.files.push(rejected('an'));
  const waited = await watchForLogin({ poll, knownIds: ['claude:cd', 'claude:au', 'claude:cn'], intervalMs: 50, timeoutMs: 1500 });
  assert.deepEqual(waited, { found: false });
  assert(usageCalls('an') >= 2, 'the rejected login was fetched while the watch waited');
  assert.equal(usageCalls('cd'), 1, 'the watch never re-fetched the cooldown-flagged login inside its minute');
});

test('a usage API 403 or a token the proxy cannot refresh reads as a rejected credential; another failure with no numbers does not', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-403-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  for (const d of [proxyDir, stateDir, home, path.join(tmp, 'claude'), path.join(tmp, 'codex')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  const login = (auth_index) => ({ provider: 'claude', email: `${auth_index}@example.com`, name: `${auth_index}.json`, auth_index, disabled: false, status: 'active', status_message: '', unavailable: false });
  const fx = { files: [login('cf'), login('ce'), login('ct')], fail: { cf: 403, ce: 500 }, apiError: { ct: 'auth token refresh failed' } };
  const stub = await startStub(key, fx, []);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const u = await waitFor(async () => { const j = await (await fetch(`${base}/api/usage`)).json(); return j.accounts.length === 3 && j.accounts.every(a => a.fetchedAt) && j; }, 'first poll');
  const vm = viewModel(u);
  const forbidden = vm.cards.find(c => c.id === 'claude:cf'), down = vm.cards.find(c => c.id === 'claude:ce');
  assert.equal(forbidden.statusText, 'Sign-in needed');
  assert(forbidden.signIn);
  assert.match(forbidden.error, /usage API 403/);
  // The proxy cannot refresh the login's token: also a sign-in.
  const noToken = vm.cards.find(c => c.id === 'claude:ct');
  assert.equal(noToken.statusText, 'Sign-in needed');
  assert(noToken.signIn);
  assert.equal(down.statusText, 'Fetch failed');
  assert.equal(down.signIn, null);
});

test('a usage API 401 through api-call reads Sign-in needed, and the next good fetch clears it', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-401-test-'));
  const key = randomBytes(24).toString('hex');
  const proxyDir = path.join(tmp, 'proxy'), stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  for (const d of [proxyDir, stateDir, home, path.join(tmp, 'claude'), path.join(tmp, 'codex')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  // The proxy reports nothing wrong with the login: only the usage API's 401 says the token was rejected.
  const login = { provider: 'claude', email: 'cu@example.com', name: 'cu.json', auth_index: 'cu', disabled: false, status: 'active', status_message: '', unavailable: false };
  const fx = { files: [login], fail: { cu: 401 } };
  const calls = [];
  const stub = await startStub(key, fx, calls);
  await writeFile(path.join(proxyDir, 'config.yaml'), `port: ${stub.address().port}\n`);
  await writeFile(path.join(proxyDir, 'dashboard-key.txt'), key);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: proxyDir, USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), USERPROFILE: home, HOME: home }, { text: '' });
  t.after(async () => {
    child.kill();
    await stopStub(stub);
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const usage = async () => (await fetch(`${base}/api/usage`)).json();
  // Before both fixture reset times, so the numbers read as current whatever today's date is.
  const vmAt = Date.parse('2026-10-12T00:00:00Z');

  const u = await waitFor(async () => { const j = await usage(); return j.accounts.length === 1 && j.accounts[0].fetchedAt && j; }, 'first poll');
  assert(calls.some(c => c.authIndex === 'cu' && c.url.endsWith('/oauth/usage')), 'the usage API was called through api-call');
  assert.equal(u.accounts[0].authRejected, true);
  const rejected = viewModel(u, vmAt).cards[0];
  assert.equal(rejected.statusText, 'Sign-in needed');
  assert.deepEqual(rejected.signIn, { url: `http://127.0.0.1:${stub.address().port}/management.html#/oauth` });
  assert.match(rejected.error, /usage API 401/);

  // The user signed in again: the usage API answers 200 and the next refresh clears the flag.
  delete fx.fail.cu;
  assert.equal((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { origin: base, 'x-usage-request': '1' } })).status, 204);
  const after = await usage();
  assert.equal(after.accounts[0].ok, true);
  assert.equal(after.accounts[0].authRejected, false);
  const cleared = viewModel(after, vmAt).cards[0];
  assert.equal(cleared.statusText, 'Live');
  assert.equal(cleared.signIn, null);
  assert.deepEqual(cleared.cells.map(x => x.pctText), ['12% used', '40% used']);
});

test('saved token records of a deleted numbered dir still count in /api/tokens', async t => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'usage-gone-test-'));
  const stateDir = path.join(tmp, 'state'), home = path.join(tmp, 'home');
  const claudeDir = path.join(tmp, 'claude'), codexDir = path.join(tmp, 'codex');
  for (const d of [stateDir, path.join(stateDir, 'tokens'), home, claudeDir, codexDir, path.join(tmp, 'proxy')]) await mkdir(d, { recursive: true });
  await writeFile(path.join(stateDir, 'pricing.json'), JSON.stringify({ fetchedAt: Date.now(), rates: {} }));
  const stamp = new Date().toISOString();
  // ~/.claude-2 and ~/.codex-3 each hold one transcript; the real scanner caches them under the server's file names.
  const gone = { claude: path.join(home, '.claude-2'), codex: path.join(home, '.codex-3') };
  await mkdir(path.join(gone.claude, 'projects', 'p'), { recursive: true });
  await writeFile(path.join(gone.claude, 'projects', 'p', 's.jsonl'), JSON.stringify({ type: 'assistant', timestamp: stamp, requestId: 'r1', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 100, output_tokens: 50 } } }) + '\n');
  await mkdir(path.join(gone.codex, 'sessions', '2026'), { recursive: true });
  await writeFile(path.join(gone.codex, 'sessions', '2026', 'r.jsonl'), [
    { type: 'session_meta', timestamp: stamp, payload: { id: 's1' } },
    { type: 'turn_context', timestamp: stamp, payload: { model: 'gpt-x' } },
    { type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  const writeAtomic = (file, text) => writeFile(file, text);
  const cacheFile = (kind, dir) => path.join(stateDir, 'tokens', `${kind}-${dir.replace(/[^\w.-]+/g, '_')}.json`);
  for (const kind of ['claude', 'codex']) {
    const s = new TokenScanner({ name: kind, kind, dir: gone[kind] }, cacheFile(kind, gone[kind]), writeAtomic, () => {});
    await s.scan();
    assert.equal(s.summary(7, null).total, kind === 'claude' ? 150 : 120);
  }
  // A cache written before caches stored their kind and dir: only its transcript paths say where it came from.
  const legacy = JSON.parse(await readFile(cacheFile('codex', gone.codex), 'utf8'));
  delete legacy.kind; delete legacy.dir;
  await writeFile(cacheFile('codex', gone.codex), JSON.stringify(legacy));
  await rm(gone.claude, { recursive: true, force: true });
  await rm(gone.codex, { recursive: true, force: true });

  const port = await freePort();
  const output = { text: '' };
  const child = startTracker({ USAGE_PORT: String(port), USAGE_PROXY_DIR: path.join(tmp, 'proxy'), USAGE_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir, USERPROFILE: home, HOME: home }, output);
  t.after(async () => {
    child.kill();
    await new Promise(r => setTimeout(r, 300));
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });
  const tokens = await waitFor(async () => { const j = await (await fetch(`http://127.0.0.1:${port}/api/tokens?days=7`)).json(); return !j.scanning && j.providers.every(p => p.lastScanAt) && j; }, 'token scan');
  const [claude, codex] = tokens.providers;
  assert.equal(claude.total, 150);
  assert.equal(codex.total, 120);
  assert(claude.dirs.includes(gone.claude), claude.dirs.join(','));
  assert(codex.dirs.includes(gone.codex), codex.dirs.join(','));
  assert.doesNotMatch(output.text, /tokens:.*(ENOENT|failed)/i);
});

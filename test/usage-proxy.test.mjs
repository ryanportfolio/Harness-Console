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
        calls.push({ url: j.url, authIndex: j.authIndex, auth: j.header?.Authorization });
        const fail = fx.fail[j.authIndex];
        if (fail) return send(200, { status_code: fail, header: {}, body: '{"error":"upstream down"}' });
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
      { provider: 'codex', email: 'bob@example.com', label: 'bob', name: 'b.json', auth_index: 'xb', disabled: false, status: 'active', status_message: '', unavailable: false, id_token: { plan_type: 'pro' } },
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
  assert.deepEqual(u.accounts.map(a => a.id), ['claude:alice@example.com', 'claude:zed@example.com', 'codex:bob@example.com', 'codex:dup@example.com#d1', 'codex:dup@example.com#d2']);
  const alice = byId(u, 'claude:alice@example.com');
  assert.equal(alice.ok, true);
  assert.equal(alice.stale, false);
  assert.equal(alice.email, 'Alice@Example.com');
  assert.equal(alice.label, 'alice');
  assert.equal(alice.plan, 'Claude Max 20x');
  assert.deepEqual(alice.data.windows.map(w => [w.label, w.usedPercent]), [['Session (5h)', 12], ['Weekly', 40]]);
  const bob = byId(u, 'codex:bob@example.com');
  assert.equal(bob.ok, true);
  assert.equal(bob.plan, 'ChatGPT Pro');
  assert.equal(bob.data.windows[0].usedPercent, 52);
  // The live body's balance is a decimal string with no currency field: a count, not dollars.
  assert.deepEqual(bob.data.notes, ['Credits: 62,500', '2 banked resets']);
  assert.equal(byId(u, 'codex:dup@example.com#d1').duplicate, true);
  assert.equal(byId(u, 'codex:dup@example.com#d2').duplicate, true);
  assert.equal(bob.duplicate, false);

  // 2. A disabled login is listed but never sent to api-call.
  const zed = byId(u, 'claude:zed@example.com');
  assert.equal(zed.disabled, true);
  assert.equal(zed.ok, false);
  assert.equal(zed.error, null);
  assert.equal(zed.proxyStatus, 'disabled');
  assert.equal(zed.proxyMessage, 'off');
  assert(calls.every(c => c.authIndex !== 'cz' && c.authIndex !== 'g1'), 'disabled and non-claude/codex logins never reach api-call');
  assert(calls.every(c => c.auth === 'Bearer $TOKEN$'), 'the proxy supplies the token');

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
  const aliceStale = byId(u, 'claude:alice@example.com');
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
  assert.equal(byId(u, 'codex:bob@example.com'), undefined);
  assert.equal(byId(u, 'claude:alice@example.com').ok, true);
  const cache = await readFile(path.join(stateDir, 'usage-cache.json'), 'utf8');
  assert(!cache.includes('bob@example.com') && cache.includes('alice@example.com'));

  // 5. Proxy down: proxy.ok false, cached accounts kept and marked stale with the error.
  await stopStub(stub);
  await refresh();
  u = await usage();
  assert.equal(u.proxy.ok, false);
  assert.match(u.proxy.error, /not reachable/);
  assert.equal(u.accounts.length, 4);
  for (const a of u.accounts) { assert.equal(a.ok, false); assert.equal(a.stale, true); assert.equal(a.error, u.proxy.error); }
  assert.equal(byId(u, 'claude:alice@example.com').data.windows.length, 2);

  // 6. Restart with the proxy still down: the cache file brings the accounts back.
  child.kill();
  await new Promise(r => child.once('exit', r));
  child = startTracker(env, output);
  u = await waitFor(async () => { const j = await usage(); return j.proxy.checkedAt && j; }, 'restart poll');
  assert.equal(u.proxy.ok, false);
  assert.equal(byId(u, 'claude:alice@example.com').data.windows.length, 2);
  assert.equal(byId(u, 'claude:alice@example.com').stale, true);

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
  assert.equal(u.accounts.find(a => a.id === 'claude:a@example.com').fetchedAt, first.accounts[0].fetchedAt);
  assert.equal(usageCalls('xb'), 1, 'new login fetched once, then left alone');
  const b = u.accounts.find(a => a.id === 'codex:b@example.com');
  assert.equal(b.ok, true);
  assert.equal(b.plan, 'ChatGPT Pro Max');
  // A login the proxy flags is fetched again on the next refresh.
  fx.files[0].status_message = 'token expired';
  await refresh();
  assert.equal(usageCalls('ca'), 2);
  assert.equal((await usage()).accounts.find(a => a.id === 'claude:a@example.com').proxyMessage, 'token expired');
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
  assert(after.accounts.find(a => a.id === 'claude:c@example.com').fetchedAt);
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

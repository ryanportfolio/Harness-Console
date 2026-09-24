import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { launchHarnessConsole, parseListeningPid, isTrackerCommandLine } from '../launcher.mjs';

const close = server => new Promise(resolve => server.close(resolve));

test('launcher starts when down and repeated launches preserve an active clone', async t => {
  let finishClone;
  const clonePending = new Promise(resolve => { finishClone = resolve; });
  const opened = [];
  const first = await launchHarnessConsole({ port: 0, open: url => opened.push(url), createServer: () => createApp({
    adapter: { account: async () => ({ connected: true }), repositories: async () => [{ id: 'owner/repo' }] },
    clone: () => clonePending,
    // No preference file is written while this test keeps its fake clone pending.
  }) });
  t.after(() => close(first.server));
  assert.equal(first.reused, false);
  const state = await (await fetch(first.origin + '/api/status')).json();
  await fetch(first.origin + '/api/repos');
  await fetch(first.origin + '/api/clone', { method: 'POST', headers: { Origin: first.origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': state.token }, body: JSON.stringify({ id: 'owner/repo' }) });
  const port = first.server.address().port;
  const repeats = await Promise.all(Array.from({ length: 3 }, () => launchHarnessConsole({ port, open: url => opened.push(url) })));
  assert(repeats.every(result => result.reused && result.server === null));
  assert.deepEqual(opened, Array(4).fill(first.origin));
  const { job } = await (await fetch(first.origin + '/api/job')).json();
  assert.equal(job.status, 'running');
  assert.equal(job.id, 'owner/repo');
  // A pending promise alone does not hold Node open, and avoids writing preferences.
  void finishClone;
});

test('launcher replaces an idle instance with a fresh server on the same port', async t => {
  const app = () => createApp({ adapter: { account: async () => ({ connected: true }) }, preferences: 'nonexistent-fixture-preferences' });
  const first = await launchHarnessConsole({ port: 0, open: () => {}, createServer: app });
  const port = first.server.address().port;
  const closed = new Promise(resolve => first.server.once('close', resolve));
  const second = await launchHarnessConsole({ port, open: () => {}, createServer: app });
  t.after(() => close(second.server));
  await closed;
  assert.equal(second.reused, false);
  assert.notEqual(second.server, first.server);
  assert.equal(second.server.address().port, port);
  // A new connection: fetch's pool could still hold a socket to the closed first server.
  const health = await new Promise((resolve, reject) => http.get(`${second.origin}/api/health`, { agent: false }, res => { let raw = ''; res.on('data', data => raw += data); res.on('end', () => resolve(JSON.parse(raw))); }).on('error', reject));
  assert.equal(health.app, 'corewise-cloner');
});

test('launcher refuses an unrelated service without stopping it', async t => {
  const other = http.createServer((req, res) => { res.writeHead(404); res.end('another app'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => close(other));
  const port = other.address().port;
  await assert.rejects(launchHarnessConsole({ port, open: () => assert.fail('must not open unrelated app') }), /another service/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'another app');
});

test('launcher reuses the earliest CoreWise build without restarting it', async t => {
  const legacy = http.createServer((req, res) => {
    if (req.url === '/api/health') { res.writeHead(404); res.end('{}'); }
    else res.end('<title>CoreWise · Repositories</title><div id="repoList"></div><button id="clone"></button>');
  });
  await new Promise(resolve => legacy.listen(0, '127.0.0.1', resolve));
  t.after(() => close(legacy));
  const result = await launchHarnessConsole({ port: legacy.address().port, open: () => {} });
  assert.equal(result.reused, true);
});

test('tracker PID comes only from an exact loopback or any-address LISTENING row', () => {
  const netstat = rows => `\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n${rows.map(r => `  ${r}\r\n`).join('')}`;
  assert.equal(parseListeningPid(netstat(['TCP    127.0.0.1:4545         0.0.0.0:0              LISTENING       111']), 4545), 111);
  assert.equal(parseListeningPid(netstat(['TCP    0.0.0.0:4545           0.0.0.0:0              LISTENING       222']), 4545), 222);
  assert.equal(parseListeningPid(netstat(['TCP    [::]:4545              [::]:0                 LISTENING       333']), 4545), 333);
  assert.equal(parseListeningPid(netstat(['TCP    192.168.1.5:4545       0.0.0.0:0              LISTENING       444']), 4545), null);
  assert.equal(parseListeningPid(netstat(['TCP    127.0.0.1:14545        0.0.0.0:0              LISTENING       555']), 4545), null);
  assert.equal(parseListeningPid(netstat(['TCP    127.0.0.1:4545         127.0.0.1:50000        ESTABLISHED     666']), 4545), null);
  // The unrelated rows come first; the exact tracker row still wins.
  assert.equal(parseListeningPid(netstat(['TCP    192.168.1.5:4545       0.0.0.0:0              LISTENING       444', 'TCP    127.0.0.1:14545        0.0.0.0:0              LISTENING       555', 'TCP    127.0.0.1:4545         0.0.0.0:0              LISTENING       111']), 4545), 111);
  assert.equal(parseListeningPid('', 4545), null);
});

test('tracker PID parsing reads full `netstat -ano` output: UDP ignored, IPv6 TCP accepted', () => {
  const netstat = rows => `\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n${rows.map(r => `  ${r}\r\n`).join('')}`;
  // UDP rows have no State column; a UDP socket on the port is never the tracker.
  assert.equal(parseListeningPid(netstat(['UDP    0.0.0.0:4545           *:*                                    777']), 4545), null);
  assert.equal(parseListeningPid(netstat(['UDP    [::]:4545              *:*                                    777']), 4545), null);
  assert.equal(parseListeningPid(netstat(['UDP    127.0.0.1:4545         *:*                                    777', 'TCP    127.0.0.1:4545         0.0.0.0:0              LISTENING       111']), 4545), 111);
  // A row whose state column reads LISTENING but whose protocol is not TCP is ignored.
  assert.equal(parseListeningPid(netstat(['UDP    127.0.0.1:4545         *:*                    LISTENING       888']), 4545), null);
  // IPv6 TCP rows, only present without `-p TCP`.
  assert.equal(parseListeningPid(netstat(['TCP    [::]:135               [::]:0                 LISTENING       1276', 'UDP    [::]:4545              *:*                                    777', 'TCP    [::]:4545              [::]:0                 LISTENING       333']), 4545), 333);
  assert.equal(parseListeningPid(netstat(['TCP    [::1]:4545             [::]:0                 LISTENING       334']), 4545), null);
  assert.equal(parseListeningPid(netstat(['TCP    [fe80::1%12]:4545      [::]:0                 LISTENING       335']), 4545), null);
  assert.equal(parseListeningPid(netstat(['TCP    [::]:14545             [::]:0                 LISTENING       336']), 4545), null);
});

test('only the UsageTracker node server command line counts as the tracker', () => {
  const dir = 'C:\\Users\\me\\CoreWise\\harness-console\\usage';
  assert(isTrackerCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\CoreWise\\harness-console\\usage\\server.mjs', dir));
  assert(isTrackerCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\CoreWise\\harness-console\\usage\\server.mjs"', dir));
  assert(isTrackerCommandLine('node c:/users/me/corewise/harness-console/usage/server.mjs', dir));
  assert(isTrackerCommandLine('"C:\\Program Files\\nodejs\\NODE.EXE" C:/USERS/ME/CoreWise/Harness-Console/USAGE/SERVER.MJS', dir));
  assert(!isTrackerCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\CoreWise\\OtherApp\\server.mjs', dir));
  assert(!isTrackerCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\CoreWise\\harness-console\\usage\\other.mjs', dir));
  assert(!isTrackerCommandLine('"C:\\Program Files\\Other\\python.exe" C:\\Users\\me\\CoreWise\\harness-console\\usage\\server.mjs', dir));
  assert(!isTrackerCommandLine('C:\\Tools\\nodemon.exe C:\\Users\\me\\CoreWise\\harness-console\\usage\\server.mjs', dir));
  assert(!isTrackerCommandLine('', dir));
  assert(!isTrackerCommandLine('   ', dir));
  assert(!isTrackerCommandLine(null, dir));
  assert(!isTrackerCommandLine(undefined, dir));
});

test('the tracker path counts only as the script node runs, not as a later argument', () => {
  const dir = 'C:\\Users\\me\\CoreWise\\harness-console\\usage';
  const tracker = 'C:\\Users\\me\\CoreWise\\harness-console\\usage\\server.mjs';
  const node = '"C:\\Program Files\\nodejs\\node.exe"';
  // Another script runs with the tracker path as its argument.
  assert(!isTrackerCommandLine(`${node} C:\\evil\\x.mjs ${tracker}`, dir));
  assert(!isTrackerCommandLine(`node C:\\evil\\x.mjs "${tracker}"`, dir));
  // Node options that evaluate or preload code, or take a value.
  assert(!isTrackerCommandLine(`${node} -e "1" ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} --eval "1" ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} -p "1" ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} --require x ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} -r x ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} --import x ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} --loader x ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} --test ${tracker}`, dir));
  assert(!isTrackerCommandLine(`${node} -i ${tracker}`, dir));
  // node alone runs nothing.
  assert(!isTrackerCommandLine(node, dir));
  // Arguments after the tracker script are its own arguments; node still runs the tracker.
  assert(isTrackerCommandLine(`${node} ${tracker} --port 4545`, dir));
  assert(isTrackerCommandLine(`node.exe "${tracker}"`, dir));
});

test('quoted and unquoted text glued together is one argument, as Windows parses it', () => {
  const dir = 'C:\\Users\\me\\CoreWise\\harness-console\\usage';
  const tracker = 'C:\\Users\\me\\CoreWise\\harness-console\\usage\\server.mjs';
  const node = '"C:\\Program Files\\nodejs\\node.exe"';
  // Node runs server.mjsx / server.mjs.bak, not the tracker.
  assert(!isTrackerCommandLine(`${node} "${tracker}"x`, dir));
  assert(!isTrackerCommandLine(`${node} "${tracker}".bak`, dir));
  // A quote mid-path still names the tracker file.
  assert(isTrackerCommandLine(`${node} C:\\Users\\me\\CoreWise\\harness-console\\"usage\\server.mjs"`, dir));
  assert(isTrackerCommandLine(`${node} ${tracker}`, dir));
  assert(isTrackerCommandLine(`${node} "${tracker}"`, dir));
});

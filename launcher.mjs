import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TRACKER = { port: Number(process.env.USAGE_PORT) || 4545, dir: path.join(here, 'usage') };

async function trackerUp(port) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/usage`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// PID from `netstat -ano` output of a TCP socket (IPv4 or IPv6) listening on exactly
// loopback/any:<port>; a LAN-bound socket, a UDP row, or a longer port like :14545
// belongs to some other service.
export function parseListeningPid(text, port) {
  const local = new Set([`127.0.0.1:${port}`, `0.0.0.0:${port}`, `[::]:${port}`]);
  const row = String(text ?? '').split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(cols => cols[0] === 'TCP' && cols[3] === 'LISTENING' && local.has(cols[1]));
  const pid = row ? Number(row[4]) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const normPath = p => path.win32.normalize(p.replace(/\//g, '\\')).toLowerCase();

// True only for `node[.exe] <dir>\server.mjs`, quoted or not, any slash style or case.
// The script must be the first argument: the tracker is started with no node options,
// and any option (-e, --require, ...) or earlier script means node runs something else.
export function isTrackerCommandLine(commandLine, dir) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return false;
  // Windows-style: quoted and unquoted runs glued together form one argument (`"a"b` is `ab`).
  const args = (commandLine.match(/(?:"[^"]*"|[^\s"])+/g) ?? []).map(arg => arg.replace(/"/g, ''));
  if (!/^node(\.exe)?$/i.test(path.win32.basename(args[0]?.replace(/\//g, '\\') ?? ''))) return false;
  return typeof args[1] === 'string' && normPath(args[1]) === normPath(path.join(dir, 'server.mjs'));
}

// The process listening on a loopback TCP port, from `netstat -ano` (Windows). All
// protocols: `-p TCP` omits IPv6 sockets, so a `[::]` listener would never be found.
function listeningPid(port) {
  return new Promise(resolve => execFile('netstat', ['-ano'], { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve(error ? null : parseListeningPid(stdout, port))));
}

// Command line of a PID via CIM; null when unreadable, so the caller leaves it running.
function commandLineOf(pid) {
  if (!Number.isInteger(pid)) return Promise.resolve(null);
  return new Promise(resolve => execFile('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null)));
}

// The usage tracker lives in usage/ with its own server. Start it when it is
// not answering. With fresh, a running copy is stopped first so edits load;
// otherwise it is left alone. Only a PID proven to be this tracker is killed;
// anything else on the port is reused as before. Returns the child only when this launch started it.
export async function ensureUsageTracker({ port = TRACKER.port, dir = TRACKER.dir, fresh = false } = {}) {
  if (fresh && await trackerUp(port)) {
    const pid = await listeningPid(port);
    if (pid && pid !== process.pid && isTrackerCommandLine(await commandLineOf(pid), dir)) {
      try { process.kill(pid); } catch {}
      for (let i = 0; i < 25 && await trackerUp(port); i++) await sleep(200);
    }
  }
  if (await trackerUp(port)) return null;
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs')], { cwd: dir, windowsHide: true, shell: false, stdio: 'ignore' });
  child.on('error', error => console.error(`Usage tracker: ${error.message}`));
  for (let i = 0; i < 25 && !await trackerUp(port); i++) await sleep(200);
  return child;
}

// Harness Console answers /api/health with its original app id 'corewise-cloner', kept so
// builds from before the rename (branded CoreWise) are still recognized and replaced.
async function isHarnessConsole(origin) {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (response.ok && (await response.json()).app === 'corewise-cloner') return true;
    // Recognize the earliest CoreWise build (no health route) by its page, without interrupting its active jobs.
    if (response.status !== 404) return false;
    const page = await fetch(origin, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const html = await page.text();
    return page.ok && html.includes('<title>CoreWise · Repositories</title>') && html.includes('id="repoList"') && html.includes('id="clone"');
  } catch { return false; }
}

export function openBrowser(url) {
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, shell: false, stdio: 'ignore' });
  child.on('error', error => console.error(error.message));
  child.unref();
}

// Asks a running Harness Console (or older CoreWise build) to quit through its own Quit app route. It refuses (409) while an
// operation runs, and the earlier version has no such route; both count as "keep it".
async function quitRunning(origin) {
  try {
    const { token } = await (await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(10000) })).json();
    const response = await fetch(`${origin}/api/quit`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': token }, body: '{}', signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch { return false; }
}

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});

// Every launch starts fresh: a running instance is asked to quit and the usage tracker is restarted,
// so edits to either load. An instance busy with an operation is kept and only reopened.
export async function launchHarnessConsole({ port = 43127, createServer = createApp, open = openBrowser, tracker = null } = {}) {
  const server = await createServer();
  try { await listen(server, port); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const origin = `http://127.0.0.1:${port}`;
    if (!await isHarnessConsole(origin)) throw new Error(`Port ${port} is occupied by another service. Harness Console left it running. Close that service before trying again.`);
    if (!await quitRunning(origin)) {
      (tracker ? await tracker() : null)?.unref();
      open(origin);
      return { reused: true, origin, server: null };
    }
    for (let attempt = 0; ; attempt++) {
      try { await listen(server, port); break; }
      catch (retry) { if (retry.code !== 'EADDRINUSE' || attempt >= 50) throw retry; await sleep(100); }
    }
  }
  const child = tracker ? await tracker({ fresh: true }) : null;
  if (child) server.once('close', () => child.kill());
  const origin = `http://127.0.0.1:${server.address().port}`;
  open(origin);
  return { reused: false, origin, server };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchHarnessConsole({ tracker: ensureUsageTracker }).then(result => console.log(`${result.reused ? 'Opened' : 'Started'} Harness Console: ${result.origin}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

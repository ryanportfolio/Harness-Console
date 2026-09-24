import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cloneMain, github, localState, updateMain, validateRepo } from './core.mjs';
import { createProject, skillCatalog } from './harness.mjs';
import { applySkills, normalizeSelection, scanSkills } from './sync.mjs';
import { compareDsh, installDsh, normalizeChoices, previewDsh } from './dsh.mjs';
import { TRACKER } from './launcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/new-project.css': ['new-project.css', 'text/css'], '/sync.css': ['sync.css', 'text/css'] };
export async function createApp({ root = path.join(homedir(), 'CoreWise'), adapter = github(), clone = cloneMain, update = updateMain, local = localState, create = createProject, catalog = skillCatalog, scan = scanSkills, sync = applySkills, dshPreview = previewDsh, dshInstall = installDsh, dshCompare = compareDsh, preferences = path.join(homedir(), '.corewise-cloner', 'preferences.json') } = {}) {
  const token = randomBytes(32).toString('hex');
  let repos = [], lastSelected = null, job = null, skills = null, lastScan = null, lastDsh = null;
  // DSH installs read the local Harness-Firmware checkout; the preview keeps the rendered bytes,
  // so an install writes exactly what was shown.
  const dshSource = path.join(root, 'Harness-Firmware');
  const dshView = preview => ({ ...preview, skills: preview.skills.map(({ rendered, ...skill }) => skill) });
  try { lastSelected = JSON.parse(await readFile(preferences, 'utf8')).lastSelected || null; } catch {}
  const reply = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  // The template's skill list is fetched once per server run and refetched only after a failure.
  const loadSkills = () => { skills ??= catalog().catch(error => { skills = null; throw error; }); return skills; };
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src http://127.0.0.1:${TRACKER.port}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return reply(res, 403, { error: 'Local access only.' });
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [name, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(await readFile(path.join(here, 'public', name)));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return reply(res, 200, { app: 'corewise-cloner' });
      if (req.method === 'GET' && url.pathname === '/api/tracker') {
        const trackerUrl = `http://127.0.0.1:${TRACKER.port}`;
        let up = false;
        try { up = (await fetch(`${trackerUrl}/api/usage`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
        return reply(res, 200, { up, url: trackerUrl });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return reply(res, 200, { ...await adapter.account(), root, token, lastSelected });
      if (req.method === 'GET' && url.pathname === '/api/repos') { repos = await adapter.repositories(); return reply(res, 200, { repos }); }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        try { return reply(res, 200, await loadSkills()); }
        catch (error) { return reply(res, 502, { error: `Could not read the template's skills. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/sync') {
        try { lastScan = await scan({ root }); return reply(res, 200, lastScan); }
        catch (error) { return reply(res, 502, { error: `Could not compare skills. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh') {
        if (job?.status === 'running' && job.kind === 'dsh') return reply(res, 409, { error: 'Wait for the DSH install to finish.' });
        // Each preview gets an id; an install names the preview it confirmed, so a newer check
        // from another tab can never swap in different bytes.
        try { lastDsh = { ...await dshPreview({ source: dshSource }), id: randomBytes(8).toString('hex') }; return reply(res, 200, dshView(lastDsh)); }
        catch (error) { lastDsh = null; return reply(res, 502, { error: `Could not preview DSH skills. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh/compare') {
        const skill = lastDsh?.skills.find(item => item.name === url.searchParams.get('name'));
        if (!skill) return reply(res, 404, { error: 'Check DSH skills again.' });
        return reply(res, 200, { name: skill.name, diff: await dshCompare({ skill, dest: lastDsh.dest }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/job') return reply(res, 200, { job });
      if (req.method === 'GET' && url.pathname === '/api/local') { const id = validateRepo(url.searchParams.get('id')); return reply(res, 200, await local({ root, id })); }
      if (req.method !== 'POST') return reply(res, 404, { error: 'Not found.' });
      if (req.headers.origin !== origin || req.headers['x-corewise-token'] !== token || req.headers['content-type'] !== 'application/json') return reply(res, 403, { error: 'Invalid local session. Reload this page.' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return reply(res, 413, { error: 'Request too large.' }); }
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/api/quit') {
        if (job?.status === 'running') return reply(res, 409, { error: 'Wait for the current operation to finish before quitting.' });
        reply(res, 200, { ok: true });
        server.close();
        return;
      }
      if (!['/api/clone', '/api/update', '/api/login', '/api/create', '/api/sync', '/api/dsh'].includes(url.pathname)) return reply(res, 404, { error: 'Not found.' });
      if (job?.status === 'running') return reply(res, 409, { error: 'An operation is already running.' });
      const kind = url.pathname.slice('/api/'.length);
      if (kind === 'clone' || kind === 'update') { validateRepo(body.id); if (!repos.some(repo => repo.id === body.id)) throw new Error('Refresh and select a repository from your account.'); }
      let request = null;
      if (kind === 'dsh') {
        request = normalizeChoices(body.skills);
        if (!lastDsh || body.previewId !== lastDsh.id || request.some(item => !lastDsh.skills.some(skill => skill.name === item.name))) throw new Error('Check DSH skills again before installing.');
      }
      if (kind === 'sync') {
        request = normalizeSelection(body.repos);
        if (request.some(item => !lastScan?.repos.some(repo => repo.id === item.id))) throw new Error('Check repositories again before syncing.');
        // Replacing an edited copy is pinned to the folder trees this page was shown.
        for (const item of request) {
          const scanned = lastScan.repos.find(repo => repo.id === item.id);
          item.replace = item.replace.map(name => {
            const skill = scanned.skills?.find(entry => entry.name === name && entry.status === 'customized');
            if (!skill) throw new Error('Check repositories again before syncing.');
            return { name, trees: skill.trees };
          });
        }
      }
      if (kind === 'create') {
        if (typeof body.name !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(body.name) || /^\.+$/.test(body.name)) throw new Error('Use letters, digits, dot, dash, or underscore for the repository name.');
        if (body.description !== undefined && typeof body.description !== 'string') throw new Error('Description must be text.');
        if (body.disabledSkills !== undefined && !Array.isArray(body.disabledSkills)) throw new Error('Choose skills from the available list.');
        request = { name: body.name, description: body.description ?? '', isPrivate: body.private !== false, disabledSkills: body.disabledSkills ?? [] };
      }
      job = { kind, id: kind === 'create' ? request.name : body.id || null, status: 'running', log: '', destination: null, remoteUrl: null, disabledSkills: null, results: null };
      const active = job;
      const output = text => { active.log = (active.log + text).slice(-24000); };
      const work = async () => {
        try {
          if (kind === 'login') await adapter.login(output);
          else if (kind === 'dsh') {
            const preview = lastDsh; lastDsh = null;
            try { active.results = await dshInstall({ preview, choices: request, dest: preview.dest, onOutput: output }); }
            catch (error) { active.results = error.results ?? null; throw error; }
          } else if (kind === 'sync') {
            try { active.results = await sync({ root, selection: request, onOutput: output }); }
            catch (error) { active.results = error.results ?? null; throw error; }
          } else if (kind === 'create') {
            const result = await create({ root, ...request, catalog: await loadSkills(), onOutput: output });
            active.destination = result.destination; active.remoteUrl = result.remoteUrl; active.disabledSkills = result.disabledSkills;
          } else if (kind === 'update') {
            active.destination = await update({ root, id: body.id, onOutput: output });
          } else {
            active.destination = await clone({ root, id: body.id, onOutput: output });
            lastSelected = body.id;
            try { await mkdir(path.dirname(preferences), { recursive: true }); await writeFile(preferences, JSON.stringify({ lastSelected }, null, 2)); } catch { output('Could not save selection preference.\n'); }
          }
          active.status = 'complete';
        } catch (error) { active.status = 'failed'; active.error = error.message; output(`\n${error.message}\n`); }
      };
      void work();
      return reply(res, 202, { job: active });
    } catch (error) { return reply(res, 400, { error: error.message }); }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const server = await createApp({ root: argument('--root'), preferences: argument('--preferences') });
  const port = Number(argument('--port') || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`Harness Console: ${url}`);
    if (process.argv.includes('--open')) {
      // A trusted, generated URL is the sole argument to the Windows URL handler.
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, shell: false });
      child.on('error', error => console.error(error.message));
    }
  });
}

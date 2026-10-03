import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cloneMain, github, localState, updateMain, validateRepo } from './core.mjs';
import { createProject, skillCatalog } from './harness.mjs';
import { applySkills, compareSkill, normalizeLock, normalizeSelection, scanSkills, setSkillLock, skillStory } from './sync.mjs';
import { compareDsh, installDsh, normalizeChoices, previewDsh } from './dsh.mjs';
import { TRACKER } from './launcher.mjs';
import { defaults, legacyPaths, loadSettings, pausedList, readSettings, settingsFile as defaultSettingsFile, templateIds, templateOf, updateSettings } from './settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/new-project.css': ['new-project.css', 'text/css'], '/sync.css': ['sync.css', 'text/css'] };
// settingsFile null keeps settings in memory only (tests); root, when given, overrides the workspace.
export async function createApp({ root: rootOverride = null, settingsFile = defaultSettingsFile(), legacy = legacyPaths(), adapter = github(), clone = cloneMain, update = updateMain, local = localState, create = createProject, catalog = skillCatalog, scan = scanSkills, sync = applySkills, lockSkill = setSkillLock, compareSync = compareSkill, storySync = skillStory, dshPreview = previewDsh, dshInstall = installDsh, dshCompare = compareDsh, build = null } = {}) {
  const token = randomBytes(32).toString('hex');
  let repos = [], job = null, skills = null, lastScan = null, lastDsh = null;
  // A settings file that cannot be read leaves the app usable but refuses every sync and lock, because
  // the paused projects it lists must never be written. It is not overwritten either.
  let settings = defaults(), settingsError = null;
  if (settingsFile) {
    try { settings = (await loadSettings({ file: settingsFile, legacy })).settings; }
    catch (error) { settingsError = `Could not read the settings file. ${error.message}`; }
  }
  const root = rootOverride ?? settings.workspace;
  let lastSelected = settings.lastSelected;
  const needRoot = () => { if (!root) throw new Error(settingsError ?? `Choose a workspace folder first: set "workspace" in ${settingsFile ?? 'the settings file'}.`); return root; };
  // Scans, syncs and locks read the file each time, so a pause or a project template set while the app
  // runs holds at once.
  const current = async () => {
    if (settingsError) throw new Error(settingsError);
    if (!settingsFile) return settings;
    try { return await readSettings(settingsFile); }
    catch (error) { throw new Error(`Could not read the settings file. ${error.message}`); }
  };
  // Template caches live beside the settings file; in-memory settings use sync.mjs's own default.
  const cacheDir = settingsFile ? path.dirname(settingsFile) : undefined;
  const templateOptions = current => ({ defaultTemplate: current.defaultTemplate, templateFor: (...ids) => templateOf(current, ...ids), templates: templateIds(current), cacheDir });
  // DSH installs read the local Harness-Firmware checkout; the preview keeps the rendered bytes,
  // so an install writes exactly what was shown.
  const dshSource = () => path.join(needRoot(), 'Harness-Firmware');
  const dshView = preview => ({ ...preview, skills: preview.skills.map(({ rendered, ...skill }) => skill) });
  const reply = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  // The template's skill list is refetched each time a page loads the picker, so a create checks the
  // list the most recent page load showed. A create with no list yet fetches one; a failed fetch is
  // not kept. createProject also checks the clone's own manifest, so an old list cannot skip a rule.
  const fetchSkills = () => { const pending = catalog({ template: settings.defaultTemplate }); skills = pending; pending.catch(() => { if (skills === pending) skills = null; }); return pending; };
  const loadSkills = () => skills ?? fetchSkills();
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
      if (req.method === 'GET' && url.pathname === '/api/status') return reply(res, 200, { ...await adapter.account(), root, token, lastSelected, build, settingsFile, settingsError, defaultTemplate: settings.defaultTemplate });
      if (req.method === 'GET' && url.pathname === '/api/repos') { repos = await adapter.repositories(); return reply(res, 200, { repos }); }
      if (req.method === 'GET' && url.pathname === '/api/skills') {
        try { return reply(res, 200, await fetchSkills()); }
        catch (error) { return reply(res, 502, { error: `Could not read the template's skills. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/sync') {
        try { const now = await current(); lastScan = await scan({ root: needRoot(), skip: pausedList(now), ...templateOptions(now) }); return reply(res, 200, lastScan); }
        catch (error) { return reply(res, 502, { error: `Could not compare skills. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/sync/compare') {
        // Compares the exact commits the page was shown: the scanned origin/main and the head of that
        // repository's template. The page names both, so a newer scan from another tab is refused
        // rather than shown under old labels.
        const repo = lastScan?.repos.find(item => item.id === url.searchParams.get('id'));
        const name = url.searchParams.get('name');
        const template = repo?.template ?? lastScan?.template;
        if (!repo?.skills?.some(skill => skill.name === name && skill.status !== 'off') || url.searchParams.get('rev') !== repo.head || url.searchParams.get('template') !== template.head) return reply(res, 404, { error: 'Check repositories again.' });
        // The story (who changed what, when) is extra context; without it the diff still shows.
        const args = { folder: repo.folder, rev: repo.head, name, templateHead: template.head, templateId: template.id };
        try { const [diff, story] = await Promise.all([compareSync(args), storySync(args).catch(() => null)]); return reply(res, 200, { name, diff, story }); }
        catch (error) { return reply(res, 502, { error: `Could not compare ${name}. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh') {
        if (job?.status === 'running' && job.kind === 'dsh') return reply(res, 409, { error: 'Wait for the DSH install to finish.' });
        // Each preview gets an id; an install names the preview it confirmed, so a newer check
        // from another tab can never swap in different bytes.
        try { lastDsh = { ...await dshPreview({ source: dshSource() }), id: randomBytes(8).toString('hex') }; return reply(res, 200, dshView(lastDsh)); }
        catch (error) { lastDsh = null; return reply(res, 502, { error: `Could not preview DSH skills. ${error.message}` }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/dsh/compare') {
        const skill = lastDsh?.skills.find(item => item.name === url.searchParams.get('name'));
        if (!skill) return reply(res, 404, { error: 'Check DSH skills again.' });
        return reply(res, 200, { name: skill.name, diff: await dshCompare({ skill, dest: lastDsh.dest }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/job') return reply(res, 200, { job });
      if (req.method === 'GET' && url.pathname === '/api/local') { const id = validateRepo(url.searchParams.get('id')); return reply(res, 200, await local({ root: needRoot(), id })); }
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
      if (!['/api/clone', '/api/update', '/api/login', '/api/create', '/api/sync', '/api/sync-lock', '/api/dsh'].includes(url.pathname)) return reply(res, 404, { error: 'Not found.' });
      if (job?.status === 'running') return reply(res, 409, { error: 'An operation is already running.' });
      const kind = url.pathname.slice('/api/'.length);
      if (['clone', 'update', 'create', 'sync', 'sync-lock'].includes(kind)) needRoot();
      const now = ['sync', 'sync-lock'].includes(kind) ? await current() : null;
      const skip = now && pausedList(now);
      if (kind === 'clone' || kind === 'update') { validateRepo(body.id); if (!repos.some(repo => repo.id === body.id)) throw new Error('Refresh and select a repository from your account.'); }
      let request = null, syncTemplateFor = null;
      if (kind === 'dsh') {
        request = normalizeChoices(body.skills);
        if (!lastDsh || body.previewId !== lastDsh.id || request.some(item => !lastDsh.skills.some(skill => skill.name === item.name))) throw new Error('Check DSH skills again before installing.');
      }
      if (kind === 'sync-lock') {
        request = normalizeLock(body);
        // Only a skill the page was shown can be locked or unlocked, in a repository the scan could check.
        const scanned = lastScan?.repos.find(repo => repo.id === request.id);
        if (!scanned?.skills?.some(skill => skill.name === request.skill)) throw new Error('Check repositories again before changing a lock.');
      }
      if (kind === 'sync') {
        request = normalizeSelection(body.repos);
        if (request.some(item => !lastScan?.repos.some(repo => repo.id === item.id))) throw new Error('Check repositories again before syncing.');
        // The page names the template head it compared each repository against. A newer scan from
        // another tab, with a different template or head, is refused rather than applied under old labels.
        const shownTemplate = new Map(body.repos.map(item => [item.id, item.template]));
        // Replacing an edited copy is pinned to the folder trees this page was shown. A repository the
        // scan skipped (skip list, archived) or could not check is refused here too.
        for (const item of request) {
          const scanned = lastScan.repos.find(repo => repo.id === item.id);
          if (scanned.skipped || scanned.error) throw new Error(`${item.id} cannot be synced. ${scanned.skipped ? `Skipped: ${scanned.skipped}.` : scanned.error}`);
          if (shownTemplate.get(item.id) !== (scanned.template ?? lastScan.template)?.head) throw new Error('Check repositories again before syncing.');
          item.replace = item.replace.map(name => {
            const skill = scanned.skills?.find(entry => entry.name === name && entry.status === 'customized');
            if (!skill) throw new Error('Check repositories again before syncing.');
            return { name, trees: skill.trees };
          });
        }
        // Each repository syncs from the template its scan used, even if settings changed since.
        const scannedTemplates = new Map(request.map(item => [item.id, lastScan.repos.find(repo => repo.id === item.id).template?.id]));
        syncTemplateFor = id => scannedTemplates.get(id) ?? templateOf(now, id);
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
          } else if (kind === 'sync-lock') {
            // A pull request that opened but did not merge keeps its link, as a failed sync does.
            try { active.results = [await lockSkill({ root, ...request, skip, templates: templateIds(now), onOutput: output })]; }
            catch (error) { active.results = error.branch ? [{ id: request.id, result: 'failed', branch: error.branch, ...(error.url && { url: error.url }) }] : null; throw error; }
          } else if (kind === 'sync') {
            try { active.results = await sync({ root, selection: request, skip, ...templateOptions(now), templateFor: syncTemplateFor, onOutput: output }); }
            catch (error) { active.results = error.results ?? null; throw error; }
          } else if (kind === 'create') {
            // Created from the template the skill list came from, so the choices always match it.
            const catalogNow = await loadSkills();
            const result = await create({ root, ...request, template: catalogNow.template ?? settings.defaultTemplate, catalog: catalogNow, onOutput: output });
            active.destination = result.destination; active.remoteUrl = result.remoteUrl; active.disabledSkills = result.disabledSkills;
          } else if (kind === 'update') {
            active.destination = await update({ root, id: body.id, onOutput: output });
          } else {
            active.destination = await clone({ root, id: body.id, onOutput: output });
            lastSelected = body.id;
            // Saved into the file as it is now, never over one that failed to load or became unreadable.
            if (settingsFile && !settingsError) {
              try { settings = await updateSettings(settingsFile, { lastSelected }); } catch (error) { output(`Could not save the selection. ${error.message}\n`); }
            }
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
  const server = await createApp({ root: argument('--root') ?? null, settingsFile: argument('--settings') });
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

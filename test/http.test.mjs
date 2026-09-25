import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('malformed HTTP request target returns 400 and leaves the server usable', async t => {
  const server = await createApp({ adapter: { account: async () => ({ connected: true, login: 'fixture' }) }, preferences: 'nonexistent-fixture-preferences' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = target => new Promise((resolve, reject) => {
    // Pass the raw target as path so the client does not parse or normalize it.
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: target }, res => {
      let raw = '';
      res.on('data', data => raw += data);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end();
  });
  const malformed = await request('http://[');
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /invalid url/i);
  const healthy = await request('/api/status');
  assert.equal(healthy.status, 200);
  assert.equal(healthy.body.login, 'fixture');
  assert.equal(healthy.body.connected, true);
});

test('HTTP guards reject foreign host, origin, missing token and arbitrary repository', async t => {
  const server = await createApp({ adapter: { account: async () => ({ connected: true, login: 'fixture' }), repositories: async () => [{ id: 'owner/repo' }] }, preferences: 'nonexistent-fixture-preferences' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const request = (route, { method = 'GET', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => { const req = http.request(`${origin}${route}`, { method, headers }, res => { let raw = ''; res.on('data', data => raw += data); res.on('end', () => resolve({ status: res.statusCode, body: raw })); }); req.on('error', reject); req.end(body); });
  assert.equal((await request('/api/status', { headers: { Host: `evil.test:${port}` } })).status, 403);
  assert.equal((await request('/api/status', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const state = JSON.parse((await request('/api/status')).body);
  assert.equal((await request('/api/clone', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': state.token };
  assert.equal((await request('/api/clone', { method: 'POST', headers, body: JSON.stringify({ id: 'owner/arbitrary', url: 'file:///tmp' }) })).status, 400);
  assert.equal((await request('/api/open', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await request('/api/clone', { method: 'POST', headers, body: 'invalid json' })).status, 400);
  assert.equal((await request('/../../core.mjs')).status, 404);
  assert.equal((await request('/')).status, 200);
});

test('skills and create routes validate input and reuse the single job slot', async t => {
  const created = [];
  const server = await createApp({
    adapter: { account: async () => ({ connected: true, login: 'fixture' }) },
    catalog: async () => ({ groups: [], skills: [{ name: 'init-project', required: true }, { name: 'lab' }] }),
    create: async ({ name, description, isPrivate, disabledSkills, catalog, onOutput }) => { created.push({ name, description, isPrivate, disabledSkills, skills: catalog.skills.length }); onOutput('made\n'); return { destination: `C:/CoreWise/${name}`, remoteUrl: `https://github.com/fixture/${name}`, disabledSkills }; },
    preferences: 'nonexistent-fixture-preferences',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, body) => { const response = await fetch(`${origin}${route}`, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const { token } = (await json('/api/status')).body;
  assert.deepEqual((await json('/api/skills')).body.skills.map(skill => skill.name), ['init-project', 'lab']);
  assert.equal((await json('/api/create', { name: '../x' })).status, 400);
  assert.equal((await json('/api/create', { name: 'ok', disabledSkills: 'lab' })).status, 400);
  assert.equal((await json('/api/create', { name: 'ok', description: 5 })).status, 400);
  assert.equal(created.length, 0);
  const accepted = await json('/api/create', { name: 'ok', description: 'd', private: false, disabledSkills: ['lab'] });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.job.kind, 'create');
  await new Promise(resolve => setTimeout(resolve, 50));
  const { job } = (await json('/api/job')).body;
  assert.equal(job.status, 'complete');
  assert.equal(job.remoteUrl, 'https://github.com/fixture/ok');
  assert.deepEqual(job.disabledSkills, ['lab']);
  assert.deepEqual(created, [{ name: 'ok', description: 'd', isPrivate: false, disabledSkills: ['lab'], skills: 2 }]);
  assert.equal((await fetch(`${origin}/new-project.css`)).status, 200);
  assert.equal((await fetch(`${origin}/public/../server.mjs`)).status, 404);
});

test('local and update routes validate the repository and run the update job', async t => {
  const updated = [];
  const server = await createApp({
    adapter: { account: async () => ({ connected: true, login: 'fixture' }), repositories: async () => [{ id: 'owner/repo' }] },
    local: async ({ id }) => ({ destination: `C:/CoreWise/${id.split('/')[1]}`, exists: true, git: true, matches: true, branch: 'main', dirty: [] }),
    update: async ({ id, onOutput }) => { updated.push(id); onOutput('done\n'); return `C:/CoreWise/${id.split('/')[1]}`; },
    preferences: 'nonexistent-fixture-preferences',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, body) => { const response = await fetch(`${origin}${route}`, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const { token } = (await json('/api/status')).body;
  assert.equal((await json('/api/local?id=../etc')).status, 400);
  assert.equal((await json('/api/local?id=owner/repo')).body.branch, 'main');
  assert.equal((await json('/api/update', { id: 'owner/other' })).status, 400);
  await json('/api/repos');
  assert.equal((await json('/api/update', { id: 'owner/other' })).status, 400);
  const accepted = await json('/api/update', { id: 'owner/repo' });
  assert.equal(accepted.status, 202); assert.equal(accepted.body.job.kind, 'update');
  await new Promise(resolve => setTimeout(resolve, 50));
  const { job } = (await json('/api/job')).body;
  assert.equal(job.status, 'complete'); assert.equal(job.destination, 'C:/CoreWise/repo'); assert.deepEqual(updated, ['owner/repo']);
});

test('sync route pins a replacement to the scanned trees and refuses skills that were not edited', async t => {
  const synced = [];
  const server = await createApp({
    adapter: { account: async () => ({ connected: true, login: 'fixture' }) },
    scan: async () => ({ template: { head: 'abc' }, repos: [{ id: 'owner/project', name: 'project', skills: [{ name: 'beta', status: 'customized', trees: 't1:-' }, { name: 'alpha', status: 'behind' }] }] }),
    sync: async ({ selection }) => { synced.push(selection); return []; },
    preferences: 'nonexistent-fixture-preferences',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, body) => { const response = await fetch(`${origin}${route}`, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const { token } = (await json('/api/status')).body;
  await json('/api/sync');
  assert.equal((await json('/api/sync', { repos: [{ id: 'owner/project', replace: ['alpha'] }] })).status, 400);
  assert.equal((await json('/api/sync', { repos: [{ id: 'owner/project', replace: ['beta'] }] })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(synced, [[{ id: 'owner/project', apply: [], remove: [], replace: [{ name: 'beta', trees: 't1:-' }] }]]);
});

test('DSH routes preview without file bytes and install only skills from that preview', async t => {
  const installs = [];
  const preview = { source: { commit: 'abc' }, dest: 'D:/dsh/skills', destProblems: [], skills: [{ name: 'refine', status: 'conflict', rendered: [{ path: 'SKILL.md', data: Buffer.from('x') }] }] };
  const server = await createApp({
    adapter: { account: async () => ({ connected: true, login: 'fixture' }) },
    dshPreview: async ({ source }) => ({ ...preview, source: { ...preview.source, folder: source } }),
    dshInstall: async ({ preview: shown, choices, dest }) => { installs.push({ skills: shown.skills.length, choices, dest }); return []; },
    dshCompare: async ({ skill }) => `diff for ${skill.name}`,
    preferences: 'nonexistent-fixture-preferences',
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = async (route, body) => { const response = await fetch(`${origin}${route}`, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const { token } = (await json('/api/status')).body;
  assert.equal((await json('/api/dsh', { skills: [{ name: 'refine', policy: 'backup' }] })).status, 400);
  const shown = (await json('/api/dsh')).body;
  assert.match(shown.id, /^[0-9a-f]{16}$/);
  assert.equal(shown.skills[0].rendered, undefined);
  assert.match(shown.source.folder, /Harness-Firmware$/);
  assert.equal((await json('/api/dsh/compare?name=refine')).body.diff, 'diff for refine');
  assert.equal((await json('/api/dsh', { previewId: shown.id, skills: [{ name: 'other', policy: 'install' }] })).status, 400);
  assert.equal((await json('/api/dsh', { previewId: shown.id, skills: [{ name: 'refine', policy: 'overwrite' }] })).status, 400);
  assert.equal((await json('/api/dsh', { previewId: 'stale', skills: [{ name: 'refine', policy: 'backup' }] })).status, 400);
  assert.equal((await json('/api/dsh', { previewId: shown.id, skills: [{ name: 'refine', policy: 'backup' }] })).status, 202);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(installs, [{ skills: 1, choices: [{ name: 'refine', policy: 'backup' }], dest: 'D:/dsh/skills' }]);
  assert.equal((await json('/api/dsh', { skills: [{ name: 'refine', policy: 'backup' }] })).status, 400);
});

test('every page script parses', async () => {
  const { run } = await import('../core.mjs');
  for (const file of ['public/app.js']) await run(process.execPath, ['--check', file]);
});

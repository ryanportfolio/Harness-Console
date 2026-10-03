import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { defaults, loadSettings, pausedList, saveSettings, settingsDir } from '../settings.mjs';

const temp = async t => { const dir = await mkdtemp(path.join(tmpdir(), 'harness-settings-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const json = data => `${JSON.stringify(data, null, 2)}\n`;
// A legacy layout under dir: ~/.corewise-cloner with preferences, ~/CoreWise, and the app's skip list.
async function legacy(dir, { skip = { version: 1, skip: [{ repo: 'owner/frozen', reason: 'Frozen job take-home' }] }, root = true } = {}) {
  const paths = { dir: path.join(dir, '.corewise-cloner'), preferences: path.join(dir, '.corewise-cloner', 'preferences.json'), root: path.join(dir, 'CoreWise'), skip: path.join(dir, 'sync-skip.json') };
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.preferences, json({ lastSelected: 'owner/kbase' }));
  if (root) await mkdir(paths.root);
  if (skip) await writeFile(paths.skip, typeof skip === 'string' ? skip : json(skip));
  return paths;
}

test('the settings folder follows each operating system', () => {
  assert.equal(settingsDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, home: 'C:\\Users\\me' }), path.join('C:\\Users\\me\\AppData\\Roaming', 'Harness Firmware'));
  assert.equal(settingsDir({ platform: 'darwin', env: {}, home: '/Users/me' }), path.join('/Users/me', 'Library', 'Application Support', 'Harness Firmware'));
  assert.equal(settingsDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/me' }), path.join('/cfg', 'harness-firmware'));
  assert.equal(settingsDir({ platform: 'linux', env: {}, home: '/home/me' }), path.join('/home/me', '.config', 'harness-firmware'));
});

test('a first start with no earlier install saves defaults with no workspace', async t => {
  const dir = await temp(t), file = path.join(dir, 'app', 'settings.json');
  const { settings, migrated } = await loadSettings({ file, legacy: { dir: path.join(dir, 'missing'), preferences: '', root: '', skip: '' } });
  assert.equal(migrated, false);
  assert.deepEqual(settings, defaults());
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), defaults());
});

test('a first start imports the Harness Console folder, last selection and skip list once', async t => {
  const dir = await temp(t), file = path.join(dir, 'app', 'settings.json'), paths = await legacy(dir);
  const first = await loadSettings({ file, legacy: paths });
  assert.equal(first.migrated, true);
  assert.equal(first.settings.workspace, paths.root);
  assert.equal(first.settings.lastSelected, 'owner/kbase');
  assert.deepEqual(first.settings.projects, { 'owner/frozen': { paused: 'Frozen job take-home' } });
  // The saved file wins from then on: a later edit to the old skip list changes nothing.
  await writeFile(paths.skip, json({ version: 1, skip: [] }));
  const second = await loadSettings({ file, legacy: paths });
  assert.equal(second.migrated, false);
  assert.deepEqual(second.settings, first.settings);
});

test('an import with no CoreWise folder leaves the workspace unset', async t => {
  const dir = await temp(t), file = path.join(dir, 'settings.json');
  const { settings } = await loadSettings({ file, legacy: await legacy(dir, { root: false, skip: null }) });
  assert.equal(settings.workspace, null);
  assert.deepEqual(settings.projects, {});
});

test('an unreadable skip list stops the import and writes no settings file', async t => {
  const dir = await temp(t), file = path.join(dir, 'settings.json');
  const paths = await legacy(dir, { skip: { version: 1, skip: [{ repo: 'owner/frozen', reason: ' ' }] } });
  await assert.rejects(loadSettings({ file, legacy: paths }), /empty reason/);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('a broken settings file is reported and left as it is', async t => {
  const dir = await temp(t), file = path.join(dir, 'settings.json');
  for (const [raw, message] of [['{ nope', /not valid JSON/], [json({ ...defaults(), workspace: 'relative/folder' }), /"workspace" must be an absolute folder path/], [json({ ...defaults(), projects: { 'owner/x': { paused: 3 } } }), /"paused" must be a reason/], [json({ ...defaults(), version: 2 }), /"version": 1/]]) {
    await writeFile(file, raw);
    await assert.rejects(loadSettings({ file, legacy: null }), message);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
});

test('saving validates first and replaces the file whole', async t => {
  const dir = await temp(t), file = path.join(dir, 'settings.json');
  await saveSettings(file, { ...defaults(), lastSelected: 'owner/one' });
  await assert.rejects(saveSettings(file, { ...defaults(), lastSelected: 'not a repo' }), /"lastSelected"/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).lastSelected, 'owner/one');
});

test('a pause with a blank reason still pauses', () => {
  assert.deepEqual(pausedList({ ...defaults(), projects: { 'owner/a': { paused: ' ' }, 'owner/b': { paused: 'Frozen' }, 'owner/c': {} } }), [{ repo: 'owner/a', reason: 'Updates paused' }, { repo: 'owner/b', reason: 'Frozen' }]);
});

async function start(t, options) {
  const server = await createApp({ adapter: { account: async () => ({ connected: true, login: 'fixture' }), repositories: async () => [{ id: 'owner/repo' }] }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(`${origin}/api/status`)).json();
  const call = async (route, body) => { const response = await fetch(`${origin}/api/${route}`, body === undefined ? {} : { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CoreWise-Token': state.token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  return { state, call };
}

test('the server takes its workspace and paused projects from the settings file', async t => {
  const dir = await temp(t), file = path.join(dir, 'settings.json'), workspace = path.join(dir, 'work');
  await saveSettings(file, { ...defaults(), workspace, projects: { 'owner/frozen': { paused: 'Frozen job take-home' } } });
  const seen = [];
  const { state, call } = await start(t, { settingsFile: file, legacy: null, scan: async args => { seen.push(args); return { template: { head: 'abc' }, repos: [] }; } });
  assert.equal(state.root, workspace);
  assert.equal(state.settingsError, null);
  assert.equal((await call('sync')).status, 200);
  assert.deepEqual(seen, [{ root: workspace, skip: [{ repo: 'owner/frozen', reason: 'Frozen job take-home' }] }]);
});

test('a broken settings file refuses every sync and lock and is never overwritten', async t => {
  const dir = await temp(t), file = path.join(dir, 'settings.json');
  await writeFile(file, '{ nope');
  let scanned = false;
  const { state, call } = await start(t, { settingsFile: file, legacy: null, root: path.join(dir, 'work'), scan: async () => { scanned = true; return { template: { head: 'abc' }, repos: [] }; } });
  assert.match(state.settingsError, /Could not read the settings file/);
  const scan = await call('sync');
  assert.equal(scan.status, 502); assert.match(scan.body.error, /not valid JSON/); assert.equal(scanned, false);
  const apply = await call('sync', { repos: [] });
  assert.equal(apply.status, 400); assert.match(apply.body.error, /Could not read the settings file/);
  const lock = await call('sync-lock', { id: 'owner/repo', skill: 'alpha', lock: true });
  assert.equal(lock.status, 400); assert.match(lock.body.error, /Could not read the settings file/);
  assert.equal(await readFile(file, 'utf8'), '{ nope');
});

test('with no workspace the server asks for one instead of using a default folder', async t => {
  const { state, call } = await start(t, { settingsFile: null });
  assert.equal(state.root, null);
  const local = await call('local?id=owner/repo');
  assert.equal(local.status, 400); assert.match(local.body.error, /Choose a workspace folder first/);
  await call('repos');
  const clone = await call('clone', { id: 'owner/repo' });
  assert.equal(clone.status, 400); assert.match(clone.body.error, /Choose a workspace folder first/);
});

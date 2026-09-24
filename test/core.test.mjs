import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cloneMain, localState, run, updateMain, validateRepo, github } from '../core.mjs';

async function fixture(t, branch = 'main') {
  const temp = await mkdtemp(path.join(tmpdir(), 'corewise-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source'); await mkdir(source);
  await run('git', ['init', '-b', branch, source]);
  await writeFile(path.join(source, 'hello.txt'), 'hello CoreWise\n');
  await run('git', ['-C', source, 'add', 'hello.txt']);
  await run('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
  return { temp, source, root: path.join(temp, 'CoreWise'), id: 'owner/project' };
}
test('real clone retains content, main tracking, origin and credential helper', async t => {
  const data = await fixture(t); const destination = await cloneMain(data);
  assert.equal((await readFile(path.join(destination, 'hello.txt'), 'utf8')).replaceAll('\r\n', '\n'), 'hello CoreWise\n');
  assert.equal((await run('git', ['-C', destination, 'branch', '--show-current'])).trim(), 'main');
  assert.equal((await run('git', ['-C', destination, 'rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), 'origin/main');
  assert.equal((await run('git', ['-C', destination, 'remote', 'get-url', 'origin'])).trim(), data.source);
  assert.match(await run('git', ['-C', destination, 'config', '--local', '--get-all', 'credential.helper']), /gh auth git-credential/);
});
test('missing main leaves no destination', async t => { const data = await fixture(t, 'trunk'); await assert.rejects(cloneMain(data), /no main branch/); assert.deepEqual(await readdir(data.root), []); });
test('existing case-insensitive destination remains intact', async t => { const data = await fixture(t); await mkdir(path.join(data.root, 'PROJECT'), { recursive: true }); await writeFile(path.join(data.root, 'PROJECT', 'keep'), 'mine'); await assert.rejects(cloneMain(data), /already exists/); assert.equal(await readFile(path.join(data.root, 'PROJECT', 'keep'), 'utf8'), 'mine'); });
test('failed clone cleans its partial directory', async t => { const data = await fixture(t); await assert.rejects(cloneMain({ ...data, execute: async (command, args, options) => { if (args.includes('clone')) { await writeFile(path.join(data.root, 'project', 'partial'), 'partial'); throw new Error('fixture failure'); } return run(command, args, options); } }), /fixture failure/); assert.deepEqual(await readdir(data.root), []); });
test('invalid source fails safely before reserving destination', async t => { const data = await fixture(t); await assert.rejects(cloneMain({ ...data, source: path.join(data.temp, 'missing') })); assert.deepEqual(await readdir(data.root), []); });
test('path and Windows reserved names rejected', () => { for (const id of ['../escape', 'owner/..', 'owner/CON', 'owner/aux.txt', 'owner/x.', '--option/x', 'owner/a/b', 'owner/a b']) assert.throws(() => validateRepo(id)); });
test('GitHub pagination includes unsupported folder names for clear clone errors', async () => { let args; const adapter = github(async (_command, input) => { args = input; return JSON.stringify([[{ full_name: 'owner/CON', name: 'CON', owner: { login: 'owner' } }], [{ full_name: 'owner/private', name: 'private', owner: { login: 'owner' }, private: true }]]); }); const repos = await adapter.repositories(); assert.equal(repos.length, 2); assert.ok(args.includes('--paginate')); assert.ok(args.includes('--slurp')); });

test('updateMain fast-forwards a stale clone, switches back to main, and refuses dirty or foreign folders', async t => {
  const data = await fixture(t); const destination = await cloneMain(data);
  const commit = (dir, name) => run('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qam', name]);
  await writeFile(path.join(data.source, 'hello.txt'), 'newer\n'); await commit(data.source, 'newer');
  const stale = await localState(data); assert.equal(stale.behind, 1); assert.equal(stale.ahead, 0);
  await run('git', ['-C', destination, 'checkout', '-qb', 'feature']);
  const { source: _unused, ...foreign } = { ...data, id: 'other/project' }; // no source override: the clone's origin is a temp path, not GitHub
  await assert.rejects(updateMain(foreign), /points at/);
  await writeFile(path.join(destination, 'hello.txt'), 'edited locally\n');
  await assert.rejects(updateMain(data), /Uncommitted changes/);
  assert.equal(await readFile(path.join(destination, 'hello.txt'), 'utf8'), 'edited locally\n');
  await run('git', ['-C', destination, 'checkout', '-q', '--', 'hello.txt']);
  const log = []; assert.equal(await updateMain({ ...data, onOutput: text => log.push(text) }), destination);
  assert.equal((await run('git', ['-C', destination, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main');
  assert.equal((await readFile(path.join(destination, 'hello.txt'), 'utf8')).replace(/\r/g, ''), 'newer\n'); // autocrlf may rewrite the checkout
  assert.match(log.join(''), /moved forward 1 commit/);
  await writeFile(path.join(destination, 'hello.txt'), 'local commit\n'); await commit(destination, 'local only');
  const ahead = []; await updateMain({ ...data, onOutput: text => ahead.push(text) }); // ahead of origin is not stale
  assert.match(ahead.join(''), /Already up to date/);
  await writeFile(path.join(data.source, 'hello.txt'), 'diverged\n'); await commit(data.source, 'diverged');
  await assert.rejects(updateMain(data), /cannot fast-forward/);
  assert.equal((await run('git', ['-C', destination, 'log', '-1', '--format=%s'])).trim(), 'local only');
  const state = await localState(data); assert.equal(state.git, true); assert.equal(state.matches, true); assert.deepEqual(state.dirty, []); assert.equal(state.behind, 1); assert.equal(state.ahead, 1);
  assert.deepEqual(await localState({ ...data, id: 'owner/absent' }), { destination: path.join(data.root, 'absent'), exists: false });
});

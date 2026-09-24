import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../core.mjs';
import { applySkills, githubId, normalizeSelection, openTemplate, scanSkills, staleWorktrees } from '../sync.mjs';

const put = async (dir, file, text) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), text); };
const commit = async (dir, message) => { await run('git', ['-C', dir, 'add', '-A']); await run('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message]); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;

// Template: alpha (native Codex copy) changes, gamma is retired, delta and epsilon are new.
// Target: alpha at the old version, beta edited locally, gamma untouched, epsilon turned off,
// plus a local-only skill and an uncommitted edit in the working folder.
async function fixture(t, { targetScript, noModes, targetModes, overrides = { epsilon: 'off' }, extra = {} } = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), 'corewise-sync-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const template = path.join(temp, 'template'); await run('git', ['init', '-q', '-b', 'main', template]);
  const v1 = {
    '.claude/skills/alpha/SKILL.md': 'alpha v1\n', '.agents/skills/alpha/SKILL.md': 'alpha native v1\n',
    '.claude/skills/beta/SKILL.md': 'beta v1\n', '.claude/skills/gamma/SKILL.md': 'gamma v1\n',
    '.agents/skill-modes.json': json({ version: 1, skills: { alpha: 'native' } }),
  };
  for (const [file, text] of Object.entries(v1)) await put(template, file, text);
  await commit(template, 'v1');
  await put(template, '.claude/skills/alpha/SKILL.md', 'alpha v2\n'); await put(template, '.agents/skills/alpha/SKILL.md', 'alpha native v2\n');
  await put(template, '.claude/skills/delta/SKILL.md', 'delta v1\n'); await put(template, '.claude/skills/delta/scripts/tool.mjs', 'export {};\n');
  await put(template, '.claude/skills/epsilon/SKILL.md', 'epsilon v1\n');
  await put(template, '.agents/skill-modes.json', json({ version: 1, skills: { alpha: 'native', delta: 'native' } }));
  await put(template, '.agents/skills/delta/SKILL.md', 'delta native\n');
  await rm(path.join(template, '.claude/skills/gamma'), { recursive: true });
  await commit(template, 'v2');

  const seed = path.join(temp, 'seed'); await run('git', ['init', '-q', '-b', 'main', seed]);
  for (const [file, text] of Object.entries(v1)) if (!(noModes && file === '.agents/skill-modes.json')) await put(seed, file, text);
  if (targetModes) await put(seed, '.agents/skill-modes.json', json({ version: 1, skills: targetModes }));
  await put(seed, '.claude/skills/beta/SKILL.md', 'beta edited here\n');
  await put(seed, '.claude/skills/mine/SKILL.md', 'local only\n');
  await put(seed, '.claude/settings.json', json({ skillOverrides: overrides }));
  if (targetScript) await put(seed, '.claude/scripts/sync-codex-skills.mjs', targetScript);
  for (const [file, text] of Object.entries(extra)) await put(seed, file, text);
  await commit(seed, 'spawned');
  const remote = path.join(temp, 'project.git'); await run('git', ['clone', '-q', '--bare', seed, remote]);

  const root = path.join(temp, 'CoreWise'); await mkdir(root);
  const folder = path.join(root, 'project');
  await run('git', ['clone', '-q', remote, folder]);
  // Present the clone as a GitHub repository while fetches and pushes reach the local remote.
  await run('git', ['-C', folder, 'remote', 'set-url', 'origin', 'https://github.com/owner/project.git']);
  await run('git', ['-C', folder, 'config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, 'https://github.com/owner/project.git']);
  await writeFile(path.join(folder, '.claude/skills/alpha/SKILL.md'), 'uncommitted work\n');
  const opened = () => openTemplate({ cache: path.join(temp, 'cache.git'), source: template });
  return { temp, root, folder, remote, opened };
}

const statuses = repo => Object.fromEntries(repo.skills.map(skill => [skill.name, skill.status]));

test('scan classifies each skill against the template history', async t => {
  const data = await fixture(t);
  const result = await scanSkills({ root: data.root, template: await data.opened() });
  assert.equal(result.repos.length, 1);
  const [repo] = result.repos;
  assert.equal(repo.id, 'owner/project');
  assert.deepEqual(statuses(repo), { alpha: 'behind', beta: 'customized', delta: 'new', epsilon: 'off', gamma: 'removed' });
  assert.deepEqual(repo.skills.find(skill => skill.name === 'beta').files, { changed: ['SKILL.md'], added: [], missing: [] });
});

test('apply pushes selected skills to main and leaves the working folder alone', async t => {
  const data = await fixture(t);
  const template = await data.opened();
  const log = [];
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', apply: ['alpha', 'delta', 'beta'], remove: [] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'pushed');
  const show = file => run('git', ['--git-dir', data.remote, 'show', `main:${file}`]);
  assert.equal(await show('.claude/skills/alpha/SKILL.md'), 'alpha v2\n');
  assert.equal(await show('.agents/skills/alpha/SKILL.md'), 'alpha native v2\n');
  assert.equal(await show('.claude/skills/delta/scripts/tool.mjs'), 'export {};\n');
  assert.equal(await show('.claude/skills/beta/SKILL.md'), 'beta edited here\n');
  assert.equal(await show('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
  assert.deepEqual(JSON.parse(await show('.agents/skill-modes.json')).skills, { alpha: 'native', delta: 'native' });
  assert.match(await run('git', ['--git-dir', data.remote, 'log', '-1', '--format=%B', 'main']), /Updated: alpha\nAdded: delta\nTemplate: /);
  assert.match(log.join(''), /skipped beta, now customized/);
  assert.equal(await readFile(path.join(data.folder, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'uncommitted work\n');
  assert.equal((await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
  const again = await scanSkills({ root: data.root, template });
  assert.deepEqual(statuses(again.repos[0]), { alpha: 'same', beta: 'customized', delta: 'same', epsilon: 'off', gamma: 'removed' });

  const [removal] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(removal.result, 'pushed');
  await assert.rejects(show('.claude/skills/gamma/SKILL.md'));
});

test('a generator check that newly fails blocks the push', async t => {
  const script = "import fs from 'node:fs';\nif (fs.existsSync('.claude/skills/delta')) { console.error('delta breaks the check'); process.exit(1); }\n";
  const data = await fixture(t, { targetScript: script });
  const before = (await run('git', ['--git-dir', data.remote, 'rev-parse', 'main'])).trim();
  await assert.rejects(applySkills({ root: data.root, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['delta'] }] }), /1 of 1 repositories failed/);
  assert.equal((await run('git', ['--git-dir', data.remote, 'rev-parse', 'main'])).trim(), before);
  assert.equal((await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
});

test('a repository without native-mode support keeps its generated Codex adapter', async t => {
  const data = await fixture(t, { noModes: true });
  const [outcome] = await applySkills({ root: data.root, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha', 'delta'] }] });
  assert.equal(outcome.result, 'pushed');
  const show = file => run('git', ['--git-dir', data.remote, 'show', `main:${file}`]);
  assert.equal(await show('.claude/skills/alpha/SKILL.md'), 'alpha v2\n');
  assert.equal(await show('.agents/skills/alpha/SKILL.md'), 'alpha native v1\n');
  await assert.rejects(show('.agents/skills/delta/SKILL.md'));
  await assert.rejects(show('.agents/skill-modes.json'));
});

test('a Codex mode the repository chose survives the sync', async t => {
  const data = await fixture(t, { targetModes: { alpha: 'disabled' } });
  const [outcome] = await applySkills({ root: data.root, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }] });
  assert.equal(outcome.result, 'pushed');
  const show = file => run('git', ['--git-dir', data.remote, 'show', `main:${file}`]);
  assert.equal(await show('.claude/skills/alpha/SKILL.md'), 'alpha v2\n');
  assert.equal(await show('.agents/skills/alpha/SKILL.md'), 'alpha native v1\n');
  assert.deepEqual(JSON.parse(await show('.agents/skill-modes.json')).skills, { alpha: 'disabled' });
});

const ADAPTER = '<!-- Generated by .claude/scripts/sync-codex-skills.mjs. Do not edit. -->\n# adapter\n';
const shows = data => file => run('git', ['--git-dir', data.remote, 'show', `main:${file}`]);

test('a skill turned off stays off even when its folder exists, and apply refuses it', async t => {
  const data = await fixture(t, { overrides: { epsilon: 'off', alpha: 'off' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  assert.equal(statuses(repo).alpha, 'off');
  const log = [];
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', apply: ['alpha'] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'current');
  assert.match(log.join(''), /skipped alpha, now off/);
  assert.equal(await shows(data)('.claude/skills/alpha/SKILL.md'), 'alpha v1\n');
});

test('a hand-written Codex copy of a new skill makes it customized, and apply leaves it', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/delta/SKILL.md': 'delta codex edited\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  const delta = repo.skills.find(skill => skill.name === 'delta');
  assert.equal(delta.status, 'customized');
  assert.deepEqual(delta.files, { changed: ['SKILL.md'], added: [], missing: [] });
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', apply: ['delta'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/delta/SKILL.md'), 'delta codex edited\n');
  await assert.rejects(shows(data)('.claude/skills/delta/SKILL.md'));
});

test('a generated or template Codex copy of a new skill keeps it new', async t => {
  for (const text of [ADAPTER, 'delta native\n']) {
    const data = await fixture(t, { extra: { '.agents/skills/delta/SKILL.md': text } });
    const [repo] = (await scanSkills({ root: data.root, template: await data.opened() })).repos;
    assert.equal(statuses(repo).delta, 'new');
  }
});

test('a retired skill with an edited Codex copy is removed-edited, and apply keeps it', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/gamma/SKILL.md': 'gamma codex edited\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  assert.equal(statuses(repo).gamma, 'removed-edited');
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
  assert.equal(await shows(data)('.agents/skills/gamma/SKILL.md'), 'gamma codex edited\n');
});

test('a retired skill with a generated Codex adapter is removed with both folders', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/gamma/SKILL.md': ADAPTER } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  assert.equal(statuses(repo).gamma, 'removed');
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(outcome.result, 'pushed');
  await assert.rejects(shows(data)('.claude/skills/gamma/SKILL.md'));
  await assert.rejects(shows(data)('.agents/skills/gamma/SKILL.md'));
});

test('a retired skill whose Codex folder holds a marked SKILL.md plus a hand-written file is removed-edited, and apply keeps both', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/gamma/SKILL.md': ADAPTER, '.agents/skills/gamma/notes.md': 'my notes\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  assert.equal(statuses(repo).gamma, 'removed-edited');
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/gamma/SKILL.md'), ADAPTER);
  assert.equal(await shows(data)('.agents/skills/gamma/notes.md'), 'my notes\n');
  assert.equal(await shows(data)('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
});

test('a repository without native-mode support keeps a hand-written Codex copy of a new skill', async t => {
  const data = await fixture(t, { noModes: true, extra: { '.agents/skills/delta/SKILL.md': 'delta written here\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  assert.equal(statuses(repo).delta, 'customized');
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', apply: ['delta'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/delta/SKILL.md'), 'delta written here\n');
  await assert.rejects(shows(data)('.claude/skills/delta/SKILL.md'));
});

// A tracked symlink at the skill path is the real-world case; symlinks need special rights on
// Windows, so a regular file stands in: both are non-tree entries that ls-tree -d used to hide.
test('a file where a Codex skill folder belongs is never overwritten or deleted', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/delta': 'points elsewhere\n', '.agents/skills/gamma': 'points elsewhere\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, template })).repos;
  assert.equal(statuses(repo).delta, 'customized');
  assert.deepEqual(repo.skills.find(skill => skill.name === 'delta').files, { changed: [], added: [], missing: [] });
  assert.equal(statuses(repo).gamma, 'removed-edited');
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', apply: ['delta'], remove: ['gamma'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/delta'), 'points elsewhere\n');
  assert.equal(await shows(data)('.agents/skills/gamma'), 'points elsewhere\n');
  assert.equal(await shows(data)('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
});

test('a worktree that cannot be removed is retried once, then named in a warning', async t => {
  const data = await fixture(t);
  // Locking the worktree right after it is created makes `worktree remove --force` fail and keeps
  // prune from dropping its entry, so the leftover is real and deterministic on every platform.
  const removes = [];
  const execute = async (command, args, options) => {
    if (args[2] === 'worktree' && args[3] === 'remove') removes.push(args.at(-1));
    const out = await run(command, args, options);
    if (args[2] === 'worktree' && args[3] === 'add') await run('git', ['-C', args[1], 'worktree', 'lock', args[6]]);
    return out;
  };
  const log = [];
  const [outcome] = await applySkills({ root: data.root, template: await data.opened(), execute, selection: [{ id: 'owner/project', apply: ['alpha'] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'pushed');
  assert.equal(removes.length, 2);
  assert.equal(removes[0], removes[1]);
  const warning = log.find(line => line.includes('warning'));
  assert.ok(warning, log.join(''));
  assert.equal(warning, `owner/project: warning, could not remove temporary worktree ${path.dirname(removes[0])}; remove it by hand\n`);
});

test('cleanup removes only its own worktree registration, never the user\'s stale ones', async t => {
  const data = await fixture(t);
  // A worktree the user made whose folder is gone (an unplugged drive): prune would drop it.
  const other = path.join(data.temp, 'elsewhere');
  await run('git', ['-C', data.folder, 'worktree', 'add', '--quiet', '--detach', other]);
  await rm(other, { recursive: true, force: true });
  const listed = async () => (await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length;
  assert.equal(await listed(), 2);
  const [outcome] = await applySkills({ root: data.root, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }] });
  assert.equal(outcome.result, 'pushed');
  assert.equal(await listed(), 2);
  assert.match(await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain']), /elsewhere/);
});

test('githubId accepts only GitHub remotes', () => {
  for (const url of ['https://github.com/o/r', 'https://github.com/o/r.git', 'https://github.com/o/r/', 'https://GitHub.COM/o/r.git', ' https://github.com/o/r \n',
    'https://user@github.com/o/r.git', 'https://x-access-token:tok@github.com/o/r', 'git@github.com:o/r.git', 'git@GITHUB.com:o/r', 'ssh://git@github.com/o/r.git', 'ssh://git@github.com/o/r']) {
    assert.equal(githubId(url), 'o/r', url);
  }
  for (const url of ['https://notgithub.com/o/r', 'https://github.com.evil.test/o/r', 'https://evil.test/github.com/o/r', 'https://github.com@evil.test/o/r',
    'https://evil.test#@github.com/o/r', 'https://evil.test?@github.com/o/r', 'https://evil.test\\@github.com/o/r', 'git@notgithub.com:o/r', 'git@github.com.evil.test:o/r', 'ssh://git@evil.test/github.com/o/r', 'https://github.com/o/r/extra',
    'C:\\Users\\me\\github.com\\o\\r', '/srv/github.com/o/r', '../github.com/o/r', 'file:///srv/github.com/o/r', 'github.com/o/r', '', undefined]) {
    assert.equal(githubId(url), null, String(url));
  }
});

test('selection validation rejects bad names and duplicates', () => {
  assert.throws(() => normalizeSelection([]));
  assert.throws(() => normalizeSelection([{ id: 'owner/project', apply: ['../x'] }]), /Invalid skill name/);
  assert.throws(() => normalizeSelection([{ id: 'owner/project' }, { id: 'owner/project' }]), /twice/);
  assert.deepEqual(normalizeSelection([{ id: 'owner/project', apply: ['a', 'a'] }]), [{ id: 'owner/project', apply: ['a'], remove: [], replace: [] }]);
  assert.throws(() => normalizeSelection([{ id: 'owner/project', replace: ['../x'] }]), /Invalid skill name/);
});

test('replacing an edited copy pushes the template copy and drops a hand-written Codex copy', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/beta/SKILL.md': 'beta codex by hand\n' } });
  const template = await data.opened();
  const beta = (await scanSkills({ root: data.root, template })).repos[0].skills.find(skill => skill.name === 'beta');
  assert.equal(beta.status, 'customized');
  assert.equal(beta.handCodex, true);
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', replace: [{ name: 'beta', trees: beta.trees }] }] });
  assert.equal(outcome.result, 'pushed');
  assert.equal(await shows(data)('.claude/skills/beta/SKILL.md'), 'beta v1\n');
  await assert.rejects(shows(data)('.agents/skills/beta/SKILL.md'));
  assert.match(await run('git', ['--git-dir', data.remote, 'log', '-1', '--format=%B', 'main']), /Replaced edited copies: beta\nTemplate: /);
  assert.equal(statuses((await scanSkills({ root: data.root, template })).repos[0]).beta, 'same');
});

test('an edited copy changed again since the check is not replaced', async t => {
  const data = await fixture(t);
  const template = await data.opened();
  const beta = (await scanSkills({ root: data.root, template })).repos[0].skills.find(skill => skill.name === 'beta');
  const log = [];
  const [outcome] = await applySkills({ root: data.root, template, selection: [{ id: 'owner/project', replace: [{ name: 'beta', trees: `${beta.trees}x` }, { name: 'alpha', trees: beta.trees }] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'current');
  assert.match(log.join(''), /skipped beta, edited again on GitHub since the check/);
  assert.match(log.join(''), /skipped alpha, now behind on GitHub/);
  assert.equal(await shows(data)('.claude/skills/beta/SKILL.md'), 'beta edited here\n');
});

test('checkouts still on an older template copy than main are listed, edited copies are not', async t => {
  const data = await fixture(t);
  // A worktree cut from main while alpha was v1; then main moves to the current alpha.
  const old = path.join(data.temp, 'wt-old');
  await run('git', ['-C', data.folder, 'worktree', 'add', '-q', '-b', 'feature', old, 'origin/main']);
  // A second one turns alpha off, so its sessions never load the old copy.
  const off = path.join(data.temp, 'wt-off');
  await run('git', ['-C', data.folder, 'worktree', 'add', '-q', '-b', 'no-alpha', off, 'origin/main']);
  await put(off, '.claude/settings.json', json({ skillOverrides: { epsilon: 'off', alpha: 'off' } })); await commit(off, 'alpha off');
  const pusher = path.join(data.temp, 'pusher'); await run('git', ['clone', '-q', data.remote, pusher]);
  await put(pusher, '.claude/skills/alpha/SKILL.md', 'alpha v2\n'); await put(pusher, '.agents/skills/alpha/SKILL.md', 'alpha native v2\n');
  await commit(pusher, 'sync alpha'); await run('git', ['-C', pusher, 'push', '-q', 'origin', 'main']);
  await run('git', ['-C', data.folder, 'fetch', '-q', 'origin', 'main']);
  const found = await staleWorktrees({ template: await data.opened(), folder: data.folder });
  const byPath = Object.fromEntries(found.map(entry => [entry.path.toLowerCase(), entry]));
  const tree = byPath[path.resolve(old).toLowerCase()];
  assert.deepEqual(tree.skills, ['alpha']);
  assert.equal(tree.branch, 'feature'); assert.equal(tree.own, false);
  // The clone's own checkout was never pulled, so it is on the old alpha too; beta is edited, not old.
  const own = byPath[path.resolve(data.folder).toLowerCase()];
  assert.deepEqual(own.skills, ['alpha']); assert.equal(own.own, true);
  assert.equal(byPath[path.resolve(off).toLowerCase()], undefined);
  // Once main is merged into the branch it drops off the list.
  await run('git', ['-C', old, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'merge', '-q', '--no-edit', 'origin/main']);
  const after = await staleWorktrees({ template: await data.opened(), folder: data.folder });
  assert.equal(after.some(entry => entry.path.toLowerCase() === path.resolve(old).toLowerCase()), false);
});

test('a checkout newer than an out-of-date main is not called stale', async t => {
  const data = await fixture(t);
  // Main keeps alpha v1; the worktree moves to v2; the template has since moved on to a v3.
  const ahead = path.join(data.temp, 'wt-ahead');
  await run('git', ['-C', data.folder, 'worktree', 'add', '-q', '-b', 'ahead', ahead, 'origin/main']);
  await put(ahead, '.claude/skills/alpha/SKILL.md', 'alpha v2\n'); await put(ahead, '.agents/skills/alpha/SKILL.md', 'alpha native v2\n'); await commit(ahead, 'alpha v2');
  const template = await data.opened();
  const tree = async (dir, rev, part) => (await run('git', ['-C', dir, 'rev-parse', `${rev}:${part}/alpha`])).trim();
  const v1 = { claude: await tree(data.folder, 'origin/main', '.claude/skills'), agents: await tree(data.folder, 'origin/main', '.agents/skills') };
  const v2 = { claude: await tree(ahead, 'HEAD', '.claude/skills'), agents: await tree(ahead, 'HEAD', '.agents/skills') };
  const v3 = { ...template, current: { ...template.current, '.claude/skills': new Map([...template.current['.claude/skills'], ['alpha', 'f'.repeat(40)]]), '.agents/skills': new Map([...template.current['.agents/skills'], ['alpha', 'e'.repeat(40)]]) },
    age: { '.claude/skills': new Map([...template.age['.claude/skills'], ['alpha', new Map([['f'.repeat(40), 0], [v2.claude, 1], [v1.claude, 2]])]]), '.agents/skills': new Map([...template.age['.agents/skills'], ['alpha', new Map([['e'.repeat(40), 0], [v2.agents, 1], [v1.agents, 2]])]]) } };
  const found = await staleWorktrees({ template: v3, folder: data.folder });
  assert.equal(found.some(entry => entry.path.toLowerCase() === path.resolve(ahead).toLowerCase()), false);
});

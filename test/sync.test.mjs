import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../core.mjs';
import { applySkills, compareSkill, githubId, normalizeSelection, openTemplate, readSkipList, scanSkills, skillStory, skipReason, staleWorktrees } from '../sync.mjs';

// No test reaches GitHub. Every sync call gets the fixture's execute, which answers gh itself, and git
// remotes are rewritten to local bare repositories. As a backstop, gh runs with an empty config and no
// token, so a call that escapes the stub fails on authentication before sending anything.
const ghHome = await mkdtemp(path.join(tmpdir(), 'corewise-sync-gh-'));
after(() => rm(ghHome, { recursive: true, force: true }));
process.env.GH_CONFIG_DIR = ghHome;
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[name];

const put = async (dir, file, text) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), text); };
const commit = async (dir, message) => { await run('git', ['-C', dir, 'add', '-A']); await run('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message]); };
const json = value => `${JSON.stringify(value, null, 2)}\n`;

// Stands in for gh: records every call, answers the repository lookup, pull request creation and
// merge (onMerge moves main on the local remote), and fails on anything else. Git pushes and fetches are recorded too, so a test can prove none targets
// main and a skipped clone is never fetched.
function fakeGitHub() {
  const gh = { calls: [], pushes: [], fetches: [], archived: false, fail: null, prFail: null, mergeFail: null, queued: false, merged: false, head: null, onMerge: async () => {}, name: 'owner/project', branch: 'main', pr: 'https://github.com/owner/project/pull/7' };
  gh.execute = async (command, args, options) => {
    if (command === 'git' && args.includes('push')) gh.pushes.push(args);
    if (command === 'git' && args.includes('fetch')) gh.fetches.push(args);
    if (command !== 'gh') return run(command, args, options);
    gh.calls.push(args);
    if (gh.fail) throw new Error(gh.fail);
    if (args[0] === 'api') return `${JSON.stringify({ archived: gh.archived, name: gh.name, branch: gh.branch })}\n`;
    if (args[0] === 'pr' && args[1] === 'create') { if (gh.prFail) throw new Error(gh.prFail); gh.head = args[args.indexOf('--head') + 1]; return `${gh.pr}\n`; }
    if (args[0] === 'pr' && args[1] === 'merge') { if (gh.mergeFail) throw new Error(gh.mergeFail); gh.merged = !gh.queued; if (gh.merged) await gh.onMerge(gh.head); return ''; }
    if (args[0] === 'pr' && args[1] === 'view') return `${gh.merged ? 'MERGED' : 'OPEN'}\n`;
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return gh;
}

// Template: alpha (native Codex copy) changes, gamma is retired, delta and epsilon are new.
// Target: alpha at the old version, beta edited locally, gamma untouched, epsilon turned off,
// plus a local-only skill and an uncommitted edit in the working folder.
async function fixture(t, { targetScript, noModes, targetModes, overrides = { epsilon: 'off' }, extra = {} } = {}) {
  // The long real path, the form `git worktree list` prints; tmpdir() can be an 8.3 short name
  // (the CI runner) or a junction.
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'corewise-sync-')));
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
  const gh = fakeGitHub();
  // Stands in for the squash merge on GitHub: main fast-forwards to the sync branch.
  gh.onMerge = branch => run('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', `refs/heads/${branch}`]);
  return { temp, root, folder, remote, opened, gh, execute: gh.execute };
}

const statuses = repo => Object.fromEntries(repo.skills.map(skill => [skill.name, skill.status]));
const revOf = async (data, ref) => (await run('git', ['--git-dir', data.remote, 'rev-parse', '--verify', '-q', ref]).catch(() => '')).trim();
const syncBranches = async data => (await run('git', ['--git-dir', data.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/harness-sync'])).split(/\r?\n/).filter(Boolean);
const flag = (args, name) => args[args.indexOf(name) + 1];
const prCalls = data => data.gh.calls.filter(args => args[0] === 'pr');

test('scan classifies each skill against the template history', async t => {
  const data = await fixture(t);
  const result = await scanSkills({ root: data.root, execute: data.execute, template: await data.opened() });
  assert.equal(result.repos.length, 1);
  const [repo] = result.repos;
  assert.equal(repo.id, 'owner/project');
  assert.deepEqual(statuses(repo), { alpha: 'behind', beta: 'customized', delta: 'new', epsilon: 'off', gamma: 'removed' });
  assert.deepEqual(repo.skills.find(skill => skill.name === 'beta').files, { changed: ['SKILL.md'], added: [], missing: [] });
});

test('compare diffs the scanned main copy against the template copy a sync would write', async t => {
  const data = await fixture(t);
  const result = await scanSkills({ root: data.root, execute: data.execute, template: await data.opened() });
  const [repo] = result.repos;
  const diff = name => compareSkill({ folder: repo.folder, rev: repo.head, name, templateHead: result.template.head });
  // alpha is native here, so both copies show; the uncommitted working-folder edit does not.
  const alpha = await diff('alpha');
  for (const line of ['--- a/repo/.claude/skills/alpha/SKILL.md', '+++ b/harness-firmware/.claude/skills/alpha/SKILL.md', '-alpha v1', '+alpha v2', '--- a/repo/.agents/skills/alpha/SKILL.md', '-alpha native v1', '+alpha native v2']) assert.ok(alpha.includes(line), line);
  assert.ok(!alpha.includes('uncommitted work'));
  const beta = await diff('beta');
  assert.ok(beta.includes('-beta edited here') && beta.includes('+beta v1')); assert.ok(!beta.includes('.agents'));
  const delta = await diff('delta');
  assert.ok(delta.includes('+++ b/harness-firmware/.claude/skills/delta/scripts/tool.mjs') && delta.includes('+delta v1') && !/^-[^-]/m.test(delta));
  assert.ok((await diff('gamma')).includes('-gamma v1'));
  await assert.rejects(compareSkill({ folder: repo.folder, rev: repo.head, name: 'alpha', templateHead: 'other' }), /Check repositories again/);
  await assert.rejects(diff('mine'), /not a Harness skill/);
});

test('story names the last copy both sides shared and the commits each side made since', async t => {
  const data = await fixture(t);
  const result = await scanSkills({ root: data.root, execute: data.execute, template: await data.opened() });
  const [repo] = result.repos;
  const story = name => skillStory({ folder: repo.folder, rev: repo.head, name, templateHead: result.template.head });
  // alpha arrived as template v1 and was never edited; the template moved on to v2.
  const alpha = await story('alpha');
  assert.equal(alpha.base.repo.subject, 'spawned'); assert.equal(alpha.base.harness.subject, 'v1');
  assert.equal(alpha.repo.count, 0); assert.deepEqual(alpha.harness.since.map(item => item.subject), ['v2']); assert.equal(alpha.harness.count, 1);
  // The shared copy covers both folders, so the native Codex copy's lines can be credited too.
  assert.equal(alpha.baseFiles['.claude/skills/alpha/SKILL.md'], 'alpha v1\n'); assert.equal(alpha.baseFiles['.agents/skills/alpha/SKILL.md'], 'alpha native v1\n');
  assert.equal(alpha.repo.last.author, 'Test'); assert.match(alpha.repo.last.date, /^\d{4}-\d{2}-\d{2}T/);
  // beta was edited before its first commit here, so no copy ever matched the template.
  const beta = await story('beta');
  assert.equal(beta.base, null); assert.deepEqual(beta.repo.since.map(item => item.subject), ['spawned']); assert.deepEqual(beta.baseFiles, {});
  // An edit to the native Codex copy alone is a change made here since both copies matched.
  await writeFile(path.join(data.folder, '.agents/skills/alpha/SKILL.md'), 'alpha native edited\n');
  await run('git', ['-C', data.folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'codex edit', '--', '.agents/skills/alpha/SKILL.md']);
  const edited = await skillStory({ folder: repo.folder, rev: 'HEAD', name: 'alpha', templateHead: result.template.head });
  assert.deepEqual(edited.repo.since.map(item => item.subject), ['codex edit']); assert.equal(edited.base.repo.subject, 'spawned');
  await assert.rejects(skillStory({ folder: repo.folder, rev: repo.head, name: 'alpha', templateHead: 'other' }), /Check repositories again/);
});

test('compare shows a file where a skill folder belongs and every folder a removal deletes', async t => {
  const adapter = '<!-- Generated by .claude/scripts/sync-codex-skills.mjs. Do not edit. -->\ngamma adapter\n';
  const data = await fixture(t, { extra: { '.claude/skills/delta': 'a file here\n', '.agents/skills/gamma/SKILL.md': adapter } });
  const result = await scanSkills({ root: data.root, execute: data.execute, template: await data.opened() });
  const [repo] = result.repos;
  assert.equal(statuses(repo).delta, 'customized');
  const delta = await compareSkill({ folder: repo.folder, rev: repo.head, name: 'delta', templateHead: result.template.head });
  assert.ok(delta.includes('-a file here') && delta.includes('+delta v1'), delta);
  assert.equal(statuses(repo).gamma, 'removed');
  const gamma = await compareSkill({ folder: repo.folder, rev: repo.head, name: 'gamma', templateHead: result.template.head });
  assert.ok(gamma.includes('-gamma v1') && gamma.includes('-gamma adapter') && !/^\+[^+]/m.test(gamma), gamma);
});

test('apply merges a pull request from a new branch, deletes the branch and leaves the working folder alone', async t => {
  const data = await fixture(t);
  const template = await data.opened();
  const log = [];
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['alpha', 'delta', 'beta'], remove: [] }], onOutput: text => log.push(text) });
  const branch = `harness-sync/${template.head.slice(0, 7)}`;
  assert.equal(outcome.result, 'merged');
  assert.equal(outcome.branch, branch);
  assert.equal(outcome.url, data.gh.pr);
  // Main moved only through the merge; the push wrote the new branch and then deleted it.
  assert.equal(await revOf(data, 'main'), outcome.commit);
  assert.deepEqual(await syncBranches(data), []);
  assert.deepEqual(data.gh.pushes.map(args => args.slice(args.indexOf('origin') + 1)), [[`HEAD:refs/heads/${branch}`], ['--delete', branch]]);
  const show = shows(data, outcome.commit);
  assert.equal(await show('.claude/skills/alpha/SKILL.md'), 'alpha v2\n');
  assert.equal(await show('.agents/skills/alpha/SKILL.md'), 'alpha native v2\n');
  assert.equal(await show('.claude/skills/delta/scripts/tool.mjs'), 'export {};\n');
  assert.equal(await show('.claude/skills/beta/SKILL.md'), 'beta edited here\n');
  assert.equal(await show('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
  assert.deepEqual(JSON.parse(await show('.agents/skill-modes.json')).skills, { alpha: 'native', delta: 'native' });
  assert.match(await run('git', ['--git-dir', data.remote, 'log', '-1', '--format=%B', outcome.commit]), /^Sync skills from Harness-Firmware\n\nUpdated: alpha\nAdded: delta\nTemplate: /);
  // One pull request: this repository, into main, from the new branch, with the changes and checks, then squash-merged.
  const [create, merged, view] = prCalls(data);
  assert.equal(prCalls(data).length, 3);
  assert.deepEqual(create.slice(0, 2), ['pr', 'create']);
  assert.deepEqual(merged, ['pr', 'merge', data.gh.pr, '--squash']);
  assert.deepEqual(view.slice(0, 3), ['pr', 'view', data.gh.pr]);
  assert.equal(flag(create, '--repo'), 'owner/project'); assert.equal(flag(create, '--base'), 'main'); assert.equal(flag(create, '--head'), branch);
  assert.equal(flag(create, '--title'), 'Sync skills from Harness-Firmware');
  const body = flag(create, '--body');
  assert.match(body, new RegExp(`^Updated: alpha\\nAdded: delta\\nTemplate: ryanportfolio/Harness-Firmware@${template.head.slice(0, 7)}\\n`));
  assert.match(body, /- sync-codex-skills\.mjs: not in this repository, not run/);
  assert.match(log.join(''), /skipped beta, now customized/);
  assert.match(log.join(''), new RegExp(`merged ${data.gh.pr} \\(Updated: alpha; Added: delta\\)`));
  assert.equal(await readFile(path.join(data.folder, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'uncommitted work\n');
  assert.equal((await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
  const again = await scanSkills({ root: data.root, execute: data.execute, template });
  assert.deepEqual(statuses(again.repos[0]), { alpha: 'same', beta: 'customized', delta: 'same', epsilon: 'off', gamma: 'removed' });

  // A branch left from an earlier sync of the same template version is never overwritten: the next
  // sync gets a suffixed branch.
  await run('git', ['--git-dir', data.remote, 'update-ref', `refs/heads/${branch}`, outcome.commit]);
  const [removal] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(removal.result, 'merged');
  assert.equal(removal.branch, `${branch}-2`);
  assert.equal(await revOf(data, branch), outcome.commit);
  assert.equal(flag(prCalls(data)[3], '--head'), `${branch}-2`);
  await assert.rejects(shows(data, removal.commit)('.claude/skills/gamma/SKILL.md'));
  assert.equal(await revOf(data, 'main'), removal.commit);
});

test('a check that passed on main and fails after the change blocks the commit, push and pull request', async t => {
  const breaks = "import fs from 'node:fs';\nif (fs.existsSync('.claude/skills/delta')) { console.error('delta breaks the check'); process.exit(1); }\n";
  for (const [label, setup] of [['sync-codex-skills.mjs --check', { targetScript: breaks }], ['test-codex-contract.mjs', { extra: { '.claude/scripts/test-codex-contract.mjs': breaks } }]]) {
    const data = await fixture(t, setup);
    const before = await revOf(data, 'main');
    const failure = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['delta'] }] }).catch(error => error);
    assert.match(failure.message, /1 of 1 repositories failed/);
    assert.equal(failure.results[0].error, `${label} fails after the change: delta breaks the check`);
    assert.equal(await revOf(data, 'main'), before);
    assert.deepEqual(await syncBranches(data), []);
    assert.deepEqual(data.gh.pushes, []); assert.deepEqual(prCalls(data), []);
    assert.equal((await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
  }
});

test('a check already failing on main still opens the pull request, which reports every check', async t => {
  const data = await fixture(t, {
    targetScript: "console.error('broken on main'); process.exit(1);\n",
    extra: {
      '.claude/scripts/test-codex-contract.mjs': "console.log('contract ok');\n",
      '.claude/scripts/removed-skills.mjs': "console.log('WARN: gamma: not installed in any runtime');\nconsole.log('No skills recorded as removed.');\n",
    },
  });
  const log = [];
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'merged');
  const body = flag(prCalls(data)[0], '--body');
  assert.match(body, /- sync-codex-skills\.mjs --check: already failing on main \(broken on main\); still fails after this change \(broken on main\)/);
  assert.match(body, /- test-codex-contract\.mjs: passed on main and after this change/);
  assert.match(body, /- removed-skills\.mjs: 1 warning, not blocking:\n {2}- gamma: not installed in any runtime/);
  assert.match(log.join(''), /sync-codex-skills\.mjs --check was already failing on main; opening the pull request anyway/);
});

test('skip-listed, archived and unverifiable repositories are listed with the reason and never written', async t => {
  const data = await fixture(t);
  const template = await data.opened();
  const main = await revOf(data, 'main');
  const scan = async (skip = []) => (await scanSkills({ root: data.root, execute: data.execute, template, skip })).repos[0];
  const attempt = (skip = []) => applySkills({ root: data.root, execute: data.execute, template, skip, selection: [{ id: 'owner/project', apply: ['alpha'] }] }).catch(error => error);

  // The skip list matches the repository name in any case, and is read before GitHub is asked.
  const skip = [{ repo: 'Owner/Project', reason: 'Frozen job take-home' }];
  const listed = await scan(skip);
  assert.equal(listed.skipped, 'Frozen job take-home'); assert.equal(listed.skills, undefined);
  assert.equal((await attempt(skip)).results[0].error, 'Skipped: Frozen job take-home.');
  assert.deepEqual(data.gh.calls, []);

  data.gh.archived = true;
  const archived = await scan();
  assert.equal(archived.skipped, 'Archived on GitHub'); assert.equal(archived.skills, undefined);
  assert.match((await attempt()).results[0].error, /Archived on GitHub/);

  data.gh.archived = false; data.gh.fail = 'HTTP 502: Bad Gateway';
  const unknown = await scan();
  assert.match(unknown.error, /Could not check the repository on GitHub, so it cannot be synced\. HTTP 502/); assert.equal(unknown.skills, undefined);
  assert.match((await attempt()).results[0].error, /Could not check the repository on GitHub/);

  data.gh.fail = null; data.gh.branch = 'trunk';
  assert.match((await scan()).error, /default branch on GitHub is trunk/);
  assert.match((await attempt()).results[0].error, /default branch on GitHub is trunk/);

  assert.equal(await revOf(data, 'main'), main);
  assert.deepEqual(await syncBranches(data), []);
  assert.deepEqual(data.gh.pushes, []); assert.deepEqual(prCalls(data), []);
  assert.equal((await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
});

test('the skip list also matches the current GitHub name of a repository renamed since it was cloned', async t => {
  const data = await fixture(t);
  const template = await data.opened();
  const main = await revOf(data, 'main');
  // The origin still says owner/project; GitHub reports the repository under its new name.
  data.gh.name = 'owner/renamed';
  const skip = [{ repo: 'Owner/Renamed', reason: 'Frozen job take-home' }];

  const fetched = () => data.gh.fetches.filter(args => args.includes(data.folder));
  const scan = async () => (await scanSkills({ root: data.root, execute: data.execute, template, skip })).repos;
  const attempt = () => applySkills({ root: data.root, execute: data.execute, template, skip, selection: [{ id: 'owner/project', apply: ['alpha'] }] }).catch(error => error);

  // The scan asks GitHub first and never fetches the clone, so a failed fetch cannot hide the skip.
  const [repo] = await scan();
  assert.equal(repo.id, 'owner/project');
  assert.equal(repo.skipped, 'Frozen job take-home'); assert.equal(repo.skills, undefined);
  assert.deepEqual(data.gh.calls.map(args => args.slice(0, 2)), [['api', 'repos/owner/project']]);
  assert.deepEqual(fetched(), []);

  data.gh.calls.length = 0;
  const failure = await attempt();
  assert.equal(failure.results[0].result, 'failed');
  assert.equal(failure.results[0].error, 'Skipped: Frozen job take-home. Nothing was written.');
  // Only the repository lookup reached gh: no fetch, no push, no sync branch, no pull request, main unchanged.
  assert.deepEqual(data.gh.calls.map(args => args.slice(0, 2)), [['api', 'repos/owner/project']]);
  assert.deepEqual(fetched(), []);
  assert.deepEqual(data.gh.pushes, []); assert.deepEqual(prCalls(data), []);

  // The skip list still names the reason when GitHub also reports the repository archived or on another default branch.
  for (const state of [{ archived: true }, { branch: 'trunk' }]) {
    Object.assign(data.gh, { archived: false, branch: 'main' }, state);
    assert.equal((await scan())[0].skipped, 'Frozen job take-home');
    assert.equal((await attempt()).results[0].error, 'Skipped: Frozen job take-home. Nothing was written.');
    assert.deepEqual(fetched(), []);
  }
  assert.deepEqual(await syncBranches(data), []);
  assert.equal(await revOf(data, 'main'), main);
  assert.equal((await run('git', ['-C', data.folder, 'worktree', 'list', '--porcelain'])).match(/^worktree /gm).length, 1);
});

test('a clone that is not a Harness clone stays unlisted when its GitHub lookup fails or reports it archived', async t => {
  const data = await fixture(t);
  const seed = path.join(data.temp, 'plain-seed'); await run('git', ['init', '-q', '-b', 'main', seed]);
  await put(seed, 'README.md', 'not a Harness project\n'); await commit(seed, 'plain');
  const remote = path.join(data.temp, 'plain.git'); await run('git', ['clone', '-q', '--bare', seed, remote]);
  const folder = path.join(data.root, 'plain'); await run('git', ['clone', '-q', remote, folder]);
  await run('git', ['-C', folder, 'remote', 'set-url', 'origin', 'https://github.com/owner/plain.git']);
  await run('git', ['-C', folder, 'config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, 'https://github.com/owner/plain.git']);
  // GitHub answers for owner/plain here; owner/project still goes to the fixture's stub.
  let plain = null; const looked = [];
  const execute = async (command, args, options) => {
    if (command !== 'gh' || args[1] !== 'repos/owner/plain') return data.execute(command, args, options);
    looked.push(args);
    if (plain === 'fail') throw new Error('HTTP 502: Bad Gateway');
    return `${JSON.stringify({ archived: plain === 'archived', name: 'owner/plain', branch: plain === 'trunk' ? 'trunk' : 'main' })}\n`;
  };
  const template = await data.opened();
  for (const state of ['fail', 'archived', 'trunk']) {
    plain = state; looked.length = 0;
    const { repos } = await scanSkills({ root: data.root, execute, template, skip: [] });
    assert.deepEqual(repos.map(repo => repo.id), ['owner/project'], state);
    assert.equal(repos[0].error, undefined); assert.equal(repos[0].skipped, undefined); assert.ok(repos[0].skills.length);
    assert.equal(looked.length, 1, state);
  }
});

test('a pull request that cannot be opened names the pushed branch', async t => {
  const data = await fixture(t);
  data.gh.prFail = 'GraphQL: Resource not accessible by integration';
  const main = await revOf(data, 'main');
  const log = [];
  const failure = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }], onOutput: text => log.push(text) }).catch(error => error);
  const [result] = failure.results;
  assert.equal(result.result, 'failed');
  assert.equal(`refs/heads/${result.branch}`, (await syncBranches(data))[0]);
  assert.equal(result.error, `Pushed branch ${result.branch}, but could not open the pull request: GraphQL: Resource not accessible by integration. Open it on GitHub by hand.`);
  assert.match(log.join(''), /owner\/project: failed\. Pushed branch/);
  assert.equal(await revOf(data, 'main'), main);
});

test('a pull request GitHub refuses to merge stays open with its branch, and main is unchanged', async t => {
  const data = await fixture(t);
  data.gh.mergeFail = 'Pull request is not mergeable: base branch policy prohibits the merge';
  const main = await revOf(data, 'main');
  const failure = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }] }).catch(error => error);
  const [result] = failure.results;
  assert.equal(result.result, 'failed'); assert.equal(result.url, data.gh.pr);
  assert.equal(result.error, `Opened ${data.gh.pr}, but could not merge it: Pull request is not mergeable: base branch policy prohibits the merge. Merge it on GitHub by hand.`);
  assert.deepEqual(await syncBranches(data), [`refs/heads/${result.branch}`]);
  assert.equal(await revOf(data, 'main'), main);

  // A merge queue: gh pr merge succeeds but only queues the pull request, so the branch stays.
  const queued = await fixture(t);
  queued.gh.queued = true;
  const waiting = (await applySkills({ root: queued.root, execute: queued.execute, template: await queued.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }] }).catch(error => error)).results[0];
  assert.equal(waiting.result, 'failed'); assert.equal(waiting.url, queued.gh.pr);
  assert.match(waiting.error, /GitHub queued it instead of merging \(state OPEN\)/);
  assert.deepEqual(await syncBranches(queued), [`refs/heads/${waiting.branch}`]);
});

test('the committed skip list names the frozen repositories', async () => {
  const skip = await readSkipList();
  assert.deepEqual(skip.map(item => item.repo).sort(), ['ryanportfolio/cx-lab', 'ryanportfolio/threejs-interview-test']);
  assert.ok(skip.every(item => item.reason.trim()));
});

test('a skip list entry with an empty or blank reason stops the sync when the list is read', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'corewise-skip-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const [name, reason] of [['empty', ''], ['blank', ' \t ']]) {
    const file = path.join(temp, `${name}.json`);
    await writeFile(file, json({ version: 1, skip: [{ repo: 'owner/kept', reason: 'Frozen job take-home' }, { repo: 'owner/frozen', reason }] }));
    await assert.rejects(readSkipList(file), { message: `${name}.json: the entry for "owner/frozen" has an empty reason; say why the repository is never synced` }, name);
  }
});

test('a listed repository is skipped whatever its reason says', async t => {
  // The lookup tells "not listed" (null) apart from any reason, an empty one included.
  assert.equal(skipReason([{ repo: 'Owner/Project', reason: '' }], 'owner/project'), '');
  assert.equal(skipReason([{ repo: 'Owner/Project', reason: '' }], 'owner/other'), null);

  // A list handed in directly skips validation, so an empty reason must still keep the clone untouched.
  const data = await fixture(t);
  const template = await data.opened();
  const main = await revOf(data, 'main');
  const fetched = () => data.gh.fetches.filter(args => args.includes(data.folder));
  for (const skip of [[{ repo: 'owner/project', reason: '' }], [{ repo: 'owner/renamed', reason: '' }]]) {
    data.gh.name = skip[0].repo;
    const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template, skip })).repos;
    assert.equal(repo.skipped, ''); assert.equal(repo.skills, undefined);
    const failure = await applySkills({ root: data.root, execute: data.execute, template, skip, selection: [{ id: 'owner/project', apply: ['alpha'] }] }).catch(error => error);
    assert.equal(failure.results[0].result, 'failed');
  }
  assert.deepEqual(fetched(), []);
  assert.deepEqual(data.gh.pushes, []); assert.deepEqual(prCalls(data), []);
  assert.deepEqual(await syncBranches(data), []);
  assert.equal(await revOf(data, 'main'), main);
});

// Same hash as the template's sync-codex-skills.mjs: "<path>\0<length>\0<bytes>" per file in sorted
// path order, CRLF folded to LF in text files.
const sourceHash = files => {
  const hash = createHash('sha256');
  for (const name of Object.keys(files).sort()) { const bytes = Buffer.from(files[name]); hash.update(`${name}\0${bytes.length}\0`); hash.update(bytes); }
  return hash.digest('hex');
};
// The template's rule, reduced: a native skill with a Claude folder must match its recorded source hash.
const SOURCES_CHECK = [
  "import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';",
  "const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));",
  "const modes = read('.agents/skill-modes.json').skills, sources = read('.agents/skill-sources.json').skills;",
  "const hash = base => { const files = []; (function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else files.push(path.relative(base, full).split(path.sep).join('/')); } })(base);",
  "  const h = crypto.createHash('sha256'); for (const rel of files.sort()) { let c = fs.readFileSync(path.join(base, rel)); if (!c.includes(0)) c = Buffer.from(c.toString('latin1').replaceAll('\\r\\n', '\\n'), 'latin1'); h.update(rel + '\\0' + c.length + '\\0'); h.update(c); } return h.digest('hex'); };",
  "for (const [name, mode] of Object.entries(modes)) { const dir = path.join('.claude', 'skills', name); if (mode !== 'native' || !fs.existsSync(path.join(dir, 'SKILL.md'))) continue;",
  "  if (sources[name] !== hash(dir)) { console.error(name + ': the Claude skill changed since its Codex port was last reviewed'); process.exit(1); } }",
  '',
].join('\n');

test('a synced native skill takes the template source hash, so the check still passes', async t => {
  const delta = { 'SKILL.md': 'delta v1\n', 'scripts/tool.mjs': 'export {};\n' };
  const data = await fixture(t, { targetScript: SOURCES_CHECK, extra: { '.agents/skill-sources.json': json({ version: 1, skills: { gamma: sourceHash({ 'SKILL.md': 'gamma v1\n' }), alpha: sourceHash({ 'SKILL.md': 'alpha v1\n' }) } }) } });
  await changeTemplate(data, { '.agents/skill-sources.json': json({ version: 1, skills: { alpha: sourceHash({ 'SKILL.md': 'alpha v2\n' }), delta: sourceHash(delta) } }) }, 'record sources');
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha', 'delta'], remove: ['gamma'] }] });
  assert.equal(outcome.result, 'merged');
  // Updated and added native skills carry the template's hash; the removed skill's entry goes.
  assert.equal(await shows(data, outcome.commit)('.agents/skill-sources.json'), json({ version: 1, skills: { alpha: sourceHash({ 'SKILL.md': 'alpha v2\n' }), delta: sourceHash(delta) } }));
  assert.match(flag(prCalls(data)[0], '--body'), /- sync-codex-skills\.mjs --check: passed on main and after this change/);
});

test('a repository without native-mode support keeps its generated Codex adapter', async t => {
  const data = await fixture(t, { noModes: true });
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha', 'delta'] }] });
  assert.equal(outcome.result, 'merged');
  const show = shows(data, outcome.commit);
  assert.equal(await show('.claude/skills/alpha/SKILL.md'), 'alpha v2\n');
  assert.equal(await show('.agents/skills/alpha/SKILL.md'), 'alpha native v1\n');
  await assert.rejects(show('.agents/skills/delta/SKILL.md'));
  await assert.rejects(show('.agents/skill-modes.json'));
});

test('a Codex mode the repository chose survives the sync', async t => {
  const data = await fixture(t, { targetModes: { alpha: 'disabled' } });
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }] });
  assert.equal(outcome.result, 'merged');
  const show = shows(data, outcome.commit);
  assert.equal(await show('.claude/skills/alpha/SKILL.md'), 'alpha v2\n');
  assert.equal(await show('.agents/skills/alpha/SKILL.md'), 'alpha native v1\n');
  assert.deepEqual(JSON.parse(await show('.agents/skill-modes.json')).skills, { alpha: 'disabled' });
});

const ADAPTER = '<!-- Generated by .claude/scripts/sync-codex-skills.mjs. Do not edit. -->\n# adapter\n';
const shows = (data, ref = 'main') => file => run('git', ['--git-dir', data.remote, 'show', `${ref}:${file}`]);
test('a skill turned off stays off even when its folder exists, and apply refuses it', async t => {
  const data = await fixture(t, { overrides: { epsilon: 'off', alpha: 'off' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.equal(statuses(repo).alpha, 'off');
  const log = [];
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['alpha'] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'current');
  assert.match(log.join(''), /skipped alpha, now off/);
  assert.equal(await shows(data)('.claude/skills/alpha/SKILL.md'), 'alpha v1\n');
});

test('a hand-written Codex copy of a new skill makes it customized, and apply leaves it', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/delta/SKILL.md': 'delta codex edited\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  const delta = repo.skills.find(skill => skill.name === 'delta');
  assert.equal(delta.status, 'customized');
  assert.deepEqual(delta.files, { changed: ['SKILL.md'], added: [], missing: [] });
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['delta'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/delta/SKILL.md'), 'delta codex edited\n');
  await assert.rejects(shows(data)('.claude/skills/delta/SKILL.md'));
});

test('a generated or template Codex copy of a new skill keeps it new', async t => {
  for (const text of [ADAPTER, 'delta native\n']) {
    const data = await fixture(t, { extra: { '.agents/skills/delta/SKILL.md': text } });
    const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template: await data.opened() })).repos;
    assert.equal(statuses(repo).delta, 'new');
  }
});

test('a retired skill with an edited Codex copy is removed-edited, and apply keeps it', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/gamma/SKILL.md': 'gamma codex edited\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.equal(statuses(repo).gamma, 'removed-edited');
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
  assert.equal(await shows(data)('.agents/skills/gamma/SKILL.md'), 'gamma codex edited\n');
});

test('a retired skill with a generated Codex adapter is removed with both folders', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/gamma/SKILL.md': ADAPTER } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.equal(statuses(repo).gamma, 'removed');
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(outcome.result, 'merged');
  await assert.rejects(shows(data, outcome.commit)('.claude/skills/gamma/SKILL.md'));
  await assert.rejects(shows(data, outcome.commit)('.agents/skills/gamma/SKILL.md'));
});

test('a retired skill whose Codex folder holds a marked SKILL.md plus a hand-written file is removed-edited, and apply keeps both', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/gamma/SKILL.md': ADAPTER, '.agents/skills/gamma/notes.md': 'my notes\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.equal(statuses(repo).gamma, 'removed-edited');
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', remove: ['gamma'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/gamma/SKILL.md'), ADAPTER);
  assert.equal(await shows(data)('.agents/skills/gamma/notes.md'), 'my notes\n');
  assert.equal(await shows(data)('.claude/skills/gamma/SKILL.md'), 'gamma v1\n');
});

test('a repository without native-mode support keeps a hand-written Codex copy of a new skill', async t => {
  const data = await fixture(t, { noModes: true, extra: { '.agents/skills/delta/SKILL.md': 'delta written here\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.equal(statuses(repo).delta, 'customized');
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['delta'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(data)('.agents/skills/delta/SKILL.md'), 'delta written here\n');
  await assert.rejects(shows(data)('.claude/skills/delta/SKILL.md'));
});

// A tracked symlink at the skill path is the real-world case; symlinks need special rights on
// Windows, so a regular file stands in: both are non-tree entries that ls-tree -d used to hide.
test('a file where a Codex skill folder belongs is never overwritten or deleted', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/delta': 'points elsewhere\n', '.agents/skills/gamma': 'points elsewhere\n' } });
  const template = await data.opened();
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.equal(statuses(repo).delta, 'customized');
  assert.deepEqual(repo.skills.find(skill => skill.name === 'delta').files, { changed: [], added: [], missing: [] });
  assert.equal(statuses(repo).gamma, 'removed-edited');
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['delta'], remove: ['gamma'] }] });
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
    const out = await data.execute(command, args, options);
    if (args[2] === 'worktree' && args[3] === 'add') await run('git', ['-C', args[1], 'worktree', 'lock', args[6]]);
    return out;
  };
  const log = [];
  const [outcome] = await applySkills({ root: data.root, template: await data.opened(), execute, selection: [{ id: 'owner/project', apply: ['alpha'] }], onOutput: text => log.push(text) });
  assert.equal(outcome.result, 'merged');
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
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template: await data.opened(), selection: [{ id: 'owner/project', apply: ['alpha'] }] });
  assert.equal(outcome.result, 'merged');
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

test('replacing an edited copy offers the template copy and drops a hand-written Codex copy', async t => {
  const data = await fixture(t, { extra: { '.agents/skills/beta/SKILL.md': 'beta codex by hand\n' } });
  const template = await data.opened();
  const beta = (await scanSkills({ root: data.root, execute: data.execute, template })).repos[0].skills.find(skill => skill.name === 'beta');
  assert.equal(beta.status, 'customized');
  assert.equal(beta.handCodex, true);
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', replace: [{ name: 'beta', trees: beta.trees }] }] });
  assert.equal(outcome.result, 'merged');
  assert.equal(await shows(data, outcome.commit)('.claude/skills/beta/SKILL.md'), 'beta v1\n');
  await assert.rejects(shows(data, outcome.commit)('.agents/skills/beta/SKILL.md'));
  assert.match(await run('git', ['--git-dir', data.remote, 'log', '-1', '--format=%B', outcome.commit]), /Replaced edited copies: beta\nTemplate: /);
  assert.match(flag(prCalls(data)[0], '--body'), /^Replaced edited copies: beta\n/);
  assert.equal(statuses((await scanSkills({ root: data.root, execute: data.execute, template })).repos[0]).beta, 'same');
});

test('an edited copy changed again since the check is not replaced', async t => {
  const data = await fixture(t);
  const template = await data.opened();
  const beta = (await scanSkills({ root: data.root, execute: data.execute, template })).repos[0].skills.find(skill => skill.name === 'beta');
  const log = [];
  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', replace: [{ name: 'beta', trees: `${beta.trees}x` }, { name: 'alpha', trees: beta.trees }] }], onOutput: text => log.push(text) });
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

// Codex-only skills: zeta has a SKILL.md under .agents/skills and no Claude copy; omega is a leftover
// folder without SKILL.md, which is not a skill.
async function changeTemplate(data, files, message) {
  const template = path.join(data.temp, 'template');
  for (const [file, text] of Object.entries(files)) {
    if (text === null) await rm(path.join(template, file), { recursive: true, force: true }); else await put(template, file, text);
  }
  await commit(template, message);
}

test('a Codex-only skill is offered, added as its .agents folder alone, then updated', async t => {
  const data = await fixture(t);
  await changeTemplate(data, {
    '.agents/skills/zeta/SKILL.md': 'zeta v1\n', '.agents/skills/omega/patterns.md': 'leftover\n',
    '.agents/skill-modes.json': json({ version: 1, skills: { alpha: 'native', delta: 'native', zeta: 'native' } }),
  }, 'codex only');
  let template = await data.opened();
  assert.deepEqual([...template.codexOnly], ['zeta']);
  const [repo] = (await scanSkills({ root: data.root, execute: data.execute, template })).repos;
  assert.deepEqual(repo.skills.find(skill => skill.name === 'zeta'), { name: 'zeta', codex: true, status: 'new' });
  assert.equal(repo.skills.some(skill => skill.name === 'omega'), false);

  const [outcome] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['zeta'] }] });
  assert.equal(outcome.result, 'merged');
  const added = shows(data, outcome.commit);
  assert.equal(await added('.agents/skills/zeta/SKILL.md'), 'zeta v1\n');
  await assert.rejects(added('.claude/skills/zeta/SKILL.md'));
  assert.equal(JSON.parse(await added('.agents/skill-modes.json')).skills.zeta, 'native');
  assert.match(await run('git', ['--git-dir', data.remote, 'log', '-1', '--format=%B', outcome.commit]), /Added: zeta\n/);

  await changeTemplate(data, { '.agents/skills/zeta/SKILL.md': 'zeta v2\n' }, 'zeta v2');
  template = await data.opened();
  assert.equal(statuses((await scanSkills({ root: data.root, execute: data.execute, template })).repos[0]).zeta, 'behind');
  const [update] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', apply: ['zeta'] }] });
  assert.equal(await shows(data, update.commit)('.agents/skills/zeta/SKILL.md'), 'zeta v2\n');

  // Retired with a leftover file still in the template folder: no SKILL.md, so no longer a skill.
  await changeTemplate(data, { '.agents/skills/zeta/SKILL.md': null, '.agents/skills/zeta/leftover.md': 'leftover\n' }, 'retire zeta');
  template = await data.opened();
  const retired = (await scanSkills({ root: data.root, execute: data.execute, template })).repos[0].skills.find(skill => skill.name === 'zeta');
  assert.deepEqual(retired, { name: 'zeta', codex: true, status: 'removed' });
  const [removal] = await applySkills({ root: data.root, execute: data.execute, template, selection: [{ id: 'owner/project', remove: ['zeta'] }] });
  await assert.rejects(shows(data, removal.commit)('.agents/skills/zeta/SKILL.md'));
  assert.equal(JSON.parse(await shows(data, removal.commit)('.agents/skill-modes.json')).skills.zeta, undefined);
});

test('a Codex-only skill is not offered without skill-modes.json, is off when disabled, and an edited copy is customized', async t => {
  const files = { '.agents/skills/zeta/SKILL.md': 'zeta v1\n', '.agents/skill-modes.json': json({ version: 1, skills: { alpha: 'native', delta: 'native', zeta: 'native' } }) };
  const none = await fixture(t, { noModes: true });
  await changeTemplate(none, files, 'codex only');
  assert.equal((await scanSkills({ root: none.root, execute: none.execute, template: await none.opened() })).repos[0].skills.some(skill => skill.name === 'zeta'), false);
  // Nor offered for removal once retired, even with the folder present.
  const noneRetired = await fixture(t, { noModes: true, extra: { '.agents/skills/zeta/SKILL.md': 'zeta v1\n' } });
  await changeTemplate(noneRetired, files, 'codex only');
  await changeTemplate(noneRetired, { '.agents/skills/zeta': null }, 'retire zeta');
  assert.equal((await scanSkills({ root: noneRetired.root, execute: noneRetired.execute, template: await noneRetired.opened() })).repos[0].skills.some(skill => skill.name === 'zeta'), false);

  const off = await fixture(t, { targetModes: { alpha: 'native', zeta: 'disabled' } });
  await changeTemplate(off, files, 'codex only');
  assert.equal(statuses((await scanSkills({ root: off.root, execute: off.execute, template: await off.opened() })).repos[0]).zeta, 'off');

  const edited = await fixture(t, { extra: { '.agents/skills/zeta/SKILL.md': 'zeta by hand\n' } });
  await changeTemplate(edited, files, 'codex only');
  const template = await edited.opened();
  const zeta = (await scanSkills({ root: edited.root, execute: edited.execute, template })).repos[0].skills.find(skill => skill.name === 'zeta');
  assert.equal(zeta.status, 'customized');
  assert.equal(zeta.codex, true);
  assert.deepEqual(zeta.files, { changed: ['SKILL.md'], added: [], missing: [] });
  const [outcome] = await applySkills({ root: edited.root, execute: edited.execute, template, selection: [{ id: 'owner/project', apply: ['zeta'] }] });
  assert.equal(outcome.result, 'current');
  assert.equal(await shows(edited)('.agents/skills/zeta/SKILL.md'), 'zeta by hand\n');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../core.mjs';
import { createProject, mergeSkillOverrides, normalizeDisabledSkills, skillCatalog, TEMPLATE_ONLY_PATHS } from '../harness.mjs';

const exists = target => access(target).then(() => true, () => false);
const catalog = { groups: [], skills: [{ name: 'init-project', required: true }, { name: 'lab' }, { name: 'recall' }] };

// A bare "template" repository standing in for GitHub: gh repo create becomes a plain clone of it,
// and the push at the end lands in the same bare repository so the remote side is observable.
async function fixture(t) {
  const temp = await mkdtemp(path.join(tmpdir(), 'corewise-harness-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const work = path.join(temp, 'template'); await mkdir(work);
  const files = {
    'AGENTS.md': 'agents', 'CLAUDE.md': 'claude', 'README.md': 'template readme', 'CHANGELOG.md': 'log', 'CONTRIBUTING.md': 'contrib',
    'bootstrap/new-claude-project.ps1': 'ps', '.claude-plugin/plugin.json': '{}', '.github/workflows/validate-template.yml': 'yml', '.github/ISSUE_TEMPLATE/bug.md': 'bug',
    '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, skillOverrides: { recall: 'off' } }, null, 2) + '\n',
    '.claude/scripts/sync-codex-skills.mjs': '// sync', '.claude/skills/init-project/SKILL.md': 'init', '.agents/skills/init-project/SKILL.md': 'init',
    '.claude/skills/lab/SKILL.md': 'lab', '.claude/skills/lab/reference.md': 'ref', '.agents/skills/lab/SKILL.md': 'lab', '.claude/skills/recall/SKILL.md': 'recall', '.agents/skills/recall/SKILL.md': 'recall',
  };
  for (const [relative, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(work, relative)), { recursive: true }); await writeFile(path.join(work, relative), content); }
  await run('git', ['init', '-q', '-b', 'main', work]);
  await run('git', ['-C', work, 'add', '-A']);
  await run('git', ['-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'template']);
  const bare = path.join(temp, 'remote.git');
  await run('git', ['clone', '-q', '--bare', work, bare]);
  const calls = [];
  const execute = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === 'gh' && args[0] === 'repo' && args[1] === 'create') return run('git', ['clone', '-q', bare, args[2]], { cwd: options.cwd });
    if (command === 'git' && args.includes('commit')) return run(command, [...args.slice(0, 2), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args.slice(2)], options);
    return run(command, args, options);
  };
  return { temp, bare, root: path.join(temp, 'CoreWise'), execute, calls };
}

test('createProject clones, strips template-only files, omits skills, commits and pushes', async t => {
  const data = await fixture(t);
  const log = [];
  const result = await createProject({ root: data.root, name: 'demo-app', description: 'A demo', isPrivate: true, disabledSkills: ['lab'], catalog, execute: data.execute, onOutput: text => log.push(text) });
  const destination = path.join(data.root, 'demo-app');
  assert.equal(result.destination, destination);
  assert.equal(result.remoteUrl, data.bare.replace(/\.git$/, ''));
  assert.deepEqual(result.disabledSkills, ['lab']);
  const create = data.calls.find(call => call[0] === 'gh');
  assert.deepEqual(create, ['gh', 'repo', 'create', 'demo-app', '--template', 'ryanportfolio/Harness-Firmware', '--private', '--clone', '--description', 'A demo']);
  for (const relative of TEMPLATE_ONLY_PATHS) assert.equal(await exists(path.join(destination, relative)), false, relative);
  assert.equal(await exists(path.join(destination, '.github')), false);
  assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), '# demo-app\n');
  assert.equal(await exists(path.join(destination, '.claude', 'skills', 'lab')), false);
  assert.equal(await exists(path.join(destination, '.agents', 'skills', 'lab')), false);
  assert.equal(await exists(path.join(destination, '.claude', 'skills', 'recall', 'SKILL.md')), true);
  const settings = JSON.parse(await readFile(path.join(destination, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.skillOverrides, { lab: 'off' });
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.equal((await run('git', ['-C', destination, 'status', '--porcelain'])).trim(), '');
  assert.deepEqual((await run('git', ['-C', destination, 'log', '--format=%s'])).trim().split('\n'), ['Configure Harness skills', 'Strip template files, add README stub', 'template']);
  assert.equal((await run('git', ['-C', data.bare, 'log', '--format=%s', '-1', 'main'])).trim(), 'Configure Harness skills');
  assert.equal((await run('git', ['-C', destination, 'rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), 'origin/main');
  assert.match(log.join(''), /Omitting 1 skill: lab/);
});

test('createProject with every skill enabled makes one cleanup commit and leaves settings alone', async t => {
  const data = await fixture(t);
  await createProject({ root: data.root, name: 'plain', isPrivate: false, catalog, execute: data.execute });
  const destination = path.join(data.root, 'plain');
  assert.ok(data.calls.some(call => call[0] === 'gh' && call.includes('--public') && !call.includes('--description')));
  assert.deepEqual((await run('git', ['-C', destination, 'log', '--format=%s'])).trim().split('\n'), ['Strip template files, add README stub', 'template']);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, '.claude', 'settings.json'), 'utf8')).skillOverrides, { recall: 'off' });
});

test('createProject refuses bad names, existing folders, and skill choices outside the catalog', async t => {
  const data = await fixture(t);
  await assert.rejects(createProject({ root: data.root, name: 'CON', catalog, execute: data.execute }), /Windows folder/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['init-project'], catalog, execute: data.execute }), /available list/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['nope'], catalog, execute: data.execute }), /available list/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['lab', 'lab'], catalog, execute: data.execute }), /available list/);
  await mkdir(path.join(data.root, 'Taken'), { recursive: true });
  await assert.rejects(createProject({ root: data.root, name: 'taken', catalog, execute: data.execute }), /already exists/);
  assert.equal(data.calls.filter(call => call[0] === 'gh').length, 0);
  assert.deepEqual(await readdir(data.root), ['Taken']);
});

test('normalizeDisabledSkills keeps catalog order and mergeSkillOverrides round-trips', () => {
  assert.deepEqual(normalizeDisabledSkills(['recall', 'lab'], catalog), ['lab', 'recall']);
  assert.deepEqual(normalizeDisabledSkills(undefined, catalog), []);
  assert.throws(() => normalizeDisabledSkills('lab', catalog));
  const merged = mergeSkillOverrides('{"skillOverrides":{"lab":"off","other":"on"}}', ['recall'], ['lab', 'recall']);
  assert.deepEqual(JSON.parse(merged), { skillOverrides: { other: 'on', recall: 'off' } });
  assert.equal(mergeSkillOverrides('{"skillOverrides":{"lab":"off"}}', [], ['lab']), '{}\n');
  assert.throws(() => mergeSkillOverrides('[]', [], []));
});

test('skillCatalog reads skill folders from the template tree and describes unknown ones from SKILL.md', async () => {
  const tree = { tree: [{ path: '.claude/skills/init-project/SKILL.md' }, { path: '.claude/skills/lab/SKILL.md' }, { path: '.claude/skills/lab/reference.md' }, { path: '.claude/skills/brand-new/SKILL.md' }, { path: '.agents/skills/ghost/SKILL.md' }] };
  const result = await skillCatalog({ execute: async (command, args) => {
    assert.equal(command, 'gh');
    if (args[1].includes('git/trees')) return JSON.stringify(tree);
    if (args[1].endsWith('brand-new/SKILL.md')) return '---\nname: brand-new\ndescription: "Do the new thing well. Use for /brand-new."\n---\n# body';
    throw new Error(`unexpected ${args[1]}`);
  } });
  assert.deepEqual(result.skills.map(skill => skill.name), ['init-project', 'lab', 'brand-new']);
  assert.equal(result.skills[0].required, true);
  assert.deepEqual(result.skills[2], { name: 'brand-new', label: 'Brand new', group: 'specialist', description: 'Do the new thing well' });
  await assert.rejects(skillCatalog({ execute: async () => JSON.stringify({ tree: [{ path: '.claude/skills/lab/SKILL.md' }] }) }), /init-project/);
});

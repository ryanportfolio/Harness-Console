import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../core.mjs';
import { createProject, mergeSkillOverrides, normalizeDisabledSkills, parseManifest, skillCatalog } from '../harness.mjs';

const exists = target => access(target).then(() => true, () => false);

// A version 1 manifest shaped like the template's. GUIDE.md and scripts/readme are template-only
// entries the old hard-coded list did not have; the stub text differs from the old '# name' so the
// README provably comes from the manifest.
const MANIFEST = {
  version: 1,
  template: 'ryanportfolio/Harness-Firmware',
  requiredFiles: ['.agents/template-manifest.json', 'AGENTS.md', '.agents/skills/init-project/SKILL.md', '.claude/skills/init-project/SKILL.md', '.claude/scripts/sync-codex-skills.mjs'],
  projectPaths: ['.agents', '.claude', 'AGENTS.md', 'CLAUDE.md', 'scripts/lib'],
  templateOnly: ['.claude-plugin', '.github/ISSUE_TEMPLATE', '.github/workflows/validate-template.yml', 'CHANGELOG.md', 'CONTRIBUTING.md', 'GUIDE.md', 'README.md', 'bootstrap', 'scripts/readme'],
  readmeStub: '# {name}\n\nStarted from Harness Firmware.\n',
  skills: {
    groups: [
      { id: 'core', label: 'Core workflows', description: 'Setup and memory', skills: ['init-project', 'recall'] },
      { id: 'review', label: 'Review tools', description: 'Fixture group copy from the manifest', skills: ['codex-review', 'external-review', 'ghost-review'] },
      { id: 'specialist', label: 'Specialist tools', description: 'Focused modes', skills: ['lab'] },
    ],
    required: ['external-review', 'init-project'],
    dependencies: { 'codex-review': ['external-review'], 'ghost-review': ['codex-review'] },
    presets: { minimal: { omit: ['lab'] } },
  },
};
const manifestText = (overrides = {}) => `${JSON.stringify({ ...MANIFEST, ...overrides }, null, 2)}\n`;

const catalog = {
  groups: [],
  skills: [{ name: 'init-project', required: true }, { name: 'recall' }, { name: 'codex-review' }, { name: 'external-review', required: true }, { name: 'ghost-review' }, { name: 'lab' }],
  dependencies: MANIFEST.skills.dependencies,
};

// A bare "template" repository standing in for GitHub: gh repo create becomes a plain clone of it,
// and the push at the end lands in the same bare repository so the remote side is observable.
// `manifest` is the template's manifest text; null leaves the file out.
async function fixture(t, { manifest = manifestText(), extra = {} } = {}) {
  // The long real path, the form createProject returns after resolving root; tmpdir() can be an
  // 8.3 short name (the CI runner) or a junction.
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'corewise-harness-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const work = path.join(temp, 'template'); await mkdir(work);
  const files = {
    'AGENTS.md': 'agents', 'CLAUDE.md': 'claude', 'README.md': 'template readme', 'CHANGELOG.md': 'log', 'CONTRIBUTING.md': 'contrib', 'GUIDE.md': 'guide',
    'bootstrap/new-claude-project.ps1': 'ps', '.claude-plugin/plugin.json': '{}', '.github/workflows/validate-template.yml': 'yml', '.github/ISSUE_TEMPLATE/bug.md': 'bug',
    'scripts/readme/build.mjs': '// readme', 'scripts/lib/launch-chrome.mjs': '// chrome',
    '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, skillOverrides: { recall: 'off' } }, null, 2) + '\n',
    '.claude/scripts/sync-codex-skills.mjs': '// sync', '.claude/skills/init-project/SKILL.md': 'init', '.agents/skills/init-project/SKILL.md': 'init',
    '.claude/skills/lab/SKILL.md': 'lab', '.claude/skills/lab/reference.md': 'ref', '.agents/skills/lab/SKILL.md': 'lab', '.claude/skills/recall/SKILL.md': 'recall', '.agents/skills/recall/SKILL.md': 'recall',
    '.claude/skills/codex-review/SKILL.md': 'codex', '.agents/skills/codex-review/SKILL.md': 'codex', '.agents/skills/external-review/SKILL.md': 'external', '.agents/skills/ghost-review/SKILL.md': 'ghost',
    ...extra,
  };
  if (manifest !== null) files['.agents/template-manifest.json'] = manifest;
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
    if (command === 'gh') throw new Error(`unexpected gh call: ${args.join(' ')}`);
    if (command === 'git' && args.includes('commit')) return run(command, [...args.slice(0, 2), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args.slice(2)], options);
    return run(command, args, options);
  };
  return { temp, bare, root: path.join(temp, 'CoreWise'), execute, calls };
}

const subjects = async directory => (await run('git', ['-C', directory, 'log', '--format=%s'])).trim().split('\n');

test('createProject clones, strips the manifest template-only paths, omits skills, records them, commits and pushes', async t => {
  const data = await fixture(t);
  const log = [];
  const result = await createProject({ root: data.root, name: 'demo-app', description: 'A demo', isPrivate: true, disabledSkills: ['lab', 'ghost-review'], catalog, execute: data.execute, onOutput: text => log.push(text) });
  const destination = path.join(data.root, 'demo-app');
  assert.equal(result.destination, destination);
  assert.equal(result.remoteUrl, data.bare.replace(/\.git$/, ''));
  assert.deepEqual(result.disabledSkills, ['ghost-review', 'lab']);
  const create = data.calls.find(call => call[0] === 'gh');
  assert.deepEqual(create, ['gh', 'repo', 'create', 'demo-app', '--template', 'ryanportfolio/Harness-Firmware', '--private', '--clone', '--description', 'A demo']);
  for (const relative of MANIFEST.templateOnly.filter(entry => entry !== 'README.md')) assert.equal(await exists(path.join(destination, relative)), false, relative);
  assert.equal(await exists(path.join(destination, 'GUIDE.md')), false);
  assert.equal(await exists(path.join(destination, 'scripts', 'readme')), false);
  assert.equal(await exists(path.join(destination, 'scripts', 'lib', 'launch-chrome.mjs')), true);
  assert.equal(await exists(path.join(destination, '.agents', 'template-manifest.json')), true);
  assert.equal(await exists(path.join(destination, '.github')), false);
  assert.equal(await readFile(path.join(destination, 'README.md'), 'utf8'), '# demo-app\n\nStarted from Harness Firmware.\n');
  assert.equal(await exists(path.join(destination, '.claude', 'skills', 'lab')), false);
  assert.equal(await exists(path.join(destination, '.agents', 'skills', 'lab')), false);
  assert.equal(await exists(path.join(destination, '.agents', 'skills', 'ghost-review')), false);
  assert.equal(await exists(path.join(destination, '.claude', 'skills', 'recall', 'SKILL.md')), true);
  assert.equal(await readFile(path.join(destination, '.agents', 'removed-skills.json'), 'utf8'), '{\n  "version": 1,\n  "removed": [\n    "ghost-review",\n    "lab"\n  ]\n}\n');
  const settings = JSON.parse(await readFile(path.join(destination, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.skillOverrides, { lab: 'off', 'ghost-review': 'off' });
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.equal((await run('git', ['-C', destination, 'status', '--porcelain'])).trim(), '');
  assert.deepEqual(await subjects(destination), ['Configure Harness skills', 'Strip template files, add README stub', 'template']);
  assert.equal((await run('git', ['-C', data.bare, 'log', '--format=%s', '-1', 'main'])).trim(), 'Configure Harness skills');
  assert.equal((await run('git', ['-C', destination, 'rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), 'origin/main');
  assert.match(log.join(''), /Omitting 2 skills: ghost-review, lab/);
});

test('createProject merges an existing removed-skills record', async t => {
  const data = await fixture(t, { extra: { '.agents/removed-skills.json': '{"version":1,"removed":["zeta-old","alpha-old"]}\n' } });
  await createProject({ root: data.root, name: 'merged', disabledSkills: ['lab'], catalog, execute: data.execute });
  const record = JSON.parse(await readFile(path.join(data.root, 'merged', '.agents', 'removed-skills.json'), 'utf8'));
  assert.deepEqual(record, { version: 1, removed: ['alpha-old', 'lab', 'zeta-old'] });
});

test('createProject with every skill enabled makes one cleanup commit and writes no removal record', async t => {
  const data = await fixture(t);
  await createProject({ root: data.root, name: 'plain', isPrivate: false, catalog, execute: data.execute });
  const destination = path.join(data.root, 'plain');
  assert.ok(data.calls.some(call => call[0] === 'gh' && call.includes('--public') && !call.includes('--description')));
  assert.deepEqual(await subjects(destination), ['Strip template files, add README stub', 'template']);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, '.claude', 'settings.json'), 'utf8')).skillOverrides, { recall: 'off' });
  assert.equal(await exists(path.join(destination, '.agents', 'removed-skills.json')), false);
});

test('createProject refuses bad names, existing folders, required skills, needed skills, and choices outside the catalog', async t => {
  const data = await fixture(t);
  await assert.rejects(createProject({ root: data.root, name: 'CON', catalog, execute: data.execute }), /Windows folder/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['init-project'], catalog, execute: data.execute }), /init-project is required by the template/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['external-review'], catalog, execute: data.execute }), /external-review is required by the template/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['codex-review'], catalog, execute: data.execute }), /ghost-review needs codex-review\. Keep codex-review, or omit ghost-review too\./);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['nope'], catalog, execute: data.execute }), /available list/);
  await assert.rejects(createProject({ root: data.root, name: 'ok', disabledSkills: ['lab', 'lab'], catalog, execute: data.execute }), /available list/);
  await mkdir(path.join(data.root, 'Taken'), { recursive: true });
  await assert.rejects(createProject({ root: data.root, name: 'taken', catalog, execute: data.execute }), /already exists/);
  assert.equal(data.calls.filter(call => call[0] === 'gh').length, 0);
  assert.deepEqual(await readdir(data.root), ['Taken']);
});

// The repository already exists on GitHub at this point, so the only promise is: no commit, no push.
async function assertStoppedBeforeCommit(data, name) {
  assert.equal(data.calls.some(call => call[0] === 'git' && (call.includes('commit') || call.includes('push') || call.includes('rm'))), false);
  assert.deepEqual(await subjects(path.join(data.root, name)), ['template']);
  assert.equal((await run('git', ['-C', path.join(data.root, name), 'status', '--porcelain'])).trim(), '');
  assert.deepEqual(await subjects(data.bare), ['template']);
}

test('createProject stops before any commit or push when the clone has no manifest', async t => {
  const data = await fixture(t, { manifest: null });
  await assert.rejects(createProject({ root: data.root, name: 'bare-app', catalog, execute: data.execute }), /The new clone has no \.agents\/template-manifest\.json.*nothing was committed or pushed/);
  await assertStoppedBeforeCommit(data, 'bare-app');
});

for (const [label, text, pattern] of [
  ['unsupported version', manifestText({ version: 2 }), /version 2 is not supported/],
  ['unknown top-level key', manifestText({ extraList: [] }), /unknown field extraList/],
  ['path outside the clone', manifestText({ templateOnly: ['../escape'] }), /templateOnly has an invalid path/],
  ['.git in another case', manifestText({ templateOnly: ['.GIT'] }), /templateOnly has an invalid path/],
  ['broken JSON', '{"version": 1,', /not valid JSON/],
]) {
  test(`createProject stops before any commit or push when the clone manifest has ${label}`, async t => {
    const data = await fixture(t, { manifest: text });
    await assert.rejects(createProject({ root: data.root, name: 'bad-app', catalog, execute: data.execute }), error => pattern.test(error.message) && /in the new clone is invalid/.test(error.message) && /nothing was committed or pushed/.test(error.message));
    await assertStoppedBeforeCommit(data, 'bad-app');
  });
}

test('createProject applies the clone manifest dependency rules even when the catalog lacks them', async t => {
  const data = await fixture(t);
  const loose = { ...catalog, dependencies: {} };
  await assert.rejects(createProject({ root: data.root, name: 'dep-app', disabledSkills: ['codex-review'], catalog: loose, execute: data.execute }), /ghost-review needs codex-review.*nothing was committed or pushed/);
  await assertStoppedBeforeCommit(data, 'dep-app');
});

test('createProject checks dependencies of clone skills the cached catalog never listed', async t => {
  // The template gained late-review after the picker loaded its catalog; late-review needs lab.
  const grown = structuredClone(MANIFEST);
  grown.skills.groups[2].skills.push('late-review');
  grown.skills.dependencies['late-review'] = ['lab'];
  const data = await fixture(t, { manifest: `${JSON.stringify(grown, null, 2)}\n`, extra: { '.claude/skills/late-review/SKILL.md': 'late', '.agents/skills/late-review/SKILL.md': 'late' } });
  assert.equal(catalog.skills.some(skill => skill.name === 'late-review'), false);
  await assert.rejects(createProject({ root: data.root, name: 'late-app', disabledSkills: ['lab'], catalog, execute: data.execute }), /late-review needs lab\. Keep lab, or omit late-review too\..*nothing was committed or pushed/);
  await assertStoppedBeforeCommit(data, 'late-app');
});

test('createProject fails when a manifest required file is missing after the strip', async t => {
  const data = await fixture(t, { manifest: manifestText({ requiredFiles: [...MANIFEST.requiredFiles, 'docs/must-exist.md'] }) });
  await assert.rejects(createProject({ root: data.root, name: 'thin', catalog, execute: data.execute }), /missing required asset: docs\/must-exist\.md/);
  assert.equal(data.calls.some(call => call[0] === 'git' && (call.includes('commit') || call.includes('push'))), false);
});

test('normalizeDisabledSkills keeps catalog order, checks rules, and mergeSkillOverrides round-trips', () => {
  assert.deepEqual(normalizeDisabledSkills(['recall', 'lab'], catalog), ['recall', 'lab']);
  assert.deepEqual(normalizeDisabledSkills(['ghost-review', 'codex-review'], catalog), ['codex-review', 'ghost-review']);
  assert.deepEqual(normalizeDisabledSkills(undefined, catalog), []);
  assert.throws(() => normalizeDisabledSkills('lab', catalog));
  assert.throws(() => normalizeDisabledSkills(['codex-review'], catalog), /ghost-review needs codex-review/);
  assert.throws(() => normalizeDisabledSkills(['init-project'], catalog), /init-project is required/);
  const merged = mergeSkillOverrides('{"skillOverrides":{"lab":"off","other":"on"}}', ['recall'], ['lab', 'recall']);
  assert.deepEqual(JSON.parse(merged), { skillOverrides: { other: 'on', recall: 'off' } });
  assert.equal(mergeSkillOverrides('{"skillOverrides":{"lab":"off"}}', [], ['lab']), '{}\n');
  assert.throws(() => mergeSkillOverrides('[]', [], []));
});

test('parseManifest accepts the spec shape and rejects bad paths and skill lists', () => {
  assert.deepEqual(parseManifest(manifestText()), MANIFEST);
  for (const bad of ['/abs', 'trailing/', 'a//b', 'C:/x', 'glob/*', 'win\\path', '.git/config', './here']) assert.throws(() => parseManifest(manifestText({ templateOnly: [bad] })), /invalid path/, bad);
  // Windows resolves each of these to the clone's .git (case, trailing dot or space, 8.3 short name).
  for (const bad of ['.git', '.GIT', '.Git/config', '.git.', '.git ', 'GIT~1', 'git~2/HEAD', 'docs./x', 'docs /x', 'a/b.', 'a/b ']) assert.throws(() => parseManifest(manifestText({ templateOnly: [bad] })), /templateOnly has an invalid path/, bad);
  assert.doesNotThrow(() => parseManifest(manifestText({ templateOnly: ['.github/x', 'a.b/c.d', '.gitignore'] })));
  assert.throws(() => parseManifest(manifestText({ requiredFiles: 'AGENTS.md' })), /requiredFiles must be a list/);
  assert.throws(() => parseManifest(manifestText({ readmeStub: 1 })), /readmeStub must be text/);
  const twice = structuredClone(MANIFEST); twice.skills.groups[2].skills.push('recall');
  assert.throws(() => parseManifest(JSON.stringify(twice)), /recall is in more than one group/);
  const noDeps = structuredClone(MANIFEST); delete noDeps.skills.dependencies;
  assert.throws(() => parseManifest(JSON.stringify(noDeps)), /skills.dependencies must be an object/);
  assert.throws(() => parseManifest('[]'), /expected a JSON object/);
});

// A stub for every gh api call skillCatalog makes; anything else fails the test. No network.
function catalogStub({ manifest = manifestText(), tree, files = {} } = {}) {
  const calls = [];
  const execute = async (command, args) => {
    calls.push(args);
    assert.equal(command, 'gh');
    const route = args[1];
    if (route.endsWith('/git/trees/HEAD?recursive=1')) return JSON.stringify(tree);
    if (route.endsWith('/contents/.agents/template-manifest.json')) { if (manifest instanceof Error) throw manifest; return manifest; }
    const file = Object.keys(files).find(suffix => route.endsWith(`/contents/${suffix}`));
    if (file) return files[file];
    throw new Error(`unexpected ${route}`);
  };
  return { execute, calls };
}

const TREE = { tree: [
  ...['init-project', 'recall', 'codex-review', 'lab'].flatMap(name => [{ path: `.claude/skills/${name}/SKILL.md` }, { path: `.agents/skills/${name}/SKILL.md` }]),
  { path: '.claude/skills/lab/reference.md' }, { path: '.agents/skills/external-review/SKILL.md' }, { path: '.agents/skills/ghost-review/SKILL.md' },
] };

test('skillCatalog takes groups, required skills and dependencies from the manifest and names from the tree', async () => {
  const stub = catalogStub({ tree: TREE, files: {
    '.agents/skills/external-review/SKILL.md': '---\nname: external-review\ndescription: Shared review lifecycle. Use when a review runs.\n---\n',
    '.agents/skills/ghost-review/SKILL.md': '---\nname: ghost-review\ndescription: "A Codex-only reviewer. Use for /ghost-review."\n---\n',
  } });
  const result = await skillCatalog({ execute: stub.execute });
  assert.ok(stub.calls.some(args => args.includes('Accept: application/vnd.github.raw') && args[1] === 'repos/ryanportfolio/Harness-Firmware/contents/.agents/template-manifest.json'));
  assert.deepEqual(result.groups, [
    { id: 'core', label: 'Core workflows', description: 'Setup and memory' },
    { id: 'review', label: 'Review tools', description: 'Fixture group copy from the manifest' },
    { id: 'specialist', label: 'Specialist tools', description: 'Focused modes' },
  ]);
  assert.deepEqual(result.skills.map(skill => [skill.name, skill.group]), [['init-project', 'core'], ['recall', 'core'], ['codex-review', 'review'], ['external-review', 'review'], ['ghost-review', 'review'], ['lab', 'specialist']]);
  assert.deepEqual(result.skills.filter(skill => skill.required).map(skill => skill.name), ['init-project', 'external-review']);
  assert.equal(result.skills.find(skill => skill.name === 'lab').label, 'Visual lab');
  assert.deepEqual(result.skills.find(skill => skill.name === 'external-review'), { name: 'external-review', group: 'review', label: 'External review', description: 'Shared review lifecycle', required: true });
  assert.deepEqual(result.skills.find(skill => skill.name === 'ghost-review'), { name: 'ghost-review', group: 'review', label: 'Ghost review', description: 'A Codex-only reviewer' });
  assert.deepEqual(result.dependencies, MANIFEST.skills.dependencies);
});

test('skillCatalog fails clearly on a missing, unsupported or inconsistent manifest', async () => {
  await assert.rejects(skillCatalog({ execute: catalogStub({ tree: TREE, manifest: new Error('HTTP 404: Not Found') }).execute }), /Could not read \.agents\/template-manifest\.json from ryanportfolio\/Harness-Firmware\. HTTP 404/);
  await assert.rejects(skillCatalog({ execute: catalogStub({ tree: TREE, manifest: manifestText({ version: 2 }) }).execute }), /version 2 is not supported/);
  await assert.rejects(skillCatalog({ execute: catalogStub({ tree: TREE, manifest: manifestText({ extra: true }) }).execute }), /unknown field extra/);
  const untracked = { tree: [...TREE.tree, { path: '.claude/skills/brand-new/SKILL.md' }] };
  await assert.rejects(skillCatalog({ execute: catalogStub({ tree: untracked }).execute }), /does not place skill brand-new in any group/);
  const missing = { tree: TREE.tree.filter(entry => !entry.path.includes('ghost-review')) };
  await assert.rejects(skillCatalog({ execute: catalogStub({ tree: missing }).execute }), /names skill ghost-review, but the template has no folder/);
});

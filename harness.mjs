import { mkdir, readdir, readFile, realpath, rm, stat, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { run, validateLeaf } from './core.mjs';

// The template a new install starts from. Each user picks their own in settings; every caller in the
// app passes the chosen one, so this is only the starting value and a default for direct callers.
export const DEFAULT_TEMPLATE = 'ryanportfolio/Harness-Firmware';

// The template's own description of itself: which paths a new project drops, which files it must
// keep, the README stub, and how skills are grouped and depend on each other. The picker reads it
// from GitHub; createProject reads the copy inside the fresh clone.
export const MANIFEST_PATH = '.agents/template-manifest.json';
const REMOVED_SKILLS_PATH = '.agents/removed-skills.json';
const MANIFEST_KEYS = ['version', 'template', 'requiredFiles', 'projectPaths', 'templateOnly', 'readmeStub', 'skills'];
const SKILL_NAME = /^[A-Za-z0-9_-]+$/;

// Per-skill labels and copy for the picker. Group membership comes from the manifest; a skill not
// listed here shows its SKILL.md description.
const KNOWN = [
  { name: 'init-project', label: 'Initialize project', description: 'Tune the Harness after adding your framework, scaffold, or first project files' },
  { name: 'recall', label: 'Project memory', description: 'Read and save durable repository knowledge and pitfalls' },
  { name: 'addskill', label: 'Add skill', description: 'Install or create repository-local skills for future sessions' },
  { name: 'adopt-repo', label: 'Adopt repository', description: 'Mirror an existing external repo privately and overlay the firmware on it' },
  { name: 'sync-starter', label: 'Sync starter', description: 'Pull safe template improvements into an existing project' },
  { name: 'optimize-context', label: 'Optimize context', description: 'Reduce always-loaded rules, skill indexes, and token weight' },
  { name: 'refine', label: 'Refine workflow', description: 'Capture friction and improve the operating system after work' },
  { name: 'session-hub', label: 'Session hub', description: 'Coordinate parallel Claude Code sessions through a shared append-only hub' },
  { name: 'brainstorming', label: 'Brainstorming', description: 'Resolve product and architecture choices before implementation' },
  { name: 'writing-plans', label: 'Implementation plans', description: 'Turn an approved design into a detailed executable plan' },
  { name: 'impartial-review', label: 'Impartial review', description: 'Use fresh independent agents to review recent code changes' },
  { name: 'long-horizon', label: 'Long horizon', description: 'Run work too large for one context window in verified rounds' },
  { name: 'babysit-ci', label: 'Babysit CI', description: 'Watch pull request checks, fix failures, and repeat until every check is green' },
  { name: 'codex-review', label: 'Codex review', description: 'Run a fresh Codex CLI review, then verify each finding before reporting it' },
  { name: 'astra-review', label: 'Astra review', description: 'Cross-vendor review through gpt-6-astra with the same verified lifecycle as Codex review' },
  { name: 'claude-review', label: 'Claude review', description: 'Cross-vendor review of Codex-written code through the Claude CLI' },
  { name: 'perf-loop', label: 'Performance loop', description: 'Measured optimization rounds with independent review for FPS, latency, and resource use' },
  { name: 'dare', label: 'Dare', description: 'First-principles pass: decompose, audit, recombine, and test while keeping fixed goals' },
  { name: 'fable-mode', label: 'Fable mode', description: 'Apply evidence gates to hard, layered, verification-sensitive work' },
  { name: 'wow-loop', label: 'Wow loop', description: 'Run a multi-agent critique loop for high-polish deliverables' },
  { name: 'arena', label: 'Arena', description: 'Compare parallel candidate solutions, choose the strongest base, and combine the best parts' },
  { name: 'lab', label: 'Visual lab', description: 'Prototype and tune UI, motion, or game feel before production' },
  { name: 'showpiece', label: 'Showpiece', description: 'Create distinctive, crafted artifacts in any medium' },
  { name: 'advocate', label: 'Change advocate', description: 'Challenge a completed change from a fresh independent context' },
  { name: 'why', label: 'Challenge recommendation', description: 'Stress-test the immediately prior recommendation' },
  { name: 'enhance-prompt', label: 'Prompt enhancer', description: 'Rewrite a rough request into a polished prompt for another agent' },
  { name: 'handoff-audit', label: 'Audit handoff', description: 'Create a self-contained prompt for independent verification' },
  { name: 'writing', label: 'Writing', description: 'Text that leaves the session: docs, UI copy, emails; unslop, humanize, and audit drafts' },
  { name: 'forge-repo-ui-skill', label: 'Forge UI skill', description: 'Synthesize a lean repository-specific frontend design workflow' },
  { name: 'caveman', label: 'Caveman prose', description: 'Compress agent replies while preserving technical accuracy' },
  { name: 'bro', label: 'Plain English', description: 'Restate the last answer in plain language without dropping facts or caveats' },
];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Repo-relative, '/'-separated, no trailing slash, no globs. Stripping deletes these paths, so an
// entry must never reach outside the clone or into .git. Windows matches names case-insensitively,
// trims a trailing dot or space, and may answer to the 8.3 short name GIT~1, so '.GIT', '.git.',
// '.git ' and 'git~1' would all delete the clone's .git there.
function checkManifestPath(entry, field) {
  const segments = typeof entry === 'string' ? entry.split('/') : [];
  if (!segments.length || segments.some(part => !part || part === '.' || part === '..' || /[\\:*?[\]]/.test(part) || /[. ]$/.test(part)) || /^(\.git|git~\d+)$/i.test(segments[0])) throw new Error(`${field} has an invalid path: ${JSON.stringify(entry)}`);
}

function checkNames(list, field) {
  if (!Array.isArray(list)) throw new Error(`${field} must be a list of skill names.`);
  for (const name of list) if (typeof name !== 'string' || !SKILL_NAME.test(name)) throw new Error(`${field} has an invalid skill name: ${JSON.stringify(name)}`);
}

// Parses and checks the manifest shape (version 1). Throws a message naming the source and the problem.
export function parseManifest(text, source = MANIFEST_PATH) {
  try {
    let data;
    try { data = JSON.parse(text); } catch (error) { throw new Error(`not valid JSON (${error.message})`); }
    if (!isObject(data)) throw new Error('expected a JSON object');
    const unknown = Object.keys(data).filter(key => !MANIFEST_KEYS.includes(key));
    if (unknown.length) throw new Error(`unknown field ${unknown.join(', ')}`);
    if (data.version !== 1) throw new Error(`version ${JSON.stringify(data.version)} is not supported; this Console reads version 1`);
    if (typeof data.template !== 'string' || !data.template) throw new Error('template must be a repository name');
    for (const field of ['requiredFiles', 'projectPaths', 'templateOnly']) {
      if (!Array.isArray(data[field])) throw new Error(`${field} must be a list of paths`);
      for (const entry of data[field]) checkManifestPath(entry, field);
    }
    if (typeof data.readmeStub !== 'string') throw new Error('readmeStub must be text');
    const skills = data.skills;
    if (!isObject(skills)) throw new Error('skills must be an object');
    if (!Array.isArray(skills.groups) || !skills.groups.length) throw new Error('skills.groups must be a non-empty list');
    const ids = new Set(), grouped = new Set();
    for (const group of skills.groups) {
      if (!isObject(group) || typeof group.id !== 'string' || !group.id || typeof group.label !== 'string' || typeof group.description !== 'string') throw new Error('each skills.groups entry needs id, label, description and skills');
      if (ids.has(group.id)) throw new Error(`skills.groups repeats id ${group.id}`);
      ids.add(group.id);
      checkNames(group.skills, `skills.groups ${group.id}`);
      for (const name of group.skills) { if (grouped.has(name)) throw new Error(`skill ${name} is in more than one group`); grouped.add(name); }
    }
    checkNames(skills.required, 'skills.required');
    if (!isObject(skills.dependencies)) throw new Error('skills.dependencies must be an object');
    for (const [name, needs] of Object.entries(skills.dependencies)) { checkNames([name], 'skills.dependencies'); checkNames(needs, `skills.dependencies ${name}`); }
    if (skills.presets !== undefined && !isObject(skills.presets)) throw new Error('skills.presets must be an object');
    return data;
  } catch (error) {
    throw new Error(`Template manifest ${source} is invalid: ${error.message}.`);
  }
}

// Rejects a removal the template forbids: a required skill, or a skill a kept skill needs.
function checkRemovals(disabled, allNames, required, dependencies) {
  const removed = new Set(disabled);
  for (const name of disabled) if (required.includes(name)) throw new Error(`${name} is required by the template and cannot be omitted.`);
  for (const kept of allNames) {
    if (removed.has(kept)) continue;
    for (const need of dependencies[kept] ?? []) if (removed.has(need)) throw new Error(`${kept} needs ${need}. Keep ${need}, or omit ${kept} too.`);
  }
}

function frontmatterDescription(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = match && /^description:\s*(.+)$/m.exec(match[1]);
  if (!line) return '';
  let value = line[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.split(/\.\s|\bUse (?:for|on|when)\b/)[0].replace(/\.$/, '').trim().slice(0, 140);
}

// Reads the template's skill folders and manifest from GitHub so the picker matches what will be
// cloned. Skill names come from the live tree (Claude or Codex folders); groups, required skills and
// dependencies come from the manifest.
export async function skillCatalog({ template = DEFAULT_TEMPLATE, execute = run } = {}) {
  const [manifestText, treeText] = await Promise.all([
    execute('gh', ['api', `repos/${template}/contents/${MANIFEST_PATH}`, '-H', 'Accept: application/vnd.github.raw']).catch(error => { throw new Error(`Could not read ${MANIFEST_PATH} from ${template}. ${error.message}`); }),
    execute('gh', ['api', `repos/${template}/git/trees/HEAD?recursive=1`]),
  ]);
  const manifest = parseManifest(manifestText, `${MANIFEST_PATH} in ${template}`);
  const tree = JSON.parse(treeText);
  if (tree.truncated) throw new Error('Template tree too large to list skills.');
  const folders = new Map();
  for (const entry of tree.tree) {
    const match = /^\.(claude|agents)\/skills\/([A-Za-z0-9_-]+)\/SKILL\.md$/.exec(entry.path);
    if (match && !folders.has(match[2])) folders.set(match[2], match[1]);
    else if (match?.[1] === 'claude') folders.set(match[2], 'claude');
  }
  const groupOf = new Map(manifest.skills.groups.flatMap(group => group.skills.map(name => [name, group.id])));
  for (const name of folders.keys()) if (!groupOf.has(name)) throw new Error(`Template manifest does not place skill ${name} in any group.`);
  for (const name of [...groupOf.keys(), ...manifest.skills.required]) if (!folders.has(name)) throw new Error(`Template manifest names skill ${name}, but the template has no folder for it.`);
  const required = new Set(manifest.skills.required);
  const skills = await Promise.all(manifest.skills.groups.flatMap(group => group.skills).map(async name => {
    const skill = { name, group: groupOf.get(name) };
    const known = KNOWN.find(entry => entry.name === name);
    if (known) Object.assign(skill, { label: known.label, description: known.description });
    else {
      let description = '';
      try { description = frontmatterDescription(await execute('gh', ['api', `repos/${template}/contents/.${folders.get(name)}/skills/${name}/SKILL.md`, '-H', 'Accept: application/vnd.github.raw'])); } catch {}
      Object.assign(skill, { label: name.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()), description: description || 'Repository skill from the template' });
    }
    if (required.has(name)) skill.required = true;
    return skill;
  }));
  const groups = manifest.skills.groups.map(({ id, label, description }) => ({ id, label, description }));
  return { template, groups, skills, dependencies: manifest.skills.dependencies };
}

// Checks the picker's omitted skills: each must be an optional catalog skill, listed once, and not
// needed by a skill that stays. Returns them in catalog order.
export function normalizeDisabledSkills(value, catalog) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Choose skills from the available list.');
  const names = new Set(catalog.skills.map(skill => skill.name));
  const chosen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !names.has(item) || chosen.has(item)) throw new Error('Choose skills from the available list.');
    chosen.add(item);
  }
  const disabled = catalog.skills.filter(skill => chosen.has(skill.name)).map(skill => skill.name);
  checkRemovals(disabled, [...names], catalog.skills.filter(skill => skill.required).map(skill => skill.name), catalog.dependencies ?? {});
  return disabled;
}

export function mergeSkillOverrides(settingsText, disabledSkills, allSkills) {
  const parsed = JSON.parse(settingsText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Harness settings must contain a JSON object.');
  const settings = { ...parsed };
  const overrides = settings.skillOverrides && typeof settings.skillOverrides === 'object' && !Array.isArray(settings.skillOverrides) ? { ...settings.skillOverrides } : {};
  const disabled = new Set(disabledSkills);
  for (const name of allSkills) { if (disabled.has(name)) overrides[name] = 'off'; else if (overrides[name] === 'off') delete overrides[name]; }
  if (Object.keys(overrides).length) settings.skillOverrides = overrides; else delete settings.skillOverrides;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

const exists = target => access(target).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function removeEmptyGithubDirectories(destination) {
  for (const relative of ['.github/workflows', '.github']) {
    const full = path.join(destination, relative);
    try { if ((await readdir(full)).length === 0) await rm(full, { recursive: true, force: true }); } catch {}
  }
}

// README.md may be template-only; it is rewritten from the stub, so its presence is expected.
async function assertContract(destination, manifest) {
  for (const required of manifest.requiredFiles) if (!await exists(path.join(destination, required))) throw new Error(`Generated project is missing required asset: ${required}`);
  for (const forbidden of manifest.templateOnly) if (forbidden !== 'README.md' && await exists(path.join(destination, forbidden))) throw new Error(`Generated project still contains template-only asset: ${forbidden}`);
  const scratch = (await readdir(destination, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.startsWith('.tmp'));
  if (scratch) throw new Error(`Generated project still contains template scratch directory: ${scratch.name}`);
}

// Creates a GitHub repository from the chosen template, clones it under root, strips
// template-only files, drops a README stub, omits deselected skills, commits, and pushes.
export async function createProject({ root, name, description = '', isPrivate = true, disabledSkills = [], catalog, template = DEFAULT_TEMPLATE, execute = run, onOutput = () => {} }) {
  validateLeaf(name);
  if (name.length > 100) throw new Error('Repository name is too long.');
  description = String(description ?? '').trim().slice(0, 350);
  const disabled = normalizeDisabledSkills(disabledSkills, catalog);
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  const destination = path.resolve(resolvedRoot, name);
  if (path.dirname(destination) !== resolvedRoot) throw new Error('Destination must stay inside the CoreWise folder.');
  if ((await readdir(resolvedRoot)).some(entry => entry.toLowerCase() === name.toLowerCase())) throw new Error(`Folder already exists: ${destination}. Choose another name or move that folder first.`);

  const git = (args, options = {}) => execute('git', ['-C', destination, ...args], options);
  onOutput(`Creating ${isPrivate ? 'private' : 'public'} repository ${name} from ${template}…\n`);
  const createArgs = ['repo', 'create', name, '--template', template, isPrivate ? '--private' : '--public', '--clone'];
  if (description) createArgs.push('--description', description);
  await execute('gh', createArgs, { cwd: resolvedRoot, onOutput });
  if (!(await stat(destination).catch(() => null))?.isDirectory()) throw new Error(`GitHub reported success, but the clone was not found at ${destination}`);

  // GitHub generates template contents asynchronously; a fast clone can land before the first commit.
  for (let attempt = 0; attempt < 12 && !await exists(path.join(destination, 'AGENTS.md')); attempt++) {
    if (attempt === 0) onOutput('Waiting for GitHub to finish generating the repository…\n');
    await sleep(1500);
    try { await git(['fetch', '-q', 'origin']); await git(['checkout', '-q', '-B', 'main', '--track', 'origin/main']); } catch {}
  }
  if (!await exists(path.join(destination, 'AGENTS.md'))) throw new Error(`Clone at ${destination} never received the template contents. Inspect the folder and the repository on GitHub before retrying.`);

  // The clone's own manifest decides the strip, so it matches the files actually cloned.
  const untouched = `The repository ${name} was created on GitHub, but nothing was committed or pushed. Delete it or fix it by hand.`;
  let manifestText;
  try { manifestText = await readFile(path.join(destination, MANIFEST_PATH), 'utf8'); }
  catch { throw new Error(`The new clone has no ${MANIFEST_PATH}, so the Console cannot tell which template files to strip. ${untouched}`); }
  let manifest;
  try {
    manifest = parseManifest(manifestText, `${MANIFEST_PATH} in the new clone`);
    // The clone can carry skills the catalog never listed (the template changed after the picker
    // loaded); each one that stays must still have the skills it needs.
    const cloned = new Set([...catalog.skills.map(skill => skill.name), ...manifest.skills.groups.flatMap(group => group.skills)]);
    checkRemovals(disabled, [...cloned], manifest.skills.required, manifest.skills.dependencies);
  } catch (error) { throw new Error(`${error.message} ${untouched}`); }

  onOutput('Stripping template-only files and replacing README.md…\n');
  await git(['rm', '-rq', '--ignore-unmatch', '--', ...new Set([...manifest.templateOnly, 'README.md'])]);
  for (const relative of manifest.templateOnly) await rm(path.join(destination, relative), { recursive: true, force: true });
  for (const entry of await readdir(destination, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith('.tmp')) await rm(path.join(destination, entry.name), { recursive: true, force: true });
  await removeEmptyGithubDirectories(destination);
  await writeFile(path.join(destination, 'README.md'), manifest.readmeStub.replaceAll('{name}', name));
  await git(['add', 'README.md']);
  await assertContract(destination, manifest);
  await git(['commit', '-qm', 'Strip template files, add README stub']);

  if (disabled.length) {
    onOutput(`Omitting ${disabled.length} skill${disabled.length === 1 ? '' : 's'}: ${disabled.join(', ')}\n`);
    for (const skill of disabled) {
      if (!await exists(path.join(destination, '.claude', 'skills', skill, 'SKILL.md')) && !await exists(path.join(destination, '.agents', 'skills', skill, 'SKILL.md'))) throw new Error(`Harness skill files were missing for ${skill}`);
      await git(['rm', '-rq', '--ignore-unmatch', '--', `.claude/skills/${skill}`, `.agents/skills/${skill}`]);
      await rm(path.join(destination, '.claude', 'skills', skill), { recursive: true, force: true });
      await rm(path.join(destination, '.agents', 'skills', skill), { recursive: true, force: true });
    }
    const settingsPath = path.join(destination, '.claude', 'settings.json');
    await writeFile(settingsPath, mergeSkillOverrides(await readFile(settingsPath, 'utf8'), disabled, catalog.skills.map(skill => skill.name)));
    // The template's removed-skills check treats a listed skill as intentionally absent.
    const recordPath = path.join(destination, REMOVED_SKILLS_PATH);
    let recorded = [];
    if (await exists(recordPath)) {
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      if (!isObject(record) || record.version !== 1 || !Array.isArray(record.removed)) throw new Error(`${REMOVED_SKILLS_PATH} in the template is not {"version": 1, "removed": [...]}`);
      recorded = record.removed;
    }
    await writeFile(recordPath, `${JSON.stringify({ version: 1, removed: [...new Set([...recorded, ...disabled])].sort() }, null, 2)}\n`);
    await git(['add', '.claude/settings.json', REMOVED_SKILLS_PATH]);
    await git(['commit', '-qm', 'Configure Harness skills']);
  }

  onOutput('Pushing to GitHub…\n');
  await git(['push', '-q'], { onOutput });
  const remote = (await git(['remote', 'get-url', 'origin'])).trim().replace(/\.git$/, '');
  onOutput(`Ready. ${destination} is tracking origin/main.\n`);
  return { destination, remoteUrl: remote, disabledSkills: disabled };
}

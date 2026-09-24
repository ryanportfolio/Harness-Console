import { mkdir, readdir, readFile, realpath, rm, stat, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { run, validateLeaf } from './core.mjs';

export const TEMPLATE = 'ryanportfolio/Harness-Firmware';

// Mirrors $script:TemplateOnlyPaths in Harness-Firmware bootstrap/NewProjectCore.psm1.
// These files maintain or distribute the template itself; a spawned project must not inherit them.
export const TEMPLATE_ONLY_PATHS = ['bootstrap', '.claude-plugin', '.github/workflows/validate-template.yml', '.github/ISSUE_TEMPLATE', 'CHANGELOG.md', 'CONTRIBUTING.md'];
const REQUIRED_FILES = ['AGENTS.md', '.agents/skills/init-project/SKILL.md', '.claude/skills/init-project/SKILL.md', '.claude/scripts/sync-codex-skills.mjs'];

export const SKILL_GROUPS = Object.freeze([
  { id: 'core', label: 'Core workflows', description: 'Setup, memory, maintenance, and everyday project control' },
  { id: 'discipline', label: 'Quality disciplines', description: 'Planning, review, and dependable long-form execution' },
  { id: 'specialist', label: 'Specialist tools', description: 'Focused modes for design, writing, critique, and delivery' },
]);

// Labels and copy for skills the template is known to ship. The live template decides which
// names exist; anything new falls back to its SKILL.md description under "Specialist tools".
const KNOWN = [
  { name: 'init-project', label: 'Initialize project', group: 'core', required: true, description: 'Tune the Harness after adding your framework, scaffold, or first project files' },
  { name: 'recall', label: 'Project memory', group: 'core', description: 'Read and save durable repository knowledge and pitfalls' },
  { name: 'addskill', label: 'Add skill', group: 'core', description: 'Install or create repository-local skills for future sessions' },
  { name: 'adopt-repo', label: 'Adopt repository', group: 'core', description: 'Mirror an existing external repo privately and overlay the firmware on it' },
  { name: 'sync-starter', label: 'Sync starter', group: 'core', description: 'Pull safe template improvements into an existing project' },
  { name: 'optimize-context', label: 'Optimize context', group: 'core', description: 'Reduce always-loaded rules, skill indexes, and token weight' },
  { name: 'refine', label: 'Refine workflow', group: 'core', description: 'Capture friction and improve the operating system after work' },
  { name: 'merge', label: 'Automatic merge mode', group: 'core', description: 'Explicit session mode for commit, push, pull request, and merge automation' },
  { name: 'session-hub', label: 'Session hub', group: 'core', description: 'Coordinate parallel Claude Code sessions through a shared append-only hub' },
  { name: 'automate-me', label: 'Personal automation mode', group: 'core', description: 'Turn your project history and working preferences into a reusable personal mode' },
  { name: 'brainstorming', label: 'Brainstorming', group: 'discipline', description: 'Resolve product and architecture choices before implementation' },
  { name: 'writing-plans', label: 'Implementation plans', group: 'discipline', description: 'Turn an approved design into a detailed executable plan' },
  { name: 'impartial-review', label: 'Impartial review', group: 'discipline', description: 'Use fresh independent agents to review recent code changes' },
  { name: 'writing-skills', label: 'Skill authoring', group: 'discipline', description: 'Create, edit, and verify agent skills before deployment' },
  { name: 'long-horizon', label: 'Long horizon', group: 'discipline', description: 'Run work too large for one context window in verified rounds' },
  { name: 'babysit-ci', label: 'Babysit CI', group: 'discipline', description: 'Watch pull request checks, fix failures, and repeat until every check is green' },
  { name: 'codex-review', label: 'Codex review', group: 'discipline', description: 'Run a fresh Codex CLI review, then verify each finding before reporting it' },
  { name: 'astra-review', label: 'Astra review', group: 'discipline', description: 'Cross-vendor review through gpt-6-astra with the same verified lifecycle as Codex review' },
  { name: 'claude-review', label: 'Claude review', group: 'discipline', description: 'Cross-vendor review of Codex-written code through the Claude CLI' },
  { name: 'perf-loop', label: 'Performance loop', group: 'discipline', description: 'Measured optimization rounds with independent review for FPS, latency, and resource use' },
  { name: 'verify-this', label: 'Verify this', group: 'discipline', description: 'Test a specific claim with baseline, treatment, comparison, and a clear verdict' },
  { name: 'dare', label: 'Dare', group: 'discipline', description: 'First-principles pass: decompose, audit, recombine, and test while keeping fixed goals' },
  { name: 'fable-mode', label: 'Fable mode', group: 'specialist', description: 'Apply evidence gates to hard, layered, verification-sensitive work' },
  { name: 'wow-loop', label: 'Wow loop', group: 'specialist', description: 'Run a multi-agent critique loop for high-polish deliverables' },
  { name: 'arena', label: 'Arena', group: 'specialist', description: 'Compare parallel candidate solutions, choose the strongest base, and combine the best parts' },
  { name: 'lab', label: 'Visual lab', group: 'specialist', description: 'Prototype and tune UI, motion, or game feel before production' },
  { name: 'showpiece', label: 'Showpiece', group: 'specialist', description: 'Create distinctive, crafted artifacts in any medium' },
  { name: 'advocate', label: 'Change advocate', group: 'specialist', description: 'Challenge a completed change from a fresh independent context' },
  { name: 'why', label: 'Challenge recommendation', group: 'specialist', description: 'Stress-test the immediately prior recommendation' },
  { name: 'enhance-prompt', label: 'Prompt enhancer', group: 'specialist', description: 'Rewrite a rough request into a polished prompt for another agent' },
  { name: 'handoff-audit', label: 'Audit handoff', group: 'specialist', description: 'Create a self-contained prompt for independent verification' },
  { name: 'writing', label: 'Writing', group: 'specialist', description: 'Text that leaves the session: docs, UI copy, emails; unslop, humanize, and audit drafts' },
  { name: 'humanizer', label: 'Humanizer', group: 'specialist', description: 'Remove machine-made prose patterns before publishing' },
  { name: 'purposeful-writing', label: 'Purposeful writing', group: 'specialist', description: 'Draft reader-focused emails, essays, reports, and product copy' },
  { name: 'forge-repo-ui-skill', label: 'Forge UI skill', group: 'specialist', description: 'Synthesize a lean repository-specific frontend design workflow' },
  { name: 'caveman', label: 'Caveman prose', group: 'specialist', description: 'Compress agent replies while preserving technical accuracy' },
  { name: 'bro', label: 'Plain English', group: 'specialist', description: 'Restate the last answer in plain language without dropping facts or caveats' },
  { name: 'unslop', label: 'Unslop', group: 'specialist', description: 'Strip predictable AI writing patterns from human-facing text at write time' },
];

function frontmatterDescription(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const line = match && /^description:\s*(.+)$/m.exec(match[1]);
  if (!line) return '';
  let value = line[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value.split(/\.\s|\bUse (?:for|on|when)\b/)[0].replace(/\.$/, '').trim().slice(0, 140);
}

// Reads the template's skill folders from GitHub so the picker matches what will be cloned.
export async function skillCatalog({ template = TEMPLATE, execute = run } = {}) {
  const tree = JSON.parse(await execute('gh', ['api', `repos/${template}/git/trees/HEAD?recursive=1`]));
  if (tree.truncated) throw new Error('Template tree too large to list skills.');
  const names = [...new Set(tree.tree.map(entry => /^\.claude\/skills\/([A-Za-z0-9_-]+)\/SKILL\.md$/.exec(entry.path)?.[1]).filter(Boolean))];
  const skills = await Promise.all(names.map(async name => {
    const known = KNOWN.find(skill => skill.name === name);
    if (known) return { ...known };
    let description = '';
    try { description = frontmatterDescription(await execute('gh', ['api', `repos/${template}/contents/.claude/skills/${name}/SKILL.md`, '-H', 'Accept: application/vnd.github.raw'])); } catch {}
    return { name, label: name.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()), group: 'specialist', description: description || 'Repository skill from the template' };
  }));
  const order = new Map(KNOWN.map((skill, index) => [skill.name, index]));
  const groupOrder = new Map(SKILL_GROUPS.map((group, index) => [group.id, index]));
  skills.sort((a, b) => groupOrder.get(a.group) - groupOrder.get(b.group) || (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999) || a.name.localeCompare(b.name));
  if (!skills.some(skill => skill.required)) throw new Error('Template is missing the init-project skill.');
  return { template, groups: SKILL_GROUPS, skills };
}

export function normalizeDisabledSkills(value, catalog) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Choose skills from the available list.');
  const optional = new Set(catalog.skills.filter(skill => !skill.required).map(skill => skill.name));
  const chosen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !optional.has(item) || chosen.has(item)) throw new Error('Choose skills from the available list.');
    chosen.add(item);
  }
  return catalog.skills.filter(skill => chosen.has(skill.name)).map(skill => skill.name);
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

async function assertContract(destination) {
  for (const required of REQUIRED_FILES) if (!await exists(path.join(destination, required))) throw new Error(`Generated project is missing required asset: ${required}`);
  for (const forbidden of TEMPLATE_ONLY_PATHS) if (await exists(path.join(destination, forbidden))) throw new Error(`Generated project still contains template-only asset: ${forbidden}`);
  const scratch = (await readdir(destination, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.startsWith('.tmp'));
  if (scratch) throw new Error(`Generated project still contains template scratch directory: ${scratch.name}`);
}

// Creates a GitHub repository from the Harness Firmware template, clones it under root, strips
// template-only files, drops a README stub, omits deselected skills, commits, and pushes.
export async function createProject({ root, name, description = '', isPrivate = true, disabledSkills = [], catalog, template = TEMPLATE, execute = run, onOutput = () => {} }) {
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

  onOutput('Stripping template-only files and replacing README.md…\n');
  await git(['rm', '-rq', '--ignore-unmatch', '--', ...TEMPLATE_ONLY_PATHS, 'README.md']);
  for (const relative of TEMPLATE_ONLY_PATHS) await rm(path.join(destination, relative), { recursive: true, force: true });
  for (const entry of await readdir(destination, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith('.tmp')) await rm(path.join(destination, entry.name), { recursive: true, force: true });
  await removeEmptyGithubDirectories(destination);
  await writeFile(path.join(destination, 'README.md'), `# ${name}\n`);
  await git(['add', 'README.md']);
  await assertContract(destination);
  await git(['commit', '-qm', 'Strip template files, add README stub']);

  if (disabled.length) {
    onOutput(`Omitting ${disabled.length} skill${disabled.length === 1 ? '' : 's'}: ${disabled.join(', ')}\n`);
    for (const skill of disabled) {
      if (!await exists(path.join(destination, '.claude', 'skills', skill, 'SKILL.md'))) throw new Error(`Harness skill files were missing for ${skill}`);
      await git(['rm', '-rq', '--ignore-unmatch', '--', `.claude/skills/${skill}`, `.agents/skills/${skill}`]);
      await rm(path.join(destination, '.claude', 'skills', skill), { recursive: true, force: true });
      await rm(path.join(destination, '.agents', 'skills', skill), { recursive: true, force: true });
    }
    const settingsPath = path.join(destination, '.claude', 'settings.json');
    await writeFile(settingsPath, mergeSkillOverrides(await readFile(settingsPath, 'utf8'), disabled, catalog.skills.map(skill => skill.name)));
    await git(['add', '.claude/settings.json']);
    await git(['commit', '-qm', 'Configure Harness skills']);
  }

  onOutput('Pushing to GitHub…\n');
  await git(['push', '-q'], { onOutput });
  const remote = (await git(['remote', 'get-url', 'origin'])).trim().replace(/\.git$/, '');
  onOutput(`Ready. ${destination} is tracking origin/main.\n`);
  return { destination, remoteUrl: remote, disabledSkills: disabled };
}

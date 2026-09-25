import { spawn } from 'node:child_process';
import { mkdir, readdir, realpath, rm, lstat } from 'node:fs/promises';
import path from 'node:path';

export function run(command, args, { onOutput = () => {}, env = {}, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; onOutput(String(data)); });
    child.stderr.on('data', data => { stderr += data; onOutput(String(data)); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with code ${code}`)));
  });
}

export function validateRepo(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(id)) throw new Error('Invalid repository name.');
  validateLeaf(id.split('/')[1]);
  return id;
}
export function validateLeaf(leaf) {
  if (typeof leaf !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(leaf) || leaf === '.' || leaf === '..' || /[. ]$/.test(leaf) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(leaf)) throw new Error('This repository name cannot be used as a Windows folder.');
  return leaf;
}

export async function cloneMain({ root, id, source = `https://github.com/${validateRepo(id)}.git`, execute = run, onOutput = () => {} }) {
  validateRepo(id);
  const leaf = validateLeaf(id.split('/')[1]);
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  const destination = path.resolve(resolvedRoot, leaf);
  if (path.dirname(destination) !== resolvedRoot) throw new Error('Destination must stay inside the CoreWise folder.');
  if ((await readdir(resolvedRoot)).some(name => name.toLowerCase() === leaf.toLowerCase())) throw new Error(`Folder already exists: ${destination}. Choose another repository or move that folder first.`);
  onOutput('Checking for main…\n');
  const refs = await execute('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'ls-remote', '--heads', '--', source, 'refs/heads/main']);
  if (!refs.trim()) throw new Error('This repository has no main branch. No files were cloned.');
  // mkdir is exclusive: a concurrent request or existing user folder always wins.
  await mkdir(destination);
  const owned = await lstat(destination);
  try {
    onOutput('Cloning main…\n');
    await execute('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'clone', '--config', 'credential.helper=', '--config', 'credential.helper=!gh auth git-credential', '--progress', '--branch', 'main', '--single-branch', '--', source, destination], { onOutput });
    onOutput('Ready. main is tracking origin/main.\n');
    return destination;
  } catch (error) {
    // Remove only the exact directory reserved by this operation, never a replacement.
    const current = await lstat(destination).catch(() => null);
    if (current && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino && path.dirname(destination) === resolvedRoot) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export const GIT_CRED = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const tidy = url => String(url || '').trim().replace(/\.git$/i, '').replace(/[\\/]+$/, '').toLowerCase();
// Only GitHub's own host counts: https (optionally with credentials), scp-style git@ and ssh:// forms.
export function sameRemote(url, id, source) {
  const clean = tidy(url);
  if (source && clean === tidy(source)) return true;
  const match = clean.match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/);
  return Boolean(match && match[1] === id.toLowerCase());
}

// Reports what already sits at the destination so the page can offer update instead of clone.
export async function localState({ root, id, source, execute = run }) {
  validateRepo(id);
  const destination = path.resolve(root, id.split('/')[1]);
  const stat = await lstat(destination).catch(() => null);
  if (!stat) return { destination, exists: false };
  if (!stat.isDirectory()) return { destination, exists: true, git: false };
  const git = (...args) => execute('git', ['-C', destination, ...args]);
  let inside = false;
  try { inside = (await git('rev-parse', '--is-inside-work-tree')).trim() === 'true'; } catch {}
  if (!inside) return { destination, exists: true, git: false };
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => 'HEAD')).trim();
  const origin = (await git('remote', 'get-url', 'origin').catch(() => '')).trim();
  const dirty = (await git('status', '--porcelain', '--untracked-files=no').catch(() => '')).split(/\r?\n/).filter(Boolean).map(line => line.slice(3));
  const matches = sameRemote(origin, id, source);
  // One fetch so the page can say how far behind GitHub the folder is; a failed fetch leaves the counts null.
  let behind = null, ahead = null;
  if (matches) {
    try {
      await execute('git', ['-C', destination, ...GIT_CRED, 'fetch', '--quiet', 'origin', 'main']);
      behind = Number((await git('rev-list', '--count', 'HEAD..origin/main')).trim());
      ahead = Number((await git('rev-list', '--count', 'origin/main..HEAD')).trim());
    } catch {}
  }
  return { destination, exists: true, git: true, branch, origin, matches, dirty, behind, ahead };
}

// Fast-forwards the local main to origin/main. Refuses, changing nothing, when the folder is not a
// clone of this repository, has uncommitted tracked changes, or holds local commits main lacks.
export async function updateMain({ root, id, source, execute = run, onOutput = () => {} }) {
  const state = await localState({ root, id, source, execute });
  if (!state.exists) throw new Error(`No local folder at ${state.destination}. Clone it first.`);
  if (!state.git) throw new Error(`${state.destination} is not a Git repository. Move it aside, then clone.`);
  if (!state.matches) throw new Error(`${state.destination} points at ${state.origin || 'no origin'}, not ${id}. Nothing changed.`);
  if (state.dirty.length) throw new Error(`Uncommitted changes in ${state.destination}: ${state.dirty.slice(0, 8).join(', ')}${state.dirty.length > 8 ? ', ...' : ''}. Commit, stash, or discard them first. Nothing changed.`);
  const git = (args, options) => execute('git', ['-C', state.destination, ...GIT_CRED, ...args], options);
  onOutput('Fetching origin/main…\n');
  await git(['fetch', '--progress', 'origin', 'main'], { onOutput });
  if (state.branch !== 'main') {
    onOutput(`Switching from ${state.branch} to main…\n`);
    const hasMain = await git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']).then(() => true, () => false);
    await git(hasMain ? ['checkout', 'main'] : ['checkout', '-b', 'main', '--track', 'origin/main'], { onOutput });
  }
  const before = (await git(['rev-parse', 'HEAD'])).trim();
  try { await git(['merge', '--ff-only', 'origin/main'], { onOutput }); }
  catch (error) { throw new Error(`Local main has commits GitHub does not; cannot fast-forward. Push or move them first. ${error.message}`); }
  const after = (await git(['rev-parse', 'HEAD'])).trim();
  const count = before === after ? '0' : (await git(['rev-list', '--count', `${before}..${after}`])).trim();
  onOutput(before === after ? 'Already up to date with origin/main.\n' : `Ready. main moved forward ${count} commit${count === '1' ? '' : 's'} to origin/main.\n`);
  return state.destination;
}

export function github(execute = run) {
  return {
    async account() {
      try { return { connected: true, login: JSON.parse(await execute('gh', ['api', 'user'])).login }; }
      catch (error) {
        const needsLogin = /auth login|not logged|authentication|bad credentials|HTTP 401/i.test(error.message);
        return { connected: false, needsLogin, login: null, error: error.message };
      }
    },
    async repositories() {
      const pages = JSON.parse(await execute('gh', ['api', '--paginate', '--slurp', 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=updated']));
      return pages.flat().map(repo => ({ id: repo.full_name, name: repo.name, owner: repo.owner.login, description: repo.description || '', private: repo.private, language: repo.language, updated: repo.updated_at, defaultBranch: repo.default_branch }));
    },
    async login(onOutput) { await execute('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { onOutput, env: { GH_PROMPT_DISABLED: '1' } }); },
  };
}

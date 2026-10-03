import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_TEMPLATE } from './harness.mjs';
import { readSkipList, SKIP_FILE } from './sync.mjs';

// One settings file per user, in the OS app-data folder. It holds no credentials, so it can later be
// synced to an account as it is. Shape (version 1):
//   workspace        folder the clones live in, or null until the user picks one
//   defaultTemplate  owner/name of the template new projects start from
//   projects         { "owner/name": { paused: "reason", template: "owner/name" } }: a paused project is
//                    never written by a sync; template overrides defaultTemplate for that project
//   lastSelected     owner/name of the repository last cloned, or null
export const APP_NAME = 'Harness Firmware';

export function settingsDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'harness-firmware');
}
export const settingsFile = options => path.join(settingsDir(options), 'settings.json');

// Harness Console kept its state in ~/.corewise-cloner and its clones in ~/CoreWise, and shipped its
// skip list in the app folder. A first start that finds that folder imports all three.
export const legacyPaths = ({ home = homedir() } = {}) => ({ dir: path.join(home, '.corewise-cloner'), preferences: path.join(home, '.corewise-cloner', 'preferences.json'), root: path.join(home, 'CoreWise'), skip: SKIP_FILE });

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const defaults = () => ({ version: 1, workspace: null, defaultTemplate: DEFAULT_TEMPLATE, projects: {}, lastSelected: null });

export function validateSettings(data, label = 'settings') {
  const fail = detail => { throw new Error(`${label}: ${detail}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1) fail('expected an object with "version": 1');
  if (data.workspace !== null && (typeof data.workspace !== 'string' || !path.isAbsolute(data.workspace))) fail('"workspace" must be an absolute folder path or null');
  if (typeof data.defaultTemplate !== 'string' || !REPO.test(data.defaultTemplate)) fail('"defaultTemplate" must be owner/name');
  if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) fail('"projects" must be an object keyed by owner/name');
  for (const [id, project] of Object.entries(data.projects)) {
    if (!REPO.test(id)) fail(`project ${JSON.stringify(id)} is not owner/name`);
    if (!project || typeof project !== 'object' || Array.isArray(project)) fail(`project ${id} must be an object`);
    if (project.paused !== undefined && typeof project.paused !== 'string') fail(`project ${id}: "paused" must be a reason, or left out`);
    if (project.template !== undefined && (typeof project.template !== 'string' || !REPO.test(project.template))) fail(`project ${id}: "template" must be owner/name, or left out`);
  }
  if (data.lastSelected !== null && (typeof data.lastSelected !== 'string' || !REPO.test(data.lastSelected))) fail('"lastSelected" must be owner/name or null');
  return data;
}

// Written beside the target and renamed over it, so a crash never leaves half a file.
export async function saveSettings(file, settings) {
  validateSettings(settings, file);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }); throw error; }
}

const exists = file => access(file).then(() => true, () => false);

// The file as it is on disk now. Throws when it is missing, unreadable or invalid.
export async function readSettings(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { throw Object.assign(new Error(error.code === 'ENOENT' ? `${file}: the file is gone` : `${file}: ${error.message}`), { code: error.code }); }
  let data;
  try { data = JSON.parse(raw); } catch (error) { throw new Error(`${file}: not valid JSON. ${error.message}`); }
  return validateSettings(data, file);
}

// Applies a change to the file as it is now, so an edit the user made while the app ran is kept.
// A file that is gone or broken is left alone: rewriting it would drop its paused projects.
export async function updateSettings(file, change) {
  const settings = { ...await readSettings(file), ...change };
  await saveSettings(file, settings);
  return settings;
}

// Reads the settings file, or creates it on first start. A file that exists but cannot be read or
// fails validation throws: the caller refuses syncs rather than forget which projects are paused.
export async function loadSettings({ file = settingsFile(), legacy = legacyPaths() } = {}) {
  try { return { settings: await readSettings(file), migrated: false }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = defaults();
  const migrated = Boolean(legacy) && await exists(legacy.dir);
  if (migrated) {
    if (await exists(legacy.root)) settings.workspace = legacy.root;
    try { const last = JSON.parse(await readFile(legacy.preferences, 'utf8')).lastSelected; if (typeof last === 'string' && REPO.test(last)) settings.lastSelected = last; } catch {}
    // A skip list that is present but unreadable stops here, so no frozen repository loses its pause.
    let skip = [];
    try { skip = await readSkipList(legacy.skip); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const { repo, reason } of skip) if (REPO.test(repo)) settings.projects[repo] = { paused: reason };
  }
  await saveSettings(file, settings);
  return { settings, migrated };
}

// The template a project syncs from: its own, else the default. templateIds lists every template in
// use, so their clones are never treated as projects.
export const templateOf = (settings, id) => Object.entries(settings.projects).find(([key]) => key.toLowerCase() === String(id).toLowerCase())?.[1].template ?? settings.defaultTemplate;
export const templateIds = settings => [...new Set([settings.defaultTemplate, ...Object.values(settings.projects).map(project => project.template).filter(Boolean)])];

// The paused projects as the skip list sync.mjs reads: [{ repo, reason }]. A pause with no reason
// still pauses; skipReason tells "not listed" (null) apart from any reason.
export const pausedList = settings => Object.entries(settings.projects)
  .filter(([, project]) => typeof project.paused === 'string')
  .map(([repo, project]) => ({ repo, reason: project.paused.trim() || 'Updates paused' }));

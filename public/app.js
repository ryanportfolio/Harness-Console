const $ = id => document.getElementById(id);
let token, root, repos = [], selected, busy = false, lastJobStatus, stopped = false, account = null;
async function api(route, body) {
  const response = await fetch(`/api/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CoreWise-Token': token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function list() {
  const query = $('search').value.toLowerCase();
  const filtered = repos.filter(repo => `${repo.id} ${repo.description}`.toLowerCase().includes(query));
  $('count').textContent = repos.length;
  $('repoList').replaceChildren();
  if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = query ? 'No matching repositories.' : 'Your repositories will appear here.'; $('repoList').append(empty); }
  for (const repo of filtered) {
    const button = document.createElement('button'); button.className = `repo${repo.id === selected?.id ? ' selected' : ''}`; button.setAttribute('aria-pressed', String(repo.id === selected?.id));
    const title = document.createElement('strong'); title.textContent = repo.name;
    const sub = document.createElement('small'); const owner = document.createElement('span'); owner.textContent = repo.owner; const visibility = document.createElement('span'); visibility.textContent = repo.private ? 'Private' : 'Public'; sub.append(owner, visibility); button.append(title, sub); button.onclick = () => select(repo); $('repoList').append(button);
  }
}
function select(repo) {
  selected = repo; $('empty').hidden = true; $('detail').hidden = false;
  $('owner').textContent = repo.owner; $('name').textContent = repo.name; $('repoLink').href = 'https://github.com/' + repo.id.split('/').map(encodeURIComponent).join('/'); $('repoLink').setAttribute('aria-label', `Open ${repo.id} on GitHub (new tab)`); $('visibility').textContent = repo.private ? 'Private' : 'Public'; $('description').textContent = repo.description || 'Bring this repository into your workspace.'; $('language').textContent = repo.language || 'Git repository'; $('updated').textContent = repo.updated ? `Updated ${new Date(repo.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  $('destination').textContent = root + (root.includes('\\') ? '\\' : '/') + repo.name; list(); checkLocal();
}
// The destination may already hold a clone; then the card offers a fast-forward of main instead of a clone.
let local = null;
async function checkLocal() {
  const repo = selected; local = null; renderLocal();
  try { const state = await api(`local?id=${encodeURIComponent(repo.id)}`); if (selected !== repo) return; local = state; }
  catch (error) { if (selected !== repo) return; local = { exists: false, error: error.message }; }
  renderLocal();
}
function renderLocal() {
  const button = $('clone'), note = $('localState');
  const label = (text, glyph) => { const arrow = document.createElement('span'); arrow.textContent = glyph; button.replaceChildren(text + ' ', arrow); };
  let blocked = false;
  if (!local) { label('Checking folder', '…'); note.textContent = ''; blocked = true; }
  else if (!local.exists) { label('Clone main', '↓'); note.textContent = local.error || ''; }
  else if (!local.git) { label('Clone main', '↓'); note.textContent = 'A folder with this name exists and is not a Git repository. Move it aside first.'; blocked = true; }
  else if (!local.matches) { label('Update main', '↻'); note.textContent = `The local folder points at ${local.origin || 'no origin'}, not this repository.`; blocked = true; }
  else {
    label('Update main', '↻');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const distance = local.behind === null ? 'GitHub not reachable to compare' : local.behind === 0 && local.ahead === 0 ? 'up to date with GitHub' : local.behind === 0 ? `${plural(local.ahead, 'local commit')} not on GitHub, nothing to pull` : `${plural(local.behind, 'commit')} behind GitHub${local.ahead ? `, ${plural(local.ahead, 'local commit')} not on GitHub` : ''}`;
    note.textContent = local.dirty.length ? `Local folder on ${local.branch}, ${distance}, ${plural(local.dirty.length, 'uncommitted file')}. Commit or discard them before updating.` : `Local folder on ${local.branch}, clean, ${distance}.`;
  }
  button.dataset.kind = local?.git && local.matches ? 'update' : 'clone';
  const updating = button.dataset.kind === 'update';
  $('cardTitle').textContent = updating ? 'Update repository' : 'Clone repository';
  $('cardHint').textContent = updating ? 'Fast-forwards your local main to what is on GitHub.' : 'A working copy, ready for your changes.';
  button.disabled = busy || blocked;
}
async function refresh() {
  notice(); $('refresh').disabled = true;
  try {
    const state = await api('status'); token = state.token; root = state.root; account = state; renderConnection();
    $('account').textContent = state.connected ? state.login : state.needsLogin === false ? 'GitHub unavailable' : 'Connect GitHub'; $('accountHint').textContent = state.connected ? 'GitHub connected' : state.needsLogin === false ? 'Check connection and refresh' : 'Use your GitHub account'; $('login').hidden = state.connected || state.needsLogin === false;
    if (!state.connected) { repos = []; list(); notice(state.error || 'Sign in to browse your public and private repositories.'); return; }
    repos = (await api('repos')).repos;
    const next = repos.find(repo => repo.id === (selected?.id || state.lastSelected)) || repos[0];
    if (next) select(next); else { selected = null; $('detail').hidden = true; $('empty').hidden = false; list(); }
  } catch (error) { notice(error.message); }
  finally { $('refresh').disabled = busy; }
}
async function start(kind) {
  notice();
  try { await api(kind, kind === 'clone' || kind === 'update' ? { id: selected.id } : {}); lastJobStatus = undefined; await poll(); }
  catch (error) { notice(error.message); }
}
async function poll() {
  if (stopped) return;
  try {
    const { job } = await api('job'); if (!job) return;
    busy = job.status === 'running'; $('login').disabled = busy; $('refresh').disabled = busy; $('connectButton').disabled = busy; renderLocal();
    if (job.kind === 'create') renderCreateJob(job);
    else if (job.kind === 'sync') renderSyncJob(job);
    else if (job.kind === 'dsh') renderDshJob(job);
    else {
      const verb = job.kind === 'update' ? 'Update' : 'Clone';
      $('activity').hidden = false; $('activityTitle').textContent = job.kind === 'login' ? 'GitHub sign-in' : job.status === 'complete' ? 'Repository ready' : job.status === 'failed' ? `${verb} needs attention` : job.kind === 'update' ? 'Updating main' : 'Cloning main'; $('jobState').textContent = job.status === 'running' ? 'In progress' : job.status === 'complete' ? 'Complete' : 'Failed'; $('log').textContent = job.log || 'Starting…'; $('log').scrollTop = $('log').scrollHeight;
      if (job.status === 'failed') notice(job.error);
    }
    if (job.kind === 'login' && job.status === 'complete' && lastJobStatus !== 'complete') await refresh();
    if ((job.kind === 'clone' || job.kind === 'update') && job.status !== 'running' && lastJobStatus === 'running' && selected) checkLocal();
    lastJobStatus = job.status;
  } catch (error) { notice(`Connection lost. Reopen Harness Console to reconnect. ${error.message}`); }
}
const tabs = { usage: ['tabUsage', 'usage'], repos: ['tabRepos', 'repoView'], new: ['tabNew', 'newView'], sync: ['tabSync', 'syncView'], dsh: ['tabDsh', 'dshView'] };
let trackerUp = false;
function showTab(name) {
  for (const [key, [tab, panel]] of Object.entries(tabs)) { $(tab).setAttribute('aria-selected', String(key === name)); $(panel).hidden = key !== name; }
  document.body.classList.toggle('view-usage', name === 'usage');
  document.body.classList.toggle('view-new', name === 'new' || name === 'sync' || name === 'dsh');
  if (name === 'sync' && !sync.scanned) void scanSync();
  if (name === 'dsh' && !dsh.scanned) void scanDsh();
  try { localStorage.setItem('corewise.tab', name); } catch {}
}
async function pollTracker() {
  if (stopped || $('usage').hidden) return;
  try {
    const { up, url } = await api('tracker');
    $('usageWaitUrl').textContent = ` at ${url}`;
    if (up && !trackerUp) $('usageFrame').src = url;
    trackerUp = up; $('usageFrame').hidden = !up; $('usageWait').hidden = up;
  } catch { trackerUp = false; $('usageFrame').hidden = true; $('usageWait').hidden = false; }
}

// New project: the fullbuild.ai creator, backed by gh repo create --template and a clone into the CoreWise folder.
const catalog = { groups: [], skills: [], state: new Map(), loaded: false, error: null };
let creating = false;
const enabledSkillCount = () => [...catalog.state.values()].filter(Boolean).length;
const disabledSkills = () => catalog.skills.filter(skill => !catalog.state.get(skill.name)).map(skill => skill.name);
function setConnection(title, copy, connected = false) {
  $('connection').classList.toggle('connected', connected);
  $('connection').querySelector('strong').textContent = title;
  $('connection').querySelector('p').textContent = copy;
}
function setCreateState(next) {
  creating = next;
  $('createButton').disabled = next; $('skillTrigger').disabled = next || !catalog.loaded;
  $('createButton').classList.toggle('is-creating', next); $('createButton').setAttribute('aria-busy', String(next));
  $('createButton').querySelector('[data-action-label]').textContent = next ? 'Assembling repository' : catalog.loaded ? `Create with ${enabledSkillCount()} skills` : 'Create repository';
  $('createButton').querySelector('[data-action-glyph]').textContent = next ? 'Working' : '->';
}
function updateSkillCounts() {
  const enabled = enabledSkillCount();
  $('skillCount').textContent = `${enabled} enabled`; $('skillTrigger').setAttribute('aria-label', `Customize skills, ${enabled} enabled`); $('skillPickerCount').textContent = `${enabled} skills enabled`;
  if (!creating) $('createButton').querySelector('[data-action-label]').textContent = `Create with ${enabled} skills`;
  for (const group of catalog.groups) {
    const members = catalog.skills.filter(skill => skill.group === group.id); const on = members.filter(skill => catalog.state.get(skill.name)).length;
    const output = $('skillGroups').querySelector(`[data-group-count="${group.id}"]`); if (output) output.textContent = `${on}/${members.length} on`;
  }
}
function skillOption(skill) {
  const option = document.createElement('label'); option.className = `skill-option is-enabled${skill.required ? ' is-required' : ''}`;
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true; input.disabled = skill.required === true; input.dataset.skillName = skill.name; input.setAttribute('aria-describedby', `skill-description-${skill.name}`);
  input.addEventListener('change', () => { catalog.state.set(skill.name, input.checked); option.classList.toggle('is-enabled', input.checked); updateSkillCounts(); });
  const copy = document.createElement('span'); copy.className = 'skill-option-copy';
  const label = document.createElement('strong'); label.textContent = skill.label;
  const description = document.createElement('small'); description.id = `skill-description-${skill.name}`; description.textContent = skill.description; copy.append(label, description);
  const meta = document.createElement('span'); meta.className = 'skill-option-meta';
  const slug = document.createElement('code'); slug.textContent = skill.name;
  const state = document.createElement('span'); state.textContent = skill.required ? 'Required later' : 'Optional'; meta.append(slug, state);
  option.append(input, copy, meta); return option;
}
function renderSkillPicker() {
  $('skillGroups').replaceChildren(...catalog.groups.map(group => {
    const section = document.createElement('section'); section.className = 'skill-group'; section.setAttribute('aria-labelledby', `skill-group-${group.id}`);
    const head = document.createElement('header'); head.className = 'skill-group-head';
    const copy = document.createElement('div'); const title = document.createElement('h3'); title.id = `skill-group-${group.id}`; title.textContent = group.label; const description = document.createElement('p'); description.textContent = group.description; copy.append(title, description);
    const count = document.createElement('output'); count.dataset.groupCount = group.id; head.append(copy, count);
    section.append(head, ...catalog.skills.filter(skill => skill.group === group.id).map(skillOption)); return section;
  }));
  updateSkillCounts();
}
function setOptionalSkills(enabled) {
  for (const skill of catalog.skills) {
    if (skill.required) continue;
    catalog.state.set(skill.name, enabled);
    const input = $('skillGroups').querySelector(`[data-skill-name="${skill.name}"]`); input.checked = enabled; input.closest('.skill-option').classList.toggle('is-enabled', enabled);
  }
  updateSkillCounts();
}
async function loadSkills() {
  if (catalog.loaded) return;
  try {
    const result = await api('skills');
    catalog.groups = result.groups; catalog.skills = result.skills; catalog.state = new Map(result.skills.map(skill => [skill.name, true])); catalog.loaded = true; catalog.error = null;
    renderSkillPicker(); $('skillTrigger').disabled = creating; setCreateState(creating);
  } catch (error) { catalog.error = error.message; $('skillCount').textContent = 'Unavailable'; $('newError').textContent = error.message; }
}
function renderConnection() {
  const panel = document.querySelector('#newView .creator-panel'); panel.classList.remove('is-loading');
  if (lastJobStatus !== undefined && !$('newSuccess').hidden) return;
  if (!account?.connected) {
    setConnection(account?.needsLogin === false ? 'GitHub CLI unavailable' : 'GitHub connection needed', account?.needsLogin === false ? (account.error || 'Check the GitHub CLI and refresh') : 'Sign in once through the GitHub CLI, then projects are one click');
    $('newForm').hidden = true; $('newFallback').hidden = false; $('skillTrigger').hidden = true; return;
  }
  setConnection(`Connected as ${account.login}`, 'Choose the repository details and active skill set', true);
  $('newFallback').hidden = true; $('newForm').hidden = $('newSuccess').hidden === false; $('skillTrigger').hidden = false;
  void loadSkills();
}
function updateDestination() {
  const name = $('repoName').value.trim();
  $('newDestination').replaceChildren();
  if (!root) return;
  const label = document.createElement('span'); label.textContent = 'CLONES TO '; const target = document.createElement('b'); target.textContent = root + (root.includes('\\') ? '\\' : '/') + (name || 'my-new-project'); $('newDestination').append(label, target);
}
// The job slot keeps the finished create until the next operation; once dismissed it must not repaint.
let dismissedCreate = null;
const createKey = job => `${job.id}:${job.status}:${job.log.length}`;
function renderCreateJob(job) {
  if (job.status !== 'running' && createKey(job) === dismissedCreate) return;
  $('newLog').hidden = !job.log; $('newLog').textContent = job.log; $('newLog').scrollTop = $('newLog').scrollHeight;
  if (job.status === 'running') { setCreateState(true); return; }
  if (creating) setCreateState(false);
  if (job.status === 'failed') { $('newError').textContent = job.error; return; }
  if (!$('newSuccess').hidden) return;
  $('newForm').hidden = true; $('connection').hidden = true; $('newSuccess').hidden = false; $('newError').textContent = '';
  $('successName').textContent = job.remoteUrl ? job.remoteUrl.replace(/^https:\/\/github\.com\//, '') : job.id;
  $('successLink').href = job.remoteUrl || '#'; $('successLink').hidden = !job.remoteUrl;
  const omitted = job.disabledSkills?.length || 0, total = catalog.loaded ? catalog.skills.length : null;
  $('successSummary').replaceChildren();
  const skillsLine = document.createElement('span'); skillsLine.textContent = total === null ? (omitted ? `${omitted} skills omitted. ` : '') : omitted ? `${total - omitted} skills included, ${omitted} omitted. ` : `All ${total} skills enabled. `;
  const where = document.createElement('span'); where.textContent = 'Cloned to '; const target = document.createElement('b'); target.textContent = job.destination || ''; $('successSummary').append(skillsLine, where, target);
}
async function resetCreator() {
  try { const { job } = await api('job'); if (job?.kind === 'create' && job.status !== 'running') dismissedCreate = createKey(job); } catch {}
  $('newSuccess').hidden = true; $('connection').hidden = false; $('newLog').hidden = true; $('newLog').textContent = ''; $('newError').textContent = '';
  $('repoName').value = ''; $('repoDescription').value = ''; $('repoPrivate').checked = true; lastJobStatus = undefined; updateDestination(); renderConnection(); $('repoName').focus();
}
$('newForm').addEventListener('submit', async event => {
  event.preventDefault(); $('newError').textContent = '';
  const name = $('repoName').value.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) { $('newError').textContent = 'Use letters, digits, dot, dash, or underscore.'; return; }
  setCreateState(true);
  try { await api('create', { name, description: $('repoDescription').value.trim(), private: $('repoPrivate').checked, disabledSkills: disabledSkills() }); lastJobStatus = undefined; await poll(); }
  catch (error) { setCreateState(false); $('newError').textContent = error.message; }
});
$('repoName').addEventListener('input', updateDestination);
$('connectButton').onclick = () => { $('newError').textContent = ''; showTab('repos'); void start('login'); };
$('createAnother').onclick = resetCreator;
$('skillTrigger').onclick = () => { $('skillTrigger').setAttribute('aria-expanded', 'true'); $('skillPicker').showModal(); $('skillPickerClose').focus(); };
const closeSkillPicker = () => { if ($('skillPicker').open) $('skillPicker').close(); };
$('skillPicker').addEventListener('close', () => { $('skillTrigger').setAttribute('aria-expanded', 'false'); $('skillTrigger').focus(); });
$('skillPicker').addEventListener('click', event => { if (event.target === $('skillPicker')) closeSkillPicker(); });
$('skillPicker').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeSkillPicker(); } });
$('skillPickerClose').onclick = closeSkillPicker; $('skillsDone').onclick = closeSkillPicker;
$('skillsEnableAll').onclick = () => setOptionalSkills(true); $('skillsClearOptional').onclick = () => setOptionalSkills(false);

// Skill sync: compare every Harness clone with the template, then push chosen skills to each main.
const sync = { scanned: false, scanning: false, data: null, armed: false };
// The third field marks groups with checkboxes; every box starts unchecked so a push takes only what was picked.
const SYNC_GROUPS = [
  ['behind', 'Update', true], ['new', 'Add', true], ['removed', 'Remove', true],
  ['customized', 'Edited here', true], ['removed-edited', 'Removed upstream, edited here'], ['off', 'Turned off'],
];
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
async function scanSync() {
  if (sync.scanning) return;
  sync.scanned = true; sync.scanning = true; sync.armed = false; renderSyncFoot();
  $('syncScan').disabled = true; $('syncScan').firstChild.textContent = 'Checking repositories ';
  try { sync.data = await api('sync'); $('syncTemplate').textContent = `Harness-Firmware main ${sync.data.template.head.slice(0, 7)}`; renderSync(); }
  catch (error) { sync.data = null; $('syncTools').hidden = true; const p = document.createElement('p'); p.className = 'sync-current'; p.textContent = error.message; $('syncRepos').replaceChildren(p); }
  finally { sync.scanning = false; $('syncScan').disabled = busy; $('syncScan').firstChild.textContent = 'Check repositories '; renderSyncFoot(); }
}
const repoBoxes = id => [...$('syncRepos').querySelectorAll(`input[data-repo="${CSS.escape(id)}"][data-action="apply"]`)];
function syncRepoToggle(id) {
  const toggle = $('syncRepos').querySelector(`input[data-toggle="${CSS.escape(id)}"]`); if (!toggle) return;
  const boxes = repoBoxes(id), on = boxes.filter(box => box.checked).length;
  toggle.checked = on > 0 && on === boxes.length; toggle.indeterminate = on > 0 && on < boxes.length;
}
function syncCheckbox(repo, skill, checked) {
  const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
  input.dataset.repo = repo.id; input.dataset.skill = skill.name; input.dataset.action = { removed: 'remove', customized: 'replace' }[skill.status] ?? 'apply';
  input.addEventListener('change', () => { sync.armed = false; syncRepoToggle(repo.id); renderSyncFoot(); });
  if (skill.status !== 'customized') { label.append(input, skill.name); return label; }
  // An edited copy names what differs, so replacing it is a choice made with the edits in view.
  const { changed, added, missing } = skill.files;
  const parts = [changed.length && `${changed.join(', ')} changed`, added.length && `${added.join(', ')} added here`, missing.length && `${missing.join(', ')} missing here`].filter(Boolean);
  const text = document.createElement('span'); const b = document.createElement('b'); b.textContent = skill.name; text.append(b, `: ${parts.join('; ') || 'Codex copy differs'}`);
  label.className = 'sync-edited'; label.append(input, text); return label;
}
function syncRepoBlock(repo) {
  const section = document.createElement('section'); section.className = 'sync-repo';
  const head = document.createElement('div'); head.className = 'sync-repo-head';
  const title = document.createElement('h2'); title.textContent = repo.name;
  const id = document.createElement('span'); id.className = 'pill'; id.textContent = repo.id;
  head.append(title, id);
  const tally = status => repo.skills.filter(skill => skill.status === status).length;
  if (tally('behind') + tally('new')) {
    const toggle = document.createElement('label'); toggle.className = 'sync-toggle'; const box = document.createElement('input'); box.type = 'checkbox'; box.dataset.toggle = repo.id;
    box.addEventListener('change', () => { for (const input of repoBoxes(repo.id)) input.checked = box.checked; sync.armed = false; syncRepoToggle(repo.id); renderSyncFoot(); });
    toggle.append(box, 'All updates and additions'); head.append(toggle);
  }
  const counts = document.createElement('p'); counts.className = 'sync-counts';
  counts.textContent = [`${tally('same')} current`, tally('behind') && `${tally('behind')} behind`, tally('new') && `${tally('new')} new`, tally('removed') + tally('removed-edited') && `${tally('removed') + tally('removed-edited')} removed upstream`, tally('customized') && `${tally('customized')} edited here`, tally('off') && `${tally('off')} turned off`].filter(Boolean).join(', ');
  section.append(head, counts);
  for (const [status, label, checkable] of SYNC_GROUPS) {
    const skills = repo.skills.filter(skill => skill.status === status); if (!skills.length) continue;
    const group = document.createElement('div'); group.className = 'sync-group';
    const name = document.createElement('span'); name.textContent = label;
    const list = document.createElement('div'); list.className = 'sync-skills';
    if (checkable) list.append(...skills.map(skill => syncCheckbox(repo, skill, false)));
    else list.append(...skills.map(skill => { const span = document.createElement('span'); span.className = 'plain'; span.textContent = skill.name; return span; }));
    group.append(name, list); section.append(group);
  }
  return section;
}
function renderSync() {
  const repos = sync.data.repos;
  const actionable = repos.filter(repo => !repo.error && repo.skills.some(skill => ['behind', 'new', 'removed', 'customized'].includes(skill.status)));
  // A repository whose only differences are local edits still gets a block, so those edits stay visible.
  const shown = repos.filter(repo => !repo.error && repo.skills.some(skill => !['same', 'off'].includes(skill.status)));
  const current = repos.filter(repo => !repo.error && !shown.includes(repo));
  const blocks = shown.map(syncRepoBlock);
  const line = (label, text) => { const p = document.createElement('p'); p.className = 'sync-current'; const span = document.createElement('span'); span.textContent = label; p.append(span, text); return p; };
  if (current.length) blocks.push(line('Nothing to sync: ', current.map(repo => repo.name).join(', ')));
  for (const repo of repos.filter(repo => repo.error)) blocks.push(line(`${repo.name}: `, `could not fetch. ${repo.error}`));
  if (!repos.length) blocks.push(line('', 'No Harness repositories are cloned in your CoreWise folder.'));
  $('syncRepos').replaceChildren(...blocks);
  for (const repo of actionable) syncRepoToggle(repo.id);
  $('syncTools').hidden = !actionable.length;
  renderSyncFoot();
}
// Page-wide selection: updates and additions only; removals and replacements are always picked one by one.
function setAllSync(on) {
  for (const input of $('syncRepos').querySelectorAll(on ? 'input[data-action="apply"]' : 'input[data-skill]')) input.checked = on;
  for (const repo of sync.data?.repos ?? []) syncRepoToggle(repo.id);
  sync.armed = false; renderSyncFoot();
}
function syncSelection() {
  const byRepo = new Map();
  for (const input of $('syncRepos').querySelectorAll('input[data-skill]:checked')) {
    const entry = byRepo.get(input.dataset.repo) ?? { id: input.dataset.repo, apply: [], remove: [], replace: [] };
    entry[input.dataset.action].push(input.dataset.skill); byRepo.set(entry.id, entry);
  }
  return [...byRepo.values()];
}
function renderSyncFoot() {
  const selection = sync.data ? syncSelection() : [];
  const total = key => selection.reduce((sum, item) => sum + item[key].length, 0), applies = total('apply'), removals = total('remove'), replacements = total('replace');
  $('syncFoot').hidden = !sync.data || $('syncTools').hidden;
  const picked = [applies && `${count(applies, 'skill', 'skills')} to update or add`, replacements && `${count(replacements, 'edited copy', 'edited copies')} to replace`, removals && count(removals, 'removal', 'removals')].filter(Boolean).join(', ');
  $('syncSummary').textContent = !selection.length ? 'Nothing selected' : `${picked}, across ${count(selection.length, 'repository', 'repositories')}${replacements ? '. Replaced skills lose the edits made in their repository.' : ''}`;
  $('syncSelectAll').disabled = $('syncClearAll').disabled = busy || sync.scanning;
  $('syncApply').disabled = busy || sync.scanning || !selection.length;
  $('syncApply').firstChild.textContent = sync.armed ? `Confirm push to ${count(selection.length, 'main branch', 'main branches')} ` : 'Push to main ';
  for (const input of $('syncRepos').querySelectorAll('input')) input.disabled = busy;
}
async function applySync() {
  const selection = syncSelection(); if (!selection.length) return;
  if (!sync.armed) { sync.armed = true; renderSyncFoot(); return; }
  sync.armed = false;
  try { await api('sync', { repos: selection }); lastJobStatus = undefined; await poll(); }
  catch (error) { $('syncActivity').hidden = false; $('syncActivityTitle').textContent = 'Sync needs attention'; $('syncJobState').textContent = ''; $('syncLog').textContent = error.message; renderSyncFoot(); }
}
function renderSyncJob(job) {
  $('syncActivity').hidden = false;
  $('syncActivityTitle').textContent = job.status === 'running' ? 'Syncing skills' : job.status === 'complete' ? 'Skills synced' : 'Sync needs attention';
  $('syncJobState').textContent = job.status === 'running' ? 'In progress' : job.status === 'complete' ? 'Complete' : 'Failed';
  $('syncLog').textContent = job.log || 'Starting…'; $('syncLog').scrollTop = $('syncLog').scrollHeight;
  $('syncScan').disabled = busy || sync.scanning; renderSyncFoot();
  if (job.status !== 'running' && lastJobStatus === 'running') void scanSync();
}
$('syncScan').onclick = () => { void scanSync(); };
$('syncApply').onclick = () => { void applySync(); };
$('syncSelectAll').onclick = () => setAllSync(true); $('syncClearAll').onclick = () => setAllSync(false);

// DSH skills: preview the Harness-Firmware skills against the DSH global folder, then install picks.
const dsh = { scanned: false, scanning: false, data: null, armed: false };
const DSH_GROUPS = [['new', 'Add'], ['update', 'Update'], ['conflict', 'Changed in DSH'], ['current', 'Current'], ['invalid', 'Cannot install']];
async function scanDsh() {
  if (dsh.scanning) return;
  dsh.scanned = true; dsh.scanning = true; dsh.armed = false; $('dshScan').disabled = true; $('dshScan').firstChild.textContent = 'Checking DSH skills '; renderDshFoot();
  try {
    dsh.data = await api('dsh');
    $('dshSource').textContent = `Harness-Firmware ${dsh.data.source.commit.slice(0, 7)} to ${dsh.data.dest}`;
    renderDsh();
  } catch (error) { dsh.data = null; $('dshTools').hidden = true; const p = document.createElement('p'); p.className = 'sync-current'; p.textContent = error.message; $('dshList').replaceChildren(p); }
  finally { dsh.scanning = false; $('dshScan').disabled = busy; $('dshScan').firstChild.textContent = 'Check DSH skills '; renderDshFoot(); }
}
function dshDetail(skill) {
  const parts = [`from ${skill.sourcePath}`, `${count(skill.files.length, 'file', 'files')}`];
  if (skill.reason) parts.push(skill.reason);
  if (skill.changes && skill.status !== 'current') { const { added, changed, removed } = skill.changes; parts.push(...[changed.length && `${changed.join(', ')} changed`, added.length && `${added.join(', ')} added`, removed.length && `${removed.join(', ')} removed`].filter(Boolean)); }
  parts.push(...skill.errors, ...skill.warnings, ...skill.notes);
  if (skill.skipped.length) parts.push(`not copied: ${skill.skipped.map(item => `${item.path} (${item.reason})`).join(', ')}`);
  const span = document.createElement('span'); span.className = 'dsh-detail'; const b = document.createElement('b'); b.textContent = skill.name;
  span.append(b, `: ${parts.join('; ')}`); return span;
}
function dshItem(skill) {
  if (!['new', 'update', 'conflict'].includes(skill.status)) return dshDetail(skill);
  const label = document.createElement('label'); label.className = 'dsh-detail';
  const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.dsh = skill.name; input.dataset.status = skill.status;
  input.addEventListener('change', () => { dsh.armed = false; renderDshFoot(); });
  label.append(input, dshDetail(skill));
  if (skill.status !== 'conflict') return label;
  // A changed DSH copy is backed up before it is replaced unless the backup box is cleared.
  const row = document.createElement('div'); row.className = 'dsh-conflict';
  const keep = document.createElement('label'); keep.className = 'sync-toggle'; const backup = document.createElement('input'); backup.type = 'checkbox'; backup.checked = true; backup.dataset.backup = skill.name;
  backup.addEventListener('change', () => { dsh.armed = false; renderDshFoot(); }); keep.append(backup, 'Back up the DSH copy');
  const compare = document.createElement('button'); compare.type = 'button'; compare.className = 'quiet'; compare.textContent = 'Compare'; compare.onclick = () => void compareDsh(skill.name);
  row.append(label, keep, compare); return row;
}
function renderDsh() {
  const { skills, destProblems, source } = dsh.data;
  const section = document.createElement('section'); section.className = 'sync-repo';
  const counts = document.createElement('p'); counts.className = 'sync-counts';
  counts.textContent = [source.note, ...DSH_GROUPS.map(([status, label]) => { const n = skills.filter(skill => skill.status === status).length; return n && `${n} ${label.toLowerCase().replace('dsh', 'DSH')}`; })].filter(Boolean).join(', ');
  section.append(counts);
  for (const [status, label] of DSH_GROUPS) {
    const items = skills.filter(skill => skill.status === status); if (!items.length) continue;
    const group = document.createElement('div'); group.className = 'sync-group';
    const name = document.createElement('span'); name.textContent = label;
    const list = document.createElement('div'); list.className = 'sync-skills'; list.append(...items.map(dshItem));
    group.append(name, list); section.append(group);
  }
  if (destProblems.length) {
    const group = document.createElement('div'); group.className = 'sync-group';
    const name = document.createElement('span'); name.textContent = 'DSH cannot load';
    const list = document.createElement('div'); list.className = 'sync-skills';
    list.append(...destProblems.map(problem => { const span = document.createElement('span'); span.className = 'dsh-detail'; span.textContent = problem; return span; }));
    group.append(name, list); section.append(group);
  }
  $('dshList').replaceChildren(section);
  $('dshTools').hidden = !skills.some(skill => ['new', 'update', 'conflict'].includes(skill.status));
  renderDshFoot();
}
function dshChoices() {
  return [...$('dshList').querySelectorAll('input[data-dsh]:checked')].map(input => ({ name: input.dataset.dsh, policy: input.dataset.status !== 'conflict' ? 'install' : $('dshList').querySelector(`input[data-backup="${CSS.escape(input.dataset.dsh)}"]`).checked ? 'backup' : 'replace' }));
}
function renderDshFoot() {
  const choices = dsh.data ? dshChoices() : [];
  $('dshFoot').hidden = !dsh.data || $('dshTools').hidden;
  const replaced = choices.filter(choice => choice.policy === 'replace').length, backed = choices.filter(choice => choice.policy === 'backup').length;
  $('dshSummary').textContent = !choices.length ? 'Nothing selected' : [`${count(choices.length, 'skill', 'skills')} to install in DSH`, backed && `${backed} changed DSH ${backed === 1 ? 'copy' : 'copies'} backed up first`, replaced && `${replaced} changed DSH ${replaced === 1 ? 'copy' : 'copies'} replaced without a backup`].filter(Boolean).join(', ');
  $('dshSelectAll').disabled = $('dshClearAll').disabled = busy || dsh.scanning;
  $('dshApply').disabled = busy || dsh.scanning || !choices.length;
  $('dshApply').firstChild.textContent = dsh.armed ? `Confirm install of ${count(choices.length, 'skill', 'skills')} ` : 'Install in DSH ';
  for (const input of $('dshList').querySelectorAll('input')) input.disabled = busy;
}
function setAllDsh(on) {
  for (const input of $('dshList').querySelectorAll(on ? 'input[data-status="new"], input[data-status="update"]' : 'input[data-dsh]')) input.checked = on;
  dsh.armed = false; renderDshFoot();
}
async function compareDsh(name) {
  $('dshCompare').hidden = false; $('dshCompareTitle').textContent = `Compare ${name}: DSH copy, then the copy Harness Console would install`; $('dshDiff').textContent = 'Loading…';
  try { $('dshDiff').textContent = (await api(`dsh/compare?name=${encodeURIComponent(name)}`)).diff; } catch (error) { $('dshDiff').textContent = error.message; }
}
async function applyDsh() {
  const choices = dshChoices(); if (!choices.length) return;
  if (!dsh.armed) { dsh.armed = true; renderDshFoot(); return; }
  dsh.armed = false;
  try { await api('dsh', { previewId: dsh.data.id, skills: choices }); lastJobStatus = undefined; await poll(); }
  catch (error) { $('dshActivity').hidden = false; $('dshActivityTitle').textContent = 'Install needs attention'; $('dshJobState').textContent = ''; $('dshLog').textContent = error.message; renderDshFoot(); }
}
function renderDshJob(job) {
  $('dshActivity').hidden = false;
  $('dshActivityTitle').textContent = job.status === 'running' ? 'Installing skills' : job.status === 'complete' ? 'Skills installed' : 'Install needs attention';
  $('dshJobState').textContent = job.status === 'running' ? 'In progress' : job.status === 'complete' ? 'Complete' : 'Failed';
  $('dshLog').textContent = job.log || 'Starting…'; $('dshLog').scrollTop = $('dshLog').scrollHeight;
  $('dshScan').disabled = busy || dsh.scanning; renderDshFoot();
  if (job.status !== 'running' && lastJobStatus === 'running') void scanDsh();
}
$('dshScan').onclick = () => { void scanDsh(); }; $('dshApply').onclick = () => { void applyDsh(); };
$('dshSelectAll').onclick = () => setAllDsh(true); $('dshClearAll').onclick = () => setAllDsh(false); $('dshCompareClose').onclick = () => { $('dshCompare').hidden = true; };
$('tabDsh').onclick = () => showTab('dsh');

$('tabUsage').onclick = () => { showTab('usage'); void pollTracker(); }; $('tabRepos').onclick = () => showTab('repos'); $('tabSync').onclick = () => showTab('sync'); $('tabNew').onclick = () => { showTab('new'); updateDestination(); if (account) renderConnection(); };
let remembered = 'usage'; try { remembered = localStorage.getItem('corewise.tab') || 'usage'; } catch {}
showTab(remembered in tabs ? remembered : 'usage'); void pollTracker(); setInterval(pollTracker, 2000);
$('search').addEventListener('input', list); $('refresh').onclick = refresh; $('clone').onclick = () => start($('clone').dataset.kind || 'clone'); $('login').onclick = () => start('login');
const quit = document.createElement('button'); quit.textContent = 'Quit app'; quit.className = 'quiet'; quit.onclick = async () => { try { await api('quit', {}); stopped = true; $('clone').disabled = true; $('refresh').disabled = true; $('login').disabled = true; $('createButton').disabled = true; quit.disabled = true; notice('Harness Console is closed. You can close this tab.'); $('newError').textContent = 'Harness Console is closed. You can close this tab.'; } catch (error) { notice(error.message); } }; document.querySelector('main > footer').append(quit);
void refresh().then(() => { updateDestination(); return poll(); }); setInterval(poll, 1000);

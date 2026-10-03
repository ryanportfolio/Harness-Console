# Architecture

> System flow, auth strategy, state management, cross-cutting structure. Keep it terse: pointers into code, not essays.

Two local servers, both bound to 127.0.0.1, plain Node with no npm dependencies.

- `launcher.mjs`: entry point (`Launch Harness Console.vbs` runs it). Serves the app on 43127, starts `usage/server.mjs` on 4545 (`USAGE_PORT` overrides), replaces a running instance unless it is mid-operation. Before loading the app it stops an idle running instance (a busy one is kept and the folder left alone), then fast-forwards the folder to `origin/main` (`selfUpdate`; only on a clean main) and, when main moved, relaunches itself (child shares the terminal and exit code) so the new code loads. The footer shows the build and any skip reason via `/api/status` `build`.
- `server.mjs`: HTTP API and static `public/`. Checks exact loopback host and origin; mutations need the `X-CoreWise-Token` session token. `/api/health` answers app id `corewise-cloner` (kept from the old name so the launcher recognizes older builds).
- `settings.mjs`: one `settings.json` per user in the OS app-data folder (`%APPDATA%\Harness Firmware` on Windows): workspace, default template, paused projects, last selection. The first start imports `~/CoreWise`, `~/.corewise-cloner/preferences.json` and `sync-skip.json` when `~/.corewise-cloner` exists. An unreadable file makes the server refuse syncs and locks and is never overwritten.
- `core.mjs`: GitHub adapter over `gh`, clone and update of `main`, `run()` (spawn, no shell).
- `harness.mjs`: New project tab (`gh repo create --template <defaultTemplate>`), skill catalog. `DEFAULT_TEMPLATE` (Harness-Firmware) is only the starting value for new settings.
- `sync.mjs`: Skill sync tab. Each clone compares with its own template (`projects[id].template` in settings, else `defaultTemplate`); one bare cache per template in `templates/` beside the settings file; clones of any template in use are not projects. Applies in a temp worktree on `origin/main`, pushes a `harness-sync/<template sha7>` branch, opens a pull request with `gh pr create`, squash-merges it with `gh pr merge --squash` and deletes the branch; never pushes to `main` directly. A refused merge leaves the pull request open and fails that repository. Paused projects from the settings file and GitHub's archived flag keep repositories out. `.agents/skill-locks.json` in a repository locks skills: the scan reports them as `locked` and apply skips them; `setSkillLock` edits that file through the same pull request and merge path.
- `dsh.mjs`: DSH skills tab. Reads `~/CoreWise/Harness-Firmware` at `origin/main`, installs into `~/.dsh/skills` via staging, rename swap and rollback; validates with DSH's own skill parser.
- `usage/`: the usage tracker (formerly the whole repo). Own server, `usage/accounts.json`, cache in `usage/.state/`. The app's Usage tab embeds it in an iframe.

State: settings in the app-data `settings.json`; clones in the workspace folder (`~/CoreWise` for an existing install); caches and DSH records still in `~/.corewise-cloner/` until the template step moves them.

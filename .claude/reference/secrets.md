# Secrets & environment variables

> Env var names, what they key, and where they're consumed. Never store actual secret VALUES here: names and purposes only.

| Env var | Keys what | Consumed in |
|---|---|---|
| `USAGE_PORT` | Usage tracker port (default 4545) | `launcher.mjs`, `usage/server.mjs` |
| `DSH_HOME` | DSH home folder (default `~/.dsh`) | `dsh.mjs` |
| `GH_TOKEN` | GitHub token for `meta.mjs --check` in CI | `.github/workflows/readme.yml` |

GitHub credentials otherwise stay with the `gh` CLI; tracker credentials are the CLIs' own files named in `usage/accounts.json`.

# Secrets & environment variables

> Env var names, what they key, and where they're consumed. Never store actual secret VALUES here: names and purposes only.

| Env var | Keys what | Consumed in |
|---|---|---|
| `USAGE_PORT` | Usage tracker port (default 4545) | `launcher.mjs`, `usage/server.mjs` |
| `USAGE_PROXY_DIR` | CLIProxyAPI folder holding `config.yaml` and the management key `dashboard-key.txt` (default `%LOCALAPPDATA%\CLIProxyAPI`) | `usage/proxy.mjs` |
| `USAGE_STATE_DIR` | Usage tracker state folder (default `usage/.state`) | `usage/server.mjs` |
| `DSH_HOME` | DSH home folder (default `~/.dsh`) | `dsh.mjs` |
| `GH_TOKEN` | GitHub token for `meta.mjs --check` in CI | `.github/workflows/readme.yml` |

GitHub credentials otherwise stay with the `gh` CLI; Claude and Codex logins and their tokens stay with CLIProxyAPI; the tracker reads only the proxy's management key and sends `$TOKEN$` placeholders that the proxy fills in.

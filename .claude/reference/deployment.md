# Deployment

> Deploy target, build output, asset paths, publish flow.

No deploy. The app runs from a local checkout on Windows (the launcher uses `netstat`, PowerShell and `rundll32`). The only publish step is the GitHub About panel: `node scripts/readme/meta.mjs --apply` pushes `scripts/readme/repo.json`; CI checks it on push to main.

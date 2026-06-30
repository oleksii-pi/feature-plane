# Implementation Notes

- Removed the redundant `sdlc.agents` section from `SDLC.yaml`.
- Relaxed `sdlc` parsing in `sdlc.js` so workflow validation no longer requires or checks a separate agent list.
- Removed the unused `agents` field from workflow snapshots in `server/workflow.js` so runtime state matches the config shape.
- Updated `requirements/control-plane-poc.md` to describe the workflow-only `SDLC.yaml` shape and the new agent instruction rule.

## Smoke Checks

- `node -e "const { loadSdlcConfig } = require('./sdlc'); const config = loadSdlcConfig(process.cwd()); console.log(config.workflow.length);"`
- `node -e "const { validateRepository } = require('./server/validation'); console.log(validateRepository().ok);"`
- `curl -fsS http://127.0.0.1:3105/repository/validation`

All checks passed after the change.

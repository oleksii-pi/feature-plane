# Merge Change Log

## User-Facing Changes
- Merged `main` into this feature branch.
- Kept the workflow-only `SDLC.yaml` shape. The branch still removes the `sdlc.agents` section, so workflow parsing does not require a separate agent list.
- Verified the app starts successfully on a free localhost port (`127.0.0.1:53549`).

## Changed Files
```text
\SDLC.yaml +0, -6
\requirements\control-plane-poc.md +2, -7
\sdlc.js +2, -22
\server\workflow.js +0, -3
\.playwright-cli\page-2026-06-30T16-02-00-502Z.yml +112, -0
```

## Cleanup
- Recorded feature instance PID: `52747`
- Stop signal sent: `no` (left running per explicit instruction not to stop already-running feature instances)
- Final process state: `running`
- Verification server started for this run: `127.0.0.1:53549`, PID `28650`
- Verification server stop: `sent SIGINT`, exited cleanly
- Relevant log: `/Users/alekseypi/projects/feature-plane/.features/remove-agents-section-from-sdlc-yaml/features/remove-agents-section-from-sdlc-yaml/artifacts/environment.log`

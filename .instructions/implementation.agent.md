1. Resolve `CONTROL_PLANE_PROMPT_PATH` with
   `node scripts/control-plane-env.js CONTROL_PLANE_PROMPT_PATH`, then read the
   user request at that path.

   Look into `implementation-plan.md`, if available, and follow the plan.
   Resolve `CONTROL_PLANE_CHANGE_REQUEST_PATH` with
   `node scripts/control-plane-env.js --optional CONTROL_PLANE_CHANGE_REQUEST_PATH`.
   If the returned path is set and readable, read it and address that change
   request in this rerun.
   Modify codebase and smoke test integrity.

2. Use the prepared feature instance from `environment-state.md` when it is
   available. If feature instance is not workin, STOP execution.

3. Resolve `CONTROL_PLANE_ARTIFACT_PATH` with
   `node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_PATH`. Write
   implementation notes to that file. This path may be versioned for reruns;
   use it exactly.

Available Control Plane parameters are exposed as environment variables. Use
`node scripts/control-plane-env.js NAME` to read them by name.

IMPORTANT: never reset branch, clean up the workspace, or modify unrelated
feature artifacts.

Write progress and diagnostic output to stdout or stderr.

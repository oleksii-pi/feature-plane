1. Read the user request at `$CONTROL_PLANE_PROMPT_PATH`.

   Look into `implementation-plan.md`, if available, and follow the plan.
   Modify codebase and smoke test integrity.

2. Use the prepared feature instance from `environment-state.md` when it is
   available. If feature instance is not workin, STOP execution.

3. Write implementation notes to `implementation-details.md` inside `$CONTROL_PLANE_ARTIFACT_PATH`. If there is already such file, add incremental index: implementation-details-v2.md, -v3.md, etc.

Available Control Plane parameters are exposed as environment variables

IMPORTANT: never reset branch, clean up the workspace, or modify unrelated
feature artifacts.

Write progress and diagnostic output to stdout or stderr.

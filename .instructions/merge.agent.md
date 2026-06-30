1. Do not stop any already-running feature instance. Stop only server processes
   you started yourself during this run.
   The committed feature artifact folder inside the workspace is
   `CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER`; resolve it with
   `node scripts/control-plane-env.js CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER`.
   Resolve the absolute artifact folder with
   `node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_FOLDER_PATH`.
   Resolve `CONTROL_PLANE_CHANGE_REQUEST_PATH` with
   `node scripts/control-plane-env.js --optional CONTROL_PLANE_CHANGE_REQUEST_PATH`.
   If the returned path is set and readable, read it and address that change
   request in this rerun.

2. Merge main into the current branch and resolve all possible merge conflicts.
   Check that server can start without errors on a currently free localhost
   port that you choose yourself. Stop only that server when done. If you can not resolve merge conflicts STOP execution.

3. Resolve `CONTROL_PLANE_ARTIFACT_PATH` with
   `node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_PATH`. Write into
   that file what was changed from user perspective of view.

4. Write into that same artifact a detailed list of changed files in this format:
   \folder\some-code.ts +50, -34

5. Commit

6. Merge current branch into main.

7. As part of this agent's run, also clean up the environment by following the instructions in `cleanup-environment.agent.md`.

Available Control Plane parameters are exposed as environment variables. Use
`node scripts/control-plane-env.js NAME` to read them by name.

1. Do not stop any already-running feature instance. Stop only server processes
   you started yourself during this run.
   The committed feature artifact folder inside the workspace is
   `$CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER` (`features/<feature-slug>/artifacts`);
   the absolute path is `$CONTROL_PLANE_ARTIFACT_FOLDER_PATH`.

2. Merge main into the current branch and resolve all possible merge conflicts.
   Check that server can start without errors on a currently free localhost
   port that you choose yourself. Stop only that server when done. If you can not resolve merge conflicts STOP execution.

3. Write into `change-log.md` inside `$CONTROL_PLANE_ARTIFACT_PATH` what was changed from user perspective of view.

4. Write into `change-log.md` detailed list of changed files in this format:
   \folder\some-code.ts +50, -34

5. Commit

6. Merge current branch into main.

7. As part of this agent's run, also clean up the environment by following the instructions in `cleanup-environment.agent.md`.

Available Control Plane parameters are exposed as environment variables.

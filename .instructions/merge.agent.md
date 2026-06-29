1. Do not stop any already-running feature instance. Stop only server processes
   you started yourself during this run.
   The committed feature artifact folder inside the workspace is
   `$CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER` (`features/<feature-slug>/artifacts`);
   the absolute path is `$CONTROL_PLANE_ARTIFACT_FOLDER_PATH`.

2. Merge main into the current branch and resolve all possible merge conflicts.
   Check that server can start without errors on a currently free localhost
   port that you choose yourself. Stop only that server when done.

3. Merge current branch into main.

4. Write into `$CONTROL_PLANE_ARTIFACT_PATH` what was changed from user
   perspective of view.

Available Control Plane parameters are exposed as environment variables.

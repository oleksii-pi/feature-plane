1. Read the user request from the file at `$CONTROL_PLANE_PROMPT_PATH`, then apply it to the codebase.
   The committed feature artifact folder inside the workspace is
   `$CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER` (`features/<feature-slug>/artifacts`);
   the absolute path is `$CONTROL_PLANE_ARTIFACT_FOLDER_PATH`.

2. Use the prepared feature instance from `environment-state.md` when it is
   available. If it is unavailable and you need to run the app, choose a
   currently free localhost port yourself. Keep only the server process you
   started running for testing, and do not stop any already-running feature
   instance.

3. Write implementation notes to `$CONTROL_PLANE_ARTIFACT_PATH`.
   Include the test URL in this format:
   the localhost URL you selected.

Available Control Plane parameters are exposed as environment variables

IMPORTANT: never reset branch, clean up the workspace, or modify unrelated
feature artifacts. Write only to `$CONTROL_PLANE_ARTIFACT_PATH`. If there is
already such file, add incremental index: implementation-details-v2.md, -v3.md,
etc.

Write progress and diagnostic output to stdout or stderr.

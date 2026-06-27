1. Read the user request from the file at `$CONTROL_PLANE_PROMPT_PATH`, then apply it to the codebase.

2. If you need to run the app, choose a currently free localhost port yourself.
   Keep only the server process you started running for testing, and do not stop
   or reuse any already-running feature instance.

3. Write implementation notes to `$CONTROL_PLANE_ARTIFACT_PATH`.
   Include the test URL in this format:
   the localhost URL you selected.

Available Control Plane parameters are exposed as environment variables

IMPORTANT: never reset branch or cleanup or modify feature artifacts folder.
It is only allowed to write to implementation-details.md file. If there is such file, add incremental index: implementation-details-v2.md, -v3.md, etc.

Write progress and diagnostic output to stdout or stderr.

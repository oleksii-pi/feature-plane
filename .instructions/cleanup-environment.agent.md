1. Resolve `CONTROL_PLANE_ARTIFACT_FOLDER_PATH` with
   `node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_FOLDER_PATH`.
   Read environment state from that folder and locate the PID recorded in
   `environment.pid`.
   The committed feature artifact folder inside the workspace is
   `CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER`; resolve it with
   `node scripts/control-plane-env.js CONTROL_PLANE_WORKSPACE_ARTIFACT_FOLDER`.

2. Stop only the recorded feature instance process. Do not stop, reuse, or
   modify any other localhost server or feature instance.

3. Verify that the recorded process is no longer running. If it is already
   stopped, record that as the cleanup result.

   Resolve `CONTROL_PLANE_CHANGE_REQUEST_PATH` with
   `node scripts/control-plane-env.js --optional CONTROL_PLANE_CHANGE_REQUEST_PATH`.
   If the returned path is set and readable, read it and address the requested
   correction while staying within this agent's scope.

4. Resolve `CONTROL_PLANE_ARTIFACT_PATH` with
   `node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_PATH`. Write
   cleanup results to that file.
   Include the PID, whether a stop signal was sent, the final process state,
   and any relevant log path.

Available Control Plane parameters are exposed as environment variables. Use
`node scripts/control-plane-env.js NAME` to read them by name.

IMPORTANT: never reset branches, remove feature artifacts, or clean the
workspace as part of environment cleanup. This agent only stops the prepared
feature instance.

Write progress and diagnostic output to stdout or stderr.

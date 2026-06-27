1. Read environment state from `$CONTROL_PLANE_ARTIFACT_FOLDER_PATH` and locate
   the PID recorded in `environment.pid`.

2. Stop only the recorded feature instance process. Do not stop, reuse, or
   modify any other localhost server or feature instance.

3. Verify that the recorded process is no longer running. If it is already
   stopped, record that as the cleanup result.

4. Write cleanup results to `$CONTROL_PLANE_ARTIFACT_PATH`.
   Include the PID, whether a stop signal was sent, the final process state,
   and any relevant log path.

Available Control Plane parameters are exposed as environment variables.

IMPORTANT: never reset branches, remove feature artifacts, or clean the
workspace as part of environment cleanup. This agent only stops the prepared
feature instance.

Write progress and diagnostic output to stdout or stderr.

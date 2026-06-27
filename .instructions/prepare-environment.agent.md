1. Read the user request from the file at `$CONTROL_PLANE_PROMPT_PATH`.

2. Start the feature workspace application in watch mode from
   `$CONTROL_PLANE_WORKSPACE_PATH` on a currently free localhost port that you
   choose yourself:

   `node --watch --watch-path=server server.js <port>`

   Keep this process running after this agent exits. Do not stop, reuse, or
   modify any already-running feature instance.

3. Store process details under `$CONTROL_PLANE_ARTIFACT_FOLDER_PATH`:
   - write the server PID to `environment.pid`
   - write stdout and stderr to `environment.log`

4. Verify the application responds by loading its `/state` endpoint.

5. Publish the prepared app URL to Control Plane after verification succeeds:

   ```sh
   curl -fsS -X POST "$CONTROL_PLANE_RUN_EVENT_URL" \
     -H 'Content-Type: application/json' \
     -d "{\"type\":\"environment\",\"url\":\"<localhost-url>\"}"
   ```

   If the callback cannot be used, write this exact fallback line to stdout:

   `CONTROL_PLANE_ENVIRONMENT_URL=<localhost-url>`

6. Write environment state to `$CONTROL_PLANE_ARTIFACT_PATH`.
   Include the localhost URL, selected port, PID, log path, workspace path, and
   verification result.

Available Control Plane parameters are exposed as environment variables.

IMPORTANT: only stop the process if startup fails before you write the
environment state. Leave a successfully started feature instance running for
subsequent agent executions and user testing.

Write progress and diagnostic output to stdout or stderr.

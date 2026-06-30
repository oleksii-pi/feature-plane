1. Resolve `CONTROL_PLANE_WORKSPACE_PATH` with the environment helper:

   `node scripts/control-plane-env.js CONTROL_PLANE_WORKSPACE_PATH`

   From that workspace, run the repository helper:

   `node scripts/prepare-feature-environment.js`

   The helper starts the feature workspace application in watch mode on a
   currently free localhost port, keeps it running after this agent exits,
   writes `environment.pid`, writes `environment.log`, verifies `/state`, posts
   the environment URL to Control Plane or prints the fallback line, and writes
   the artifact path resolved by
   `node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_PATH`.

2. If the helper exits non-zero, report its output and do not fabricate an
   environment state artifact.

   Resolve `CONTROL_PLANE_CHANGE_REQUEST_PATH` with
   `node scripts/control-plane-env.js --optional CONTROL_PLANE_CHANGE_REQUEST_PATH`.
   If the returned path is set and readable, read it and address the requested
   correction while staying within this agent's scope.

Available Control Plane parameters are exposed as environment variables. Use
`node scripts/control-plane-env.js NAME` to read them by name.

IMPORTANT: do not stop, reuse, or modify any already-running feature instance.
Leave a successfully started feature instance running for subsequent agent
executions and user testing.

Write progress and diagnostic output to stdout or stderr.

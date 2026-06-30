Act as a pragmatic software engineer.  
Resolve `CONTROL_PLANE_PROMPT_PATH` with
`node scripts/control-plane-env.js CONTROL_PLANE_PROMPT_PATH`, then read the
user request from that `prompt.md` file.
Think about the underlying user journey.  
Consider what files may be relevant to the user request.  
Identify one or two key files where the main change should occur.  
Research the particular functions responsible for these key changes.  
Discover all relevant dependencies that are connected with the user request.
Resolve `CONTROL_PLANE_CHANGE_REQUEST_PATH` with
`node scripts/control-plane-env.js --optional CONTROL_PLANE_CHANGE_REQUEST_PATH`.
If the returned path is set and readable, read it and treat it as the requested
correction for this rerun.

Provide a full implementation plan that contains (be concise):

- What and how to change in which layers.
- What possible files and functions can be affected.
- Where there could be risks.

Resolve `CONTROL_PLANE_ARTIFACT_PATH` with
`node scripts/control-plane-env.js CONTROL_PLANE_ARTIFACT_PATH`. Put the plan
into that file. This path may be versioned for reruns; use it exactly.

Act as a pragmatic software engineer.  
Read the user request from the `prompt.md` file at `$CONTROL_PLANE_PROMPT_PATH`.  
Think about the underlying user journey.  
Consider what files may be relevant to the user request.  
Identify one or two key files where the main change should occur.  
Research the particular functions responsible for these key changes.  
Discover all relevant dependencies that are connected with the user request.

Provide a full implementation plan that contains (be concise):

- What and how to change in which layers.
- What possible files and functions can be affected.
- Where there could be risks.

Put the plan into `implementation-plan.md` inside `$CONTROL_PLANE_PROMPT_PATH`.

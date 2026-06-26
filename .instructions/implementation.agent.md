1. Look into user %artifact_folder_path%/prompt.md and apply user request to the codebase.

2. Try to run server on application port that is located in feature.json
   Keep server app and running.

3. Write into implementation-details.md what exactly was executed
   By the end of the file put url to feature for testing in format: http://localhost:app_port

IMPORTANT: never reset branch or cleanup or modify feature artifacts folder.
It is only allowed to write to implementation-details.md file. If there is such file, add incremental index: implementation-details-v2.md, -v3.md, etc.
Write progress and diagnostic output to stdout or stderr. Control Plane captures that output in its own per-run log file.

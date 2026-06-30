# Control Plane PoC

## Purpose

Control Plane is a local app for managing long-lived LLM development tasks in
parallel.

The PoC should prove that a user can create several feature requests, let agents
work on them independently over time, inspect progress and artifacts, cancel or
retry work, and move each feature through a simple repository-defined workflow.

The PoC intentionally does not require Docker. Parallelism is handled with local
workspaces, preferably Git worktrees.

## Core Idea

A feature is a long-lived task.

Each feature has:

- A title and prompt
- A Git branch
- A local workspace
- A current workflow step
- Generated artifacts
- Run history and logs
- Optional active agent process

Multiple features may exist at the same time. Multiple agent runs may execute in
parallel as long as each run has its own workspace.

## Non-Goals

- Docker-based isolation
- Production security boundaries
- Durable database storage
- Distributed workers
- Multi-repository orchestration
- Fully reliable recovery of active runs after backend restart
- Writing tests for this PoC

## Runtime Model

Control Plane runs as a local Node.js backend plus the existing browser UI.

The backend:

- Reads local configuration from `.env`.
- Reads the target repository workflow from `SDLC.yaml`.
- Creates feature branches and local workspaces.
- Starts agent commands as child processes.
- Streams process output and status events to the UI.
- Records task state in memory and browser `localStorage`.

The browser:

- Stores feature state in `localStorage`.
- Shows the list of long-lived tasks.
- Shows each task's workflow position, artifacts, logs, and active run state.
- Supports JSON import and export for debugging.

No database is required.

## Local Workspaces

Control Plane should use one local workspace per active feature. The preferred
implementation is `git worktree`:

```text
.control-plane/
  worktrees/
    feature-faster-pipelines/
    feature-improve-login/
```

A workspace is assigned to one feature branch. An active agent run owns that
workspace until it finishes, fails, or is cancelled.

Before creating a feature branch, Control Plane prepares the workspace from the
latest `main`:

```sh
git fetch origin main
git reset --hard
git clean -fd
git checkout main
git pull --ff-only origin main
git checkout -b <feature-branch>
```

For this PoC, hard isolation is not required. The only required safety property
is that two active runs do not write to the same workspace at the same time.

## Runtime Configuration

Control Plane reads `.env` from the Control Plane repository root:

```env
target_repository_path=/absolute/path/to/repository
default_branch=main
workspace_root=.control-plane/worktrees
setup_command=pnpm run setup
llm_model_name=gpt-5.4-mini
llm_credentials=<secret key>
git=https://github.com/OWNER/REPOSITORY.git
git_access_token=...
```

`target_repository_path` is the main input for the PoC. It points to the local
repository that Control Plane manages.

`git` and `git_access_token` are optional for local demos. When present, Control
Plane may use them for clone, pull, and push operations. Secrets must not be
written to feature artifacts, logs, browser state, exported JSON, or prompts.

`setup_command` is optional. If configured, it is run when preparing a new
workspace. It must be non-interactive and should not require shell operators.

`agent_run_command` is optional. If configured, Control Plane launches it as a
child process inside the feature workspace and expands placeholders before
execution. Supported placeholders include `%instruction_path%`,
`%prompt_path%`, `%artifact_path%`, `%artifact_folder%`,
`%artifact_folder_path%`, `%context_folder%`, `%context_folder_path%`,
`%branch%`, `%workspace%`, `%agent%`, `%artifact%`, `%state%`,
`%feature_name%`, and `%feature_id%`. Placeholder values are shell-escaped
automatically, so use them as bare tokens rather than wrapping them in extra
quotes.

## Target Repository Contract

The target repository must contain:

```text
SDLC.yaml
.instructions/
  <agent-name>.agent.md
feature/
.gitignore
```

`feature/` may be created by Control Plane when the first feature is created.
Each feature has an artifact/context folder whose path matches the feature
branch name, for example branch `feature/verification-improvement` uses
`feature/verification-improvement/`.

The target repository's `.gitignore` must ignore generated logs:

```gitignore
feature/**/*.log
```

## Workflow Definition

`SDLC.yaml` defines the workflow:

```yaml
sdlc:
  workflow:
    - state: Draft
      artifact: prompt.md
    - state: "@acceptance criteria"
      agent: acceptance-criteria
      artifact: acceptance-criteria.md
    - state: Review acceptance criteria
    - state: Ready for development
    - state: "@implementation plan"
      agent: implementation-plan
      artifact: implementation-plan.md
    - state: Review implementation plan
    - state: Ready for implementation
    - state: "@implementation"
      agent: implementation
      artifact: implementation-details.md
    - state: Review implementation
    - state: Done
```

Rules:

- Workflow states are ordered.
- States beginning with `@` are agent states.
- Other states are human states.
- Every agent referenced by a workflow state must have `.instructions/<agent-name>.agent.md`.
- `artifact`, when present, is the Markdown file required for that step.
- The first state must produce `prompt.md`.

## Feature Creation

When a user creates a feature, Control Plane:

1. Generates a URL-safe slug from the title.
2. Creates branch `feature/<slug>`.
3. Creates artifact/context folder `feature/<slug>/` inside the target repository.
4. Writes `feature/<slug>/prompt.md`.
5. Commits the prompt with Git identity `agent <agent@control-plane.local>`.
6. Adds the feature to browser state.

If the branch already exists, Control Plane appends `_v2`, `_v3`, and so on.

## Agent Runs

When a feature enters an agent state, Control Plane:

1. Creates a run with status `queued`.
2. Assigns a free local workspace.
3. Starts the configured agent command as a child process.
4. Changes the displayed state to `Agent Run: <agent name>`.
5. Streams the minimal structured lifecycle events to the UI.
6. Appends the same lifecycle events to the run log.
7. Verifies that the required artifact exists.
8. Commits intended changes if needed.
9. Pushes the branch when Git publishing is configured.
10. Moves the feature to the next workflow state on success.

On failure, the feature stays on the agent state and can be retried.

## Agent Contract

Control Plane invokes repository-defined agents with:

```sh
pnpm run agent branch=feature/faster-pipelines name=implementation
```

The command runs inside the assigned local workspace.

The agent receives enough context to know:

- Feature branch
- Feature workspace path
- Feature artifact/context folder path
- Current workflow state
- Required artifact
- Agent instructions from `.instructions/<agent-name>.agent.md`
- Initial feature request from `prompt.md`

The agent may modify files in the workspace. If it needs to run the app, it
must choose a currently free port and leave any already-running feature
instance intact. To succeed, it must create the required artifact and exit
successfully.

Run logs contain only the structured lifecycle events:

```jsonl
{"timestamp":"2026-06-23T10:15:00Z","run_id":"123","level":"info","status":"Started","message":"implementation started."}
{"timestamp":"2026-06-23T10:15:01Z","run_id":"123","level":"info","status":"Executing","message":"Agent executing."}
{"timestamp":"2026-06-23T10:17:12Z","run_id":"123","level":"info","status":"Validating","message":"Validating required artifact."}
{"timestamp":"2026-06-23T10:17:13Z","run_id":"123","level":"info","status":"Done","message":"Done."}
```

Useful statuses are `Started`, `Executing`, `Validating`, `Done`, and `Failed`.

## Cancellation

A user can cancel an active run.

Cancellation:

- Terminates the agent process and child processes.
- Marks the run as `cancelled`.
- Leaves the feature on the current agent state.
- Keeps logs for inspection.
- Releases the workspace for cleanup or retry.

Cancellation does not push uncommitted work.

## UI Requirements

The UI should make parallel long-running work easy to scan.

The feature list shows (Left panel):

- Feature title
- Current workflow state (3px height progress bar: blue if the agent is working, green if it requires human intervention)
- Whether a run is active
- Last run status
- Latest cost, if known

The feature detail view shows (Right panel):

- Workflow timeline
- Artifacts in workflow order
- Current run progress
- Live log/status stream
- Actions to move forward, retry, cancel, or go back

The app menu includes (bottom right):

- Repository workflow view
- Repository validation
- Export state to clipboard
- Import state from clipboard

## Minimal API

All request and response bodies use JSON except the run event stream.

```http
POST   /features
GET    /features
GET    /features/{id}
PATCH  /features/{id}

GET    /features/{id}/steps
PATCH  /features/{id}/steps/{step}

POST   /features/{id}/runs
GET    /features/{id}/runs
GET    /runs/{id}
GET    /runs/{id}/events
POST   /runs/{id}/cancel

GET    /workspaces
POST   /workspaces/{id}/cleanup
```

Run status is one of `queued`, `running`, `succeeded`, `failed`, or
`cancelled`.

`GET /runs/{id}/events` is a Server-Sent Events stream. It sends existing
events first, then follows new events until the run reaches a terminal status.

Use:

- `400` for malformed input
- `404` for unknown resources
- `409` for invalid workflow transitions or already-active runs
- `422` for invalid repository configuration

## Success Criteria

The PoC is successful when a user can:

- Create multiple feature tasks.
- See all tasks and their current states.
- Run at least two agent tasks in parallel using separate local workspaces.
- Watch live progress for each running task.
- Cancel a running task.
- Retry a failed or cancelled task.
- Review generated artifacts.
- Move a feature through human and agent workflow states.
- Export and import browser state for debugging.

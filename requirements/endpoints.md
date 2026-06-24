# Control Plane Endpoints

This document explains the minimal API surface from `control-plane-poc.md` and the purpose of each endpoint.

## `POST /features`

Creates a new long-lived feature task.

Expected payload:

```json
{
  "title": "Improve login flow",
  "prompt": "Make the login flow faster and clearer."
}
```

Why it should exist:

- This is the entry point for creating a feature task.
- It must create the branch, workspace, initial prompt artifact, and in-memory/browser state.
- It gives the UI a single action for starting work.

## `GET /features`

Lists all features.

Expected payload:

- No request body.

Expected response:

```json
[
  {
    "id": "feature-123",
    "title": "Improve login flow",
    "currentStep": "Review implementation plan",
    "activeRun": false,
    "lastRunStatus": "succeeded",
    "latestCost": 1.24
  }
]
```

Why it should exist:

- The UI needs a fast summary view for the left panel.
- It lets users scan all active and completed tasks without loading full details.

## `GET /features/{id}`

Returns full details for one feature.

Expected payload:

- No request body.

Expected response:

```json
{
  "id": "feature-123",
  "title": "Improve login flow",
  "branch": "feature/improve-login-flow",
  "workspace": ".control-plane/worktrees/feature/improve-login-flow",
  "currentStep": "Review implementation plan",
  "artifacts": [],
  "runs": []
}
```

Why it should exist:

- The right panel needs a detailed read model for one feature.
- It should show workflow position, artifacts, logs, and active run state.

## `PATCH /features/{id}`

Updates editable feature metadata.

Expected payload:

```json
{
  "title": "Improve login flow"
}
```

Why it should exist:

- Users may need to correct the feature title.
- Keeping metadata updates separate from workflow transitions avoids accidental state changes.

## `GET /features/{id}/steps`

Returns the workflow steps for one feature.

Expected payload:

- No request body.

Expected response:

```json
{
  "currentStep": "Review implementation plan",
  "steps": [
    { "state": "Draft", "artifact": "prompt.md" },
    { "state": "@acceptance criteria", "agent": "acceptance-criteria", "artifact": "acceptance-criteria.md" },
    { "state": "Review acceptance criteria" }
  ]
}
```

Why it should exist:

- The UI needs to render the workflow timeline.
- The backend needs one place to validate allowed transitions.

## `PATCH /features/{id}/steps/{step}`

Moves a feature through the workflow or confirms a step transition.

Expected payload:

```json
{
  "action": "advance"
}
```

Why it should exist:

- Human workflow states need an explicit transition endpoint.
- Agent states and review states should be controlled by the repository-defined workflow.
- This endpoint is where invalid transitions should be rejected with `409`.

## `POST /features/{id}/runs`

Starts a new run for the feature.

Expected payload:

```json
{
  "retryOf": "run-456"
}
```

Why it should exist:

- Agent work is a separate lifecycle from feature metadata.
- This endpoint supports fresh runs and retries after failure or cancellation.
- It enables parallel execution as long as workspaces do not overlap.

## `GET /features/{id}/runs`

Lists the run history for a feature.

Expected payload:

- No request body.

Expected response:

```json
[
  {
    "id": "run-456",
    "status": "failed",
    "agent": "implementation",
    "startedAt": "2026-06-23T10:15:00Z"
  }
]
```

Why it should exist:

- Users need to inspect retry history and understand what happened over time.
- It supports debugging failed or cancelled work.

## `GET /runs/{id}`

Returns details for one run.

Expected payload:

- No request body.

Expected response:

```json
{
  "id": "run-456",
  "status": "running",
  "workspaceId": "workspace-1",
  "featureId": "feature-123",
  "agent": "implementation"
}
```

Why it should exist:

- The UI needs one canonical run detail view.
- It is the safest way to inspect state without reading process internals directly.

## `GET /runs/{id}/events`

Streams live run events.

Expected payload:

- No JSON body.
- Server-Sent Events stream.

Example event:

```json
{"timestamp":"2026-06-23T10:15:00Z","run_id":"run-456","level":"info","status":"Starting","message":"Agent run started"}
```

Why it should exist:

- The UI needs live progress updates while a run is executing.
- It carries stdout, stderr, and structured status events in real time.
- It should replay historical events first, then continue streaming new ones.

## `POST /runs/{id}/cancel`

Cancels an active run.

Expected payload:

```json
{
  "reason": "User requested stop"
}
```

Why it should exist:

- Long-running tasks must be stoppable.
- Cancellation should terminate the process, mark the run cancelled, and free the workspace.

## `GET /workspaces`

Lists known workspaces.

Expected payload:

- No request body.

Expected response:

```json
[
  {
    "id": "workspace-1",
    "path": ".control-plane/worktrees/feature/improve-login-flow",
    "activeRunId": "run-456",
    "status": "busy"
  }
]
```

Why it should exist:

- The system needs visibility into workspace ownership.
- It helps enforce the one-active-run-per-workspace safety rule.

## `POST /workspaces/{id}/cleanup`

Cleans up a workspace.

Expected payload:

```json
{
  "force": false
}
```

Why it should exist:

- Failed or cancelled runs may leave stale workspaces behind.
- Cleanup helps reclaim local resources and prepare for retry.

## Status and Errors

Run status values:

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

Error codes:

- `400` for malformed input
- `404` for unknown resources
- `409` for invalid workflow transitions or already-active runs
- `422` for invalid repository configuration

# AGENTS.md

## Project Shape

Feature Plane is a local Control Plane PoC for managing long-lived feature work.
It is intentionally small: a plain Node.js HTTP server serves a browser UI and
keeps feature state on disk under the configured feature home.

- Server entry point: `server.js`
- Server modules: `server/` using CommonJS
- Browser modules: `app/` using native ES modules
- UI shell: `index.html`, `styles.css`
- Workflow config: `SDLC.yaml`
- Agent prompts: `.instructions/<agent>.agent.md`
- Generated feature state, workspaces, artifacts, and run logs: `.features/` by default

## Run

```sh
node server.js 3000
```

The port can also come from `PORT`, `port`, or `sdlc.app_port`; CLI argument
wins. For development with server reloads:

```sh
node --watch --watch-path=server server.js 3000
```

No package manager, build step, bundler, or test command is currently required.

## Configuration

The server loads `.env` from the repo root before reading `SDLC.yaml`.

Useful variables:

- `features_home`: relative folder for persisted app data. `.env.example` uses
  `.features`, which is ignored by git; the code fallback is `feature`.
- `agent_run_command`: optional shell command for real agent execution. If it is
  unset, runs are simulated.
- `PORT` or `port`: server port fallback.

`agent_run_command` supports placeholders from `server/agent-command.js`, such
as `%instruction_path%`, `%prompt_path%`, `%artifact_path%`,
`%artifact_folder_path%`, `%workspace_path%`, `%branch%`, `%agent%`,
`%artifact%`, `%state%`, `%feature_name%`, `%feature_id%`, and `%app_port%`.
Placeholders are shell-escaped by the app, so pass them as bare tokens.

Use `codex exec ...` for configured Codex runs. Plain interactive `codex` is
rejected because workflow runs do not have a TTY.

## Current Behavior

- Creating a feature writes `prompt.md`, records metadata, assigns an app port,
  and copies the current repo into a per-feature workspace.
- Feature branches are represented as `feature/<slug>`, but this PoC does not
  currently create git branches or git worktrees.
- Feature state is persisted as JSON in the feature home and mirrored into
  per-feature `feature.json` files.
- Agent steps are defined in `SDLC.yaml`; every configured agent must have a
  matching `.instructions/<agent>.agent.md` file.
- A successful configured run must create the Markdown artifact required by the
  current workflow step.
- Run logs are plain text under the feature home's `run-logs/` directory.

## API Surface

Keep route changes aligned with `server/router.js`. The active endpoints are:

- `GET /state`, `PUT /state`
- `GET /repository/validation`
- `GET /workspaces`, `POST /workspaces/:id/cleanup`
- `GET /features`, `POST /features`
- `GET /features/:id`, `PATCH /features/:id`, `DELETE /features/:id`
- `GET /features/:id/steps`, `PATCH /features/:id/steps/:step`
- `PATCH /features/:id/artifacts/:index`
- `GET /features/:id/runs`, `POST /features/:id/runs`
- `GET /runs/:id`, `GET /runs/:id/events`, `GET /runs/:id/log`
- `POST /runs/:id/cancel`

## Coding Guidelines

- Preserve the no-dependency, plain Node/browser architecture unless the task
  explicitly justifies changing it.
- Keep server code in CommonJS and browser code in ES modules.
- Prefer small modules that match the existing boundaries: routing, state,
  features, runs, validation, static serving, and UI rendering/events.
- Treat `.features/`, `feature/`, run logs, and `.env` as generated or local
  data. Do not commit secrets or generated run output.
- When editing workflow behavior, update `SDLC.yaml`, validation, run handling,
  and UI state assumptions together.
- Do not reintroduce a `requirements/` folder for durable project guidance; keep
  durable instructions here and implementation detail in code.

#!/usr/bin/env bash
set -eu

# Control Plane integration:
#   agent_run_command=./scripts/codex-feature-agent.sh
#
# Required user setup:
#   ~/.codex/feature-isolated.config.toml must define a profile whose only
#   writable workspace root is "." and whose project_root_markers is [].
#
# Limitations:
#   - This script does not sandbox Control Plane itself; it only launches the
#     nested Codex run with the isolated profile.
#   - Feature workspaces contain their own copied scripts. Use an absolute path
#     to a trusted launcher if a feature must not be able to edit its launcher.
#   - Agents lose automatic repo-root config/AGENTS.md discovery by design.

: "${CONTROL_PLANE_WORKSPACE_PATH:?missing CONTROL_PLANE_WORKSPACE_PATH}"
: "${CONTROL_PLANE_INSTRUCTION_PATH:?missing CONTROL_PLANE_INSTRUCTION_PATH}"

profile="${CODEX_FEATURE_PROFILE:-feature-isolated}"

workspace="$(cd "$CONTROL_PLANE_WORKSPACE_PATH" && pwd -P)"
cwd="$(pwd -P)"
if [ "$cwd" != "$workspace" ]; then
  echo "Refusing to run outside feature workspace: $workspace" >&2
  exit 2
fi

instruction_dir="$(cd "$(dirname "$CONTROL_PLANE_INSTRUCTION_PATH")" && pwd -P)"
instruction_path="$instruction_dir/$(basename "$CONTROL_PLANE_INSTRUCTION_PATH")"
case "$instruction_path" in
  "$workspace"/*) ;;
  *)
    echo "Refusing to read instructions outside feature workspace: $instruction_path" >&2
    exit 2
    ;;
esac

approval_policy="${CODEX_FEATURE_APPROVAL_POLICY:-never}"

args=(
  codex exec
  --yolo
  --profile "$profile"
  --cd "$workspace"
  --config "approval_policy=\"$approval_policy\""
)
if [ -n "${CODEX_MODEL:-}" ]; then
  args+=(--model "$CODEX_MODEL")
fi

exec "${args[@]}" "$(< "$instruction_path")"

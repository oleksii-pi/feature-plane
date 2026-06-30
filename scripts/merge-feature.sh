#!/usr/bin/env bash
set -euo pipefail

: "${CONTROL_PLANE_WORKSPACE_PATH:?missing CONTROL_PLANE_WORKSPACE_PATH}"
: "${CONTROL_PLANE_ARTIFACT_PATH:?missing CONTROL_PLANE_ARTIFACT_PATH}"

workspace="$(cd "$CONTROL_PLANE_WORKSPACE_PATH" && pwd -P)"
case "$CONTROL_PLANE_ARTIFACT_PATH" in
  /*) artifact_path="$CONTROL_PLANE_ARTIFACT_PATH" ;;
  *) artifact_path="$workspace/$CONTROL_PLANE_ARTIFACT_PATH" ;;
esac
artifact_dir="$(dirname "$artifact_path")"
main_branch="${CONTROL_PLANE_DEFAULT_BRANCH:-${default_branch:-main}}"

cd "$workspace"

run_quiet() {
  local output
  if ! output="$("$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

git_quiet() {
  run_quiet git "$@"
}

ensure_clean_worktree() {
  local status
  status="$(git status --porcelain)"
  if [ -n "$status" ]; then
    printf 'Working tree has uncommitted changes before merge:\n%s\n' "$status" >&2
    exit 1
  fi
}

branch_exists() {
  git show-ref --verify --quiet "refs/heads/$1"
}

ensure_main_branch() {
  if branch_exists "$main_branch"; then
    return
  fi

  local root_commit
  root_commit="$(git rev-list --max-parents=0 "$branch" | tail -n 1)"
  if [ -z "$root_commit" ]; then
    echo "Could not find root commit for $branch." >&2
    exit 1
  fi
  git_quiet branch "$main_branch" "$root_commit"
}

stop_feature_environment() {
  local pid_file pid index
  pid_file="$artifact_dir/environment.pid"
  if [ ! -r "$pid_file" ]; then
    return
  fi

  pid="$(head -n 1 "$pid_file" | tr -d '[:space:]')"
  if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    return
  fi

  kill "$pid" 2>/dev/null || true
  for index in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return
    fi
    sleep 0.2
  done

  kill -KILL "$pid" 2>/dev/null || true
}

render_artifact() {
  local commits numstat add_count delete_count file display_path

  commits="$(git log --no-merges --format='- %s' "$main_branch..$branch" || true)"
  numstat="$(git diff --numstat "$main_branch...$branch" || true)"

  {
    echo "## Change Log"
    echo
    echo "Merged $branch into $main_branch."
    echo
    echo "### User-visible changes"
    if [ -n "$commits" ]; then
      printf '%s\n' "$commits"
    else
      echo "- No user-visible changes were detected."
    fi
    echo
    echo "### Changed files"
    if [ -n "$numstat" ]; then
      while IFS=$'\t' read -r add_count delete_count file; do
        [ -n "$file" ] || continue
        display_path="${file//\//\\}"
        if [ "$add_count" = "-" ] || [ "$delete_count" = "-" ]; then
          printf '\\%s binary\n' "$display_path"
        else
          printf '\\%s +%s, -%s\n' "$display_path" "$add_count" "$delete_count"
        fi
      done <<< "$numstat"
    else
      echo "- No changed files were detected."
    fi
  } > "$artifact_path"
}

commit_branch_changes() {
  git_quiet add -A
  if [ -z "$(git status --porcelain)" ]; then
    return
  fi
  git_quiet \
    -c user.name="Control Plane" \
    -c user.email="control-plane@local.invalid" \
    commit -m "Run merge: $(basename "$artifact_path")"
}

branch="${CONTROL_PLANE_BRANCH:-}"
if [ -z "$branch" ]; then
  branch="$(git symbolic-ref --quiet --short HEAD || true)"
fi
if [ -z "$branch" ]; then
  echo "CONTROL_PLANE_BRANCH is required when HEAD is detached." >&2
  exit 1
fi
if [ "$branch" = "$main_branch" ]; then
  echo "Feature branch and main branch are both $branch." >&2
  exit 1
fi

mkdir -p "$artifact_dir"
git_quiet checkout "$branch"
ensure_clean_worktree
ensure_main_branch
git_quiet merge --no-edit "$main_branch"
printf 'successfully merged change from main to branch %s\n' "$branch"

stop_feature_environment
render_artifact
commit_branch_changes

git_quiet checkout "$main_branch"
git_quiet merge --no-edit "$branch"
echo "successfully merged branch to main"
echo "done"

#!/usr/bin/env bash
set -euo pipefail

: "${CONTROL_PLANE_WORKSPACE_PATH:?missing CONTROL_PLANE_WORKSPACE_PATH}"
: "${CONTROL_PLANE_ARTIFACT_PATH:?missing CONTROL_PLANE_ARTIFACT_PATH}"
: "${CONTROL_PLANE_REPOSITORY_ROOT:?missing CONTROL_PLANE_REPOSITORY_ROOT}"

workspace="$(cd "$CONTROL_PLANE_WORKSPACE_PATH" && pwd -P)"
repository_root="$(cd "$CONTROL_PLANE_REPOSITORY_ROOT" && pwd -P)"
case "$CONTROL_PLANE_ARTIFACT_PATH" in
  /*) artifact_path="$CONTROL_PLANE_ARTIFACT_PATH" ;;
  *) artifact_path="$workspace/$CONTROL_PLANE_ARTIFACT_PATH" ;;
esac
artifact_dir="$(dirname "$artifact_path")"
main_branch="${CONTROL_PLANE_DEFAULT_BRANCH:-${default_branch:-main}}"
patch_path="$(mktemp "${TMPDIR:-/tmp}/control-plane-merge.XXXXXX.patch")"
trap 'rm -f "$patch_path"' EXIT

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

root_branch_exists() {
  git -C "$repository_root" show-ref --verify --quiet "refs/heads/$1"
}

ensure_root_repository() {
  if ! git -C "$repository_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Repository root is not a git repository: $repository_root" >&2
    exit 1
  fi
  if ! root_branch_exists "$main_branch"; then
    echo "Repository root does not have branch $main_branch." >&2
    exit 1
  fi
}

ensure_clean_root_worktree() {
  local status
  status="$(git -C "$repository_root" status --porcelain)"
  if [ -n "$status" ]; then
    printf 'Repository root has uncommitted changes before merge:\n%s\n' "$status" >&2
    exit 1
  fi
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

ensure_branch_has_pending_changes() {
  local commits numstat

  if git merge-base --is-ancestor "$branch" "$main_branch"; then
    cat >&2 <<EOF
Feature branch $branch is already contained in $main_branch.
There are no pending branch changes to merge into $main_branch.
EOF
    exit 1
  fi

  commits="$(git log --no-merges --format='%H' "$main_branch..$branch" || true)"
  numstat="$(git diff --numstat "$main_branch...$branch" || true)"
  if [ -z "$commits" ] && [ -z "$numstat" ]; then
    cat >&2 <<EOF
Feature branch $branch has no detectable changes relative to $main_branch.
Refusing to write an empty merge change log.
EOF
    exit 1
  fi
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

write_merge_patch() {
  git diff --binary "$main_branch...$branch" > "$patch_path"
  if [ ! -s "$patch_path" ]; then
    echo "Feature branch produced an empty repository merge patch." >&2
    exit 1
  fi
}

commit_repository_merge() {
  git_quiet checkout "$branch"
  write_merge_patch
  ensure_root_repository
  ensure_clean_root_worktree

  git_quiet -C "$repository_root" checkout "$main_branch"
  ensure_clean_root_worktree

  if ! git -C "$repository_root" apply --check "$patch_path"; then
    cat >&2 <<EOF
Feature branch changes could not be applied to $repository_root on $main_branch.
Resolve the repository root state manually, then rerun the merge.
EOF
    exit 1
  fi

  git_quiet -C "$repository_root" apply --index "$patch_path"
  if [ -z "$(git -C "$repository_root" status --porcelain)" ]; then
    echo "Feature branch changes produced no root repository changes." >&2
    exit 1
  fi

  git_quiet \
    -C "$repository_root" \
    -c user.name="Control Plane" \
    -c user.email="control-plane@local.invalid" \
    commit -m "Merge $branch"
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
ensure_root_repository
ensure_clean_root_worktree
ensure_main_branch
ensure_branch_has_pending_changes
git_quiet merge --no-edit "$main_branch"
printf 'successfully merged change from main to branch %s\n' "$branch"
ensure_branch_has_pending_changes

stop_feature_environment
render_artifact
commit_branch_changes
commit_repository_merge

git_quiet checkout "$main_branch"
git_quiet merge --no-edit "$branch"
echo "successfully merged branch to repository $main_branch"
echo "done"

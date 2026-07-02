Run the environment helper and do not perform any other setup, server start, or
cleanup work yourself:

```sh
node "$CONTROL_PLANE_REPOSITORY_ROOT/scripts/prepare-feature-environment.js"
```

If the helper exits non-zero, report its output and stop. The helper starts the
feature workspace by rebasing the feature branch onto a fresh `main` snapshot
with `main` favored on conflicts, starts the application, verifies it, writes
the required artifact, and prints only the environment result lines on success.

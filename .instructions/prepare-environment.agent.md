Run the environment helper and do not perform any other setup, server start, or
cleanup work yourself:

```sh
node scripts/prepare-feature-environment.js
```

If the helper exits non-zero, report its output and stop. The helper starts the
feature workspace application, verifies it, writes the required artifact, and
prints only the environment result lines on success.

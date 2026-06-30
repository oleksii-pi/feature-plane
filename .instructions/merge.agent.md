Run the merge helper and do not perform any other merge, commit, checkout, or
cleanup work yourself:

```sh
./scripts/merge-feature.sh
```

If the helper exits non-zero, report its output and stop. The helper writes the
required artifact, commits the branch, merges the branch to main, cleans up the
recorded feature environment, and prints only the merge result lines on success.

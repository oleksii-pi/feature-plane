Run the merge helper first:

```sh
./scripts/merge-feature.sh
```

The helper writes the required artifact, commits the branch, merges the branch
to main, cleans up the recorded feature environment, and prints only the merge
result lines on success.

If the helper exits because merging `main` into the feature branch produced
conflicts, inspect the conflict markers and resolve the conflicts only when the
correct resolution is clear from the local code and the feature intent. After
resolving, stage the resolved files, complete the in-progress merge with the
default merge message, and rerun `./scripts/merge-feature.sh`. Do not hand-write
the change log or perform the final branch-to-main merge yourself.

If the helper exits for any other reason, or if a conflict resolution is not
clear, report its output and stop.

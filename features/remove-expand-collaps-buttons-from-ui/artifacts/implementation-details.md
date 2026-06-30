# Implementation Notes

- Removed the small chevron buttons from artifact cards and run log cards.
- Kept expand/collapse behavior on the full header area, including the title button.
- Added persisted UI state for card expansion in local storage under `timelineCardExpansion`.
- Used stable keys for persistence:
  - artifacts: `featureId::artifactName`
  - runs: `run:<runId>`
- Edit mode still forces an artifact card open for editing, but it does not overwrite the user's saved collapsed state.

## Smoke Checks

- Loaded the browser modules under a stubbed DOM: `browser module smoke ok`
- Verified the running local server responds with `HTTP/1.1 200 OK` at `http://127.0.0.1:3112`

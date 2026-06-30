# Implementation Details

## Feature list keyboard behavior

- Added panel-scoped arrow-key handling in `app/events.js` so focus inside the feature list panel, including the search input, can drive feature selection.
- `ArrowUp` and `ArrowDown` now move the selected feature through the filtered visible feature list.
- `Meta+ArrowUp` and `Meta+ArrowDown` now reorder the selected feature in the underlying feature array and persist the new order through the existing `PUT /state` endpoint.
- The selected feature is scrolled back into view after either navigation or reorder.

## Persistence

- Feature ordering still lives in `state.features`.
- Reorder operations rewrite the full feature array through `/state`, so list order survives reloads and matches exported/imported application state.

## Verification

- Syntax-checked the touched browser and server modules.
- Ran a browser smoke test against the live Control Plane instance.
- Smoke coverage:
  - created a temporary 3-item feature list,
  - verified plain `ArrowDown` changed the selected feature while focus stayed in the search input,
  - verified `Meta+ArrowDown` moved the selected feature down one position,
  - verified the reordered list persisted after reload,
  - cleaned up the temporary smoke features afterward.


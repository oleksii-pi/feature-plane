const { formatDateTime } = require("./time");

function archiveFeatureRuns(feature, runs, reason) {
  const candidates = (runs ?? []).filter(Boolean);
  if (!candidates.length) return 0;

  const existingIds = new Set(
    (feature.archivedRuns ?? []).map((run) => String(run?.id ?? "")),
  );
  const archivedAt = formatDateTime();
  const archived = candidates
    .filter((run) => run.id && !existingIds.has(String(run.id)))
    .map((run) => {
      const { fileBaseline, ...publicRun } = run;
      return {
        ...publicRun,
        archivedAt,
        archiveReason: reason,
      };
    });

  if (!archived.length) return 0;
  feature.archivedRuns = [...(feature.archivedRuns ?? []), ...archived].slice(
    -200,
  );
  return archived.length;
}

module.exports = {
  archiveFeatureRuns,
};

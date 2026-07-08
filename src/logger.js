function fmtPct(value) {
  return value == null ? "n/a" : `${value}%`;
}

function fmtRegions(regions) {
  return regions.length ? regions.join(", ") : "(none)";
}

function fmtChanges(changes) {
  return changes.map((c) => `  - ${c.label} [${c.region}] ${c.from} -> ${c.to}`).join("\n");
}

const PRETTY_FORMATTERS = {
  startup: (f) =>
    `Autoscaler started | project=${f.projectId} environment=${f.environmentId} ` +
    `poll=${f.pollIntervalSeconds}s cooldown=${f.cooldownSeconds}s dryRun=${f.dryRun}\n` +
    (f.targets ?? []).map((t) => `  - ${t.label} (${t.serviceId}) regions: ${fmtRegions(t.regions)}`).join("\n"),

  cycle_skipped: (f) => `Cycle skipped: ${f.reason}`,

  cycle_error: (f) => `[ERROR] ${f.stage}: ${f.error}`,

  service_error: (f) => `[ERROR] ${f.label} (${f.serviceId}) @ ${f.stage}: ${f.error}`,

  skip_unconfigured_region: (f) => `${f.label} [${f.region}]  skipped - region not listed in SCALE_TARGETS.regions`,

  skip_cooldown: (f) => `${f.label} [${f.region}]  skipped - cooling down (${f.remainingSeconds}s left)`,

  decision: (f) => {
    const outcome = f.action === "none" ? "no change" : `${f.action} to ${f.desiredReplicas} replicas`;
    return (
      `${f.label} [${f.region}]  cpu=${fmtPct(f.cpuPct)} mem=${fmtPct(f.memPct)} ` +
      `replicas=${f.currentReplicas}  =>  ${outcome}  (${f.reason})`
    );
  },

  dry_run_skip_apply: (f) => `[DRY RUN] Would apply:\n${fmtChanges(f.changes)}`,

  applied: (f) => `Applied:\n${fmtChanges(f.changes)}`,
};

/**
 * Returns a `log(event, fields)` function. "json" emits one structured JSON
 * line per call (good for log aggregators, e.g. Railway's own log viewer).
 * "pretty" emits a short human-readable line per call (good for watching
 * `DRY_RUN` locally or in the Railway logs UI while tuning thresholds).
 */
export function createLogger(format) {
  if (format === "pretty") {
    return function log(event, fields = {}) {
      const formatter = PRETTY_FORMATTERS[event];
      const line = formatter ? formatter(fields) : `${event} ${JSON.stringify(fields)}`;
      console.log(`[${new Date().toISOString()}] ${line}`);
    };
  }
  return function log(event, fields = {}) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  };
}

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
    const outcome = f.action === "none" ? "no change" : `${f.action} to ${f.desiredReplicas} replicas  (${f.reason})`;
    return `${f.label} [${f.region}]  cpu=${fmtPct(f.cpuPct)} mem=${fmtPct(f.memPct)} replicas=${f.currentReplicas}  =>  ${outcome}`;
  },

  dry_run_skip_apply: (f) => `[DRY RUN] Would apply:\n${fmtChanges(f.changes)}`,

  applied: (f) => `Applied:\n${fmtChanges(f.changes)}`,
};

function renderLine(event, fields) {
  const formatter = PRETTY_FORMATTERS[event];
  return formatter ? formatter(fields) : `${event} ${JSON.stringify(fields)}`;
}

/** Right-pads `fields.label` to `width` for column alignment, without mutating the original. */
function withPaddedLabel(fields, width) {
  if (fields.label == null || !width) return fields;
  return { ...fields, label: fields.label.padEnd(width) };
}

/**
 * Returns `{ log, logCycle }`.
 *
 * `log(event, fields)` emits a single line immediately - for process-level
 * events like startup, or a cycle that aborted before evaluating anything.
 *
 * `logCycle(entries)` emits everything gathered during one poll cycle
 * (per-region decisions, skips, errors, and the apply outcome) together,
 * so a whole cycle reads as one message instead of a scattered wall of
 * lines. In "json" format this still emits one structured line per entry
 * (log aggregators keep working unchanged); in "pretty" format it's
 * rendered as a single bordered block with label columns aligned.
 */
export function createLogger(format) {
  if (format === "pretty") {
    const log = (event, fields = {}) => {
      console.log(`[${new Date().toISOString()}] ${renderLine(event, fields)}`);
    };

    const logCycle = (entries) => {
      if (entries.length === 0) return;

      const labelWidth = Math.max(0, ...entries.map((e) => (e.fields.label ?? "").length));
      const lines = entries.map((e) => `  ${renderLine(e.event, withPaddedLabel(e.fields, labelWidth))}`);
      const width = Math.min(100, Math.max(40, ...lines.map((l) => l.length)));
      const border = "-".repeat(width);

      console.log(`[${new Date().toISOString()}]\n${border}\n${lines.join("\n")}\n${border}`);
    };

    return { log, logCycle };
  }

  const log = (event, fields = {}) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  };

  return { log, logCycle: (entries) => entries.forEach(({ event, fields }) => log(event, fields)) };
}

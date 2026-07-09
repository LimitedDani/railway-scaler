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
    const cpu = f.cpuStr ?? fmtPct(f.cpuPct);
    const mem = f.memStr ?? fmtPct(f.memPct);
    const replicas = f.replicasStr ?? String(f.currentReplicas);
    return `${f.label} [${f.region}]  cpu=${cpu} mem=${mem} replicas=${replicas}  =>  ${outcome}`;
  },

  dry_run_skip_apply: (f) => `[DRY RUN] Would apply:\n${fmtChanges(f.changes)}`,

  applied: (f) => `Applied:\n${fmtChanges(f.changes)}`,
};

function renderLine(event, fields) {
  const formatter = PRETTY_FORMATTERS[event];
  return formatter ? formatter(fields) : `${event} ${JSON.stringify(fields)}`;
}

/**
 * Right-pads every alignable column of a cycle's entries to a shared width,
 * so rows stay in neat columns even when e.g. one row's cpu% grows an extra
 * digit ("0%" vs "82.3%") - without this, only `label` lined up and
 * everything after it (mem, replicas, the outcome) would drift per row.
 */
function alignColumns(entries) {
  const labelWidth = Math.max(0, ...entries.map((e) => (e.fields.label ?? "").length));
  const regionWidth = Math.max(0, ...entries.map((e) => (e.fields.region ?? "").length));

  const decisions = entries.filter((e) => e.event === "decision");
  const cpuWidth = Math.max(0, ...decisions.map((e) => fmtPct(e.fields.cpuPct).length));
  const memWidth = Math.max(0, ...decisions.map((e) => fmtPct(e.fields.memPct).length));
  const replicasWidth = Math.max(0, ...decisions.map((e) => String(e.fields.currentReplicas).length));

  return entries.map((e) => {
    const f = { ...e.fields };
    if (f.label != null) f.label = f.label.padEnd(labelWidth);
    if (f.region != null) f.region = f.region.padEnd(regionWidth);
    if (e.event === "decision") {
      f.cpuStr = fmtPct(f.cpuPct).padEnd(cpuWidth);
      f.memStr = fmtPct(f.memPct).padEnd(memWidth);
      f.replicasStr = String(f.currentReplicas).padEnd(replicasWidth);
    }
    return { event: e.event, fields: f };
  });
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
 * rendered as a single bordered block with columns aligned.
 */
export function createLogger(format) {
  if (format === "pretty") {
    const log = (event, fields = {}) => {
      console.log(`[${new Date().toISOString()}] ${renderLine(event, fields)}`);
    };

    const logCycle = (entries) => {
      if (entries.length === 0) return;

      const lines = alignColumns(entries).map((e) => `  ${renderLine(e.event, e.fields)}`);
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

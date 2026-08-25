import { baseRegionOf } from "./regions.js";

/**
 * Shared in-memory runtime state between the autoscaler loop (writer of
 * metrics/decisions, reader of overrides) and the web panel (reader of
 * metrics/decisions, writer of overrides).
 *
 * Overrides are deliberately kept in memory only: they are meant as a
 * short-lived manual intervention ("hold 2 replicas for the next 2 hours"),
 * and a restart/redeploy of the autoscaler dropping them is acceptable -
 * the configured SCALE_TARGETS floor always remains in effect.
 */

const MAX_AUDIT_ENTRIES = 100;
const MAX_SCALING_LOG = 200;

export function createState() {
  return {
    startedAt: new Date().toISOString(),
    lastCycleAt: null,
    lastCycleEvents: [],
    // "<serviceId>::<baseRegion>" -> latest decision fields for that region,
    // kept across cycles so a region skipped this cycle (cooldown) still
    // shows its last known metrics in the panel.
    latestByRegion: new Map(),
    // "<serviceId>::<baseRegion>" -> { minReplicas, createdAt, expiresAt }
    overrides: new Map(),
    // Most recent override actions, newest first.
    auditLog: [],
    // Actual scale up/down events, newest first. Cycles where nothing
    // changed are deliberately not recorded here.
    scalingLog: [],
  };
}

export function recordScaling(state, changes, { dryRun }) {
  const at = new Date().toISOString();
  for (const change of changes) {
    state.scalingLog.unshift({ at, dryRun, ...change });
  }
  if (state.scalingLog.length > MAX_SCALING_LOG) state.scalingLog.length = MAX_SCALING_LOG;
}

export function overrideKey(serviceId, region) {
  return `${serviceId}::${baseRegionOf(region)}`;
}

export function recordCycle(state, events) {
  state.lastCycleAt = new Date().toISOString();
  state.lastCycleEvents = events;
  for (const { event, fields } of events) {
    if (event !== "decision" || !fields.serviceId || !fields.region) continue;
    state.latestByRegion.set(overrideKey(fields.serviceId, fields.region), {
      ...fields,
      at: state.lastCycleAt,
    });
  }
}

function pruneExpired(state) {
  const now = Date.now();
  for (const [key, override] of state.overrides.entries()) {
    if (override.expiresAt <= now) {
      state.overrides.delete(key);
      addAudit(state, "expired", key, override);
    }
  }
}

function addAudit(state, action, key, override) {
  state.auditLog.unshift({
    at: new Date().toISOString(),
    action,
    key,
    minReplicas: override.minReplicas,
    expiresAt: new Date(override.expiresAt).toISOString(),
  });
  if (state.auditLog.length > MAX_AUDIT_ENTRIES) state.auditLog.length = MAX_AUDIT_ENTRIES;
}

export function getActiveOverride(state, serviceId, region) {
  pruneExpired(state);
  return state.overrides.get(overrideKey(serviceId, region)) ?? null;
}

export function setOverride(state, serviceId, region, minReplicas, durationMs) {
  const key = overrideKey(serviceId, region);
  const override = {
    serviceId,
    region: baseRegionOf(region),
    minReplicas,
    createdAt: Date.now(),
    expiresAt: Date.now() + durationMs,
  };
  state.overrides.set(key, override);
  addAudit(state, "set", key, override);
  return override;
}

export function clearOverride(state, serviceId, region) {
  const key = overrideKey(serviceId, region);
  const override = state.overrides.get(key);
  if (!override) return null;
  state.overrides.delete(key);
  addAudit(state, "cleared", key, override);
  return override;
}

export function listOverrides(state) {
  pruneExpired(state);
  return [...state.overrides.values()].map((o) => ({
    serviceId: o.serviceId,
    region: o.region,
    minReplicas: o.minReplicas,
    createdAt: new Date(o.createdAt).toISOString(),
    expiresAt: new Date(o.expiresAt).toISOString(),
    remainingSeconds: Math.max(0, Math.round((o.expiresAt - Date.now()) / 1000)),
  }));
}

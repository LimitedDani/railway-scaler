/**
 * Pure decision function - no I/O, easy to reason about/test in isolation.
 *
 * Rules (per the chosen design):
 *  - Scale UP by 1 if CPU% OR Memory% is above its "high" threshold, unless
 *    already at maxReplicas.
 *  - Scale DOWN by 1 only if BOTH CPU% AND Memory% are below their "low"
 *    threshold, unless already at minReplicas (floor of 1).
 *  - Otherwise, do nothing. Missing metrics never trigger a scale down (we
 *    only ever scale down when we're confident load is actually low), but a
 *    single missing metric can still trigger a scale up from the other one.
 */
export function decide({ cpuPct, memPct, currentReplicas, target }) {
  const { minReplicas, maxReplicas, cpuHigh, cpuLow, memHigh, memLow } = target;

  const hasCpu = cpuPct != null;
  const hasMem = memPct != null;

  if (!hasCpu && !hasMem) {
    return { action: "none", desiredReplicas: currentReplicas, reason: "no metrics data available yet" };
  }

  const overHigh = (hasCpu && cpuPct > cpuHigh) || (hasMem && memPct > memHigh);
  if (overHigh) {
    if (currentReplicas >= maxReplicas) {
      return { action: "none", desiredReplicas: currentReplicas, reason: `load is high but already at maxReplicas (${maxReplicas})` };
    }
    return { action: "up", desiredReplicas: currentReplicas + 1, reason: "cpu or memory usage above high threshold" };
  }

  const underLowOnBoth = hasCpu && hasMem && cpuPct < cpuLow && memPct < memLow;
  if (underLowOnBoth) {
    if (currentReplicas <= minReplicas) {
      return { action: "none", desiredReplicas: currentReplicas, reason: `load is low but already at minReplicas (${minReplicas})` };
    }
    return { action: "down", desiredReplicas: currentReplicas - 1, reason: "cpu and memory usage both below low threshold" };
  }

  return { action: "none", desiredReplicas: currentReplicas, reason: "within normal range" };
}

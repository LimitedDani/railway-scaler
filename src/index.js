import { loadConfig } from "./config.js";
import {
  getEnvironmentConfig,
  getServiceInstance,
  resolveRegionReplicas,
  getServiceUtilization,
  getUtilizationByRegion,
  applyPatch,
} from "./railwayApi.js";
import { decide } from "./decide.js";
import { createLogger } from "./logger.js";
import { baseRegionOf } from "./regions.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const { log, logCycle } = createLogger(config.logFormat);

// "<serviceId>::<region>" -> timestamp (ms) of the last scaling event for
// that specific region, kept in memory for the lifetime of this process.
// Each region of a service is scaled independently and cools down
// independently - scaling one region up doesn't hold back another region
// of the same service that also needs to scale.
const lastScaledAt = new Map();

// Minimum lookback window for metrics, regardless of poll interval, so a
// very short POLL_INTERVAL_SECONDS still gets a meaningful sample.
const MIN_METRIC_WINDOW_SECONDS = 30;

function round(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

function cooldownKey(serviceId, region) {
  return `${serviceId}::${region}`;
}

// Matches by base region rather than an exact string, since the metrics
// API's region tag can use a different suffix than the live region key
// (e.g. "europe-west4-drams11a" reported for "europe-west4-drams3a") - see
// src/regions.js.
function findUtilizationForBaseRegion(utilizationByRegion, baseRegion) {
  for (const [tag, utilization] of utilizationByRegion.entries()) {
    if (baseRegionOf(tag) === baseRegion) return utilization;
  }
  return { cpuPct: null, memPct: null };
}

function inCooldown(key) {
  const last = lastScaledAt.get(key);
  return last !== undefined && Date.now() - last < config.cooldownMs;
}

async function runCycle() {
  if (config.targets.length === 0) {
    log("cycle_skipped", { reason: "no scale targets configured" });
    return;
  }

  let envConfig;
  try {
    envConfig = await getEnvironmentConfig(config.token, config.environmentId);
  } catch (err) {
    log("cycle_error", { stage: "getEnvironmentConfig", error: err.message });
    return;
  }

  const patchServices = {};
  const changes = [];
  const cycleEvents = [];
  const metricWindowSeconds = Math.max(config.pollIntervalMs / 1000, MIN_METRIC_WINDOW_SECONDS);

  for (const target of config.targets) {
    const { serviceId, label } = target;

    let serviceInstance;
    try {
      serviceInstance = await getServiceInstance(config.token, config.environmentId, serviceId);
    } catch (err) {
      cycleEvents.push({ event: "service_error", fields: { serviceId, label, stage: "getServiceInstance", error: err.message } });
      continue;
    }

    const regionReplicas = resolveRegionReplicas(envConfig, serviceInstance, serviceId);
    if (regionReplicas.length === 0) {
      cycleEvents.push({
        event: "service_error",
        fields: {
          serviceId,
          label,
          stage: "resolveRegionReplicas",
          error: "service has no region/replica config yet - set an initial region and replica count once in the Railway dashboard before autoscaling it",
        },
      });
      continue;
    }

    // With only one live region there's no region name to match against the
    // metrics API - just use the whole service's usage. This also sidesteps
    // a real Railway quirk where the region key in `multiRegionConfig`
    // (e.g. "europe-west4-drams3a") doesn't always match the `region` tag
    // the metrics API reports for the same service's usage (e.g.
    // "europe-west4-drams11a", the actual physical rack a replica landed
    // on). Grouping by region is only needed - and only reliable - once a
    // service genuinely has more than one region to tell apart.
    let utilizationByRegion;
    try {
      if (regionReplicas.length === 1) {
        const utilization = await getServiceUtilization(config.token, config.environmentId, serviceId, metricWindowSeconds);
        utilizationByRegion = new Map([[regionReplicas[0].region, utilization]]);
      } else {
        utilizationByRegion = await getUtilizationByRegion(config.token, config.environmentId, serviceId, metricWindowSeconds);
        const metricsBases = new Set([...utilizationByRegion.keys()].map(baseRegionOf));
        const unmatched = regionReplicas.filter((r) => !metricsBases.has(baseRegionOf(r.region)));
        if (unmatched.length > 0) {
          cycleEvents.push({
            event: "service_error",
            fields: {
              serviceId,
              label,
              stage: "getUtilizationByRegion",
              error:
                `configured region(s) [${unmatched.map((r) => r.region).join(", ")}] have no matching base region ` +
                `in metrics tags (metrics reported: [${[...utilizationByRegion.keys()].join(", ") || "none"}]). ` +
                "This region may not have received traffic yet, or it's a Railway region src/regions.js doesn't " +
                "know about yet.",
            },
          });
        }
      }
    } catch (err) {
      cycleEvents.push({ event: "service_error", fields: { serviceId, label, stage: "getUtilization", error: err.message } });
      continue;
    }

    // Each region a service is deployed to is evaluated and scaled
    // independently - a busy region and an idle region of the same service
    // can scale in opposite directions in the same cycle.
    const regionPatch = {};

    for (const { region, replicas: currentReplicas } of regionReplicas) {
      const baseRegion = baseRegionOf(region);
      const regionConfig = target.regions[baseRegion];
      if (!regionConfig) {
        cycleEvents.push({
          event: "skip_unconfigured_region",
          fields: {
            serviceId,
            label,
            region,
            reason: "region is live on Railway but has no entry in SCALE_TARGETS.regions - not touching it",
          },
        });
        continue;
      }

      const key = cooldownKey(serviceId, region);

      if (inCooldown(key)) {
        const remainingSeconds = Math.ceil((config.cooldownMs - (Date.now() - lastScaledAt.get(key))) / 1000);
        cycleEvents.push({ event: "skip_cooldown", fields: { serviceId, label, region, remainingSeconds } });
        continue;
      }

      const utilization = findUtilizationForBaseRegion(utilizationByRegion, baseRegion);

      const decision = decide({
        cpuPct: utilization.cpuPct,
        memPct: utilization.memPct,
        currentReplicas,
        target: regionConfig,
      });

      cycleEvents.push({
        event: "decision",
        fields: {
          serviceId,
          label,
          region,
          currentReplicas,
          cpuPct: round(utilization.cpuPct),
          memPct: round(utilization.memPct),
          action: decision.action,
          desiredReplicas: decision.desiredReplicas,
          reason: decision.reason,
        },
      });

      if (decision.action === "none") continue;

      regionPatch[region] = { numReplicas: decision.desiredReplicas };
      changes.push({ serviceId, label, region, from: currentReplicas, to: decision.desiredReplicas });
    }

    if (Object.keys(regionPatch).length > 0) {
      patchServices[serviceId] = { deploy: { multiRegionConfig: regionPatch } };
    }
  }

  if (changes.length === 0) {
    logCycle(cycleEvents);
    return;
  }

  if (config.dryRun) {
    cycleEvents.push({ event: "dry_run_skip_apply", fields: { changes } });
    logCycle(cycleEvents);
    return;
  }

  const commitMessage = `autoscale: ${changes.map((c) => `${c.label}[${c.region}] ${c.from}->${c.to}`).join(", ")}`;
  try {
    await applyPatch(config.token, config.environmentId, { services: patchServices }, commitMessage);
    const now = Date.now();
    for (const change of changes) lastScaledAt.set(cooldownKey(change.serviceId, change.region), now);
    cycleEvents.push({ event: "applied", fields: { changes } });
  } catch (err) {
    cycleEvents.push({ event: "cycle_error", fields: { stage: "applyPatch", error: err.message, attempted: changes } });
  }
  logCycle(cycleEvents);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  log("startup", {
    projectId: config.projectId,
    environmentId: config.environmentId,
    targets: config.targets.map((t) => ({ serviceId: t.serviceId, label: t.label, regions: Object.keys(t.regions) })),
    pollIntervalSeconds: config.pollIntervalMs / 1000,
    cooldownSeconds: config.cooldownMs / 1000,
    dryRun: config.dryRun,
  });

  // Cycles run back-to-back (never overlapping): each tick waits for the
  // previous one to finish before the next interval is scheduled.
  for (;;) {
    const cycleStart = Date.now();
    try {
      await runCycle();
    } catch (err) {
      log("cycle_error", { stage: "runCycle", error: err instanceof Error ? err.message : String(err) });
    }
    const waitMs = Math.max(config.pollIntervalMs - (Date.now() - cycleStart), 0);
    await sleep(waitMs);
  }
}

main().catch((err) => {
  console.error("Fatal error, exiting:", err);
  process.exit(1);
});

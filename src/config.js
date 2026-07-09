import { baseRegionOf, KNOWN_REGIONS } from "./regions.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["true", "1", "yes"].includes(raw.trim().toLowerCase());
}

function resolveLogFormat(dryRun) {
  const raw = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (!raw) return dryRun ? "pretty" : "json";
  if (raw !== "json" && raw !== "pretty") {
    throw new Error(`LOG_FORMAT must be "json" or "pretty", got "${raw}"`);
  }
  return raw;
}

function isPositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function parseScaleTargets(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SCALE_TARGETS is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SCALE_TARGETS must be a JSON array");
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || typeof entry.serviceId !== "string" || entry.serviceId.trim() === "") {
      throw new Error(`Each SCALE_TARGETS entry must be an object with a non-empty "serviceId" string, got ${JSON.stringify(entry)}`);
    }
    if (!entry.regions || typeof entry.regions !== "object" || Array.isArray(entry.regions) || Object.keys(entry.regions).length === 0) {
      throw new Error(
        `SCALE_TARGETS entry ${entry.serviceId} is missing "regions". Each service must explicitly list its regions ` +
          `with a required minReplicas, e.g. {"serviceId":"${entry.serviceId}","regions":{"us-west2":{"minReplicas":1}}}`
      );
    }
    for (const [region, regionConfig] of Object.entries(entry.regions)) {
      if (!regionConfig || typeof regionConfig !== "object" || !isPositiveInt(regionConfig.minReplicas)) {
        throw new Error(
          `SCALE_TARGETS entry ${entry.serviceId} region "${region}" is missing a required "minReplicas" ` +
            `(must be an integer >= 1), got ${JSON.stringify(regionConfig)}`
        );
      }
    }
  }

  return parsed;
}

/**
 * Merges global defaults with any per-service and per-region overrides, and
 * drops the autoscaler's own service ID if it was accidentally included so
 * the tool can never scale itself.
 *
 * minReplicas has no global default - it is required per region in
 * SCALE_TARGETS, since it's your safety floor and shouldn't be silently
 * assumed. Everything else (maxReplicas, thresholds) cascades
 * region -> service -> global.
 */
function buildTargets(rawTargets, defaults, selfServiceId) {
  const seen = new Set();
  const targets = [];

  for (const entry of rawTargets) {
    if (selfServiceId && entry.serviceId === selfServiceId) {
      console.warn(`[config] Ignoring SCALE_TARGETS entry for ${entry.serviceId}: refusing to scale the autoscaler's own service.`);
      continue;
    }
    if (seen.has(entry.serviceId)) {
      console.warn(`[config] Duplicate SCALE_TARGETS entry for ${entry.serviceId}, ignoring the duplicate.`);
      continue;
    }
    seen.add(entry.serviceId);

    const serviceMaxReplicas = entry.maxReplicas ?? defaults.maxReplicas;
    const serviceCpuHigh = entry.cpuHigh ?? defaults.cpuHigh;
    const serviceCpuLow = entry.cpuLow ?? defaults.cpuLow;
    const serviceMemHigh = entry.memHigh ?? defaults.memHigh;
    const serviceMemLow = entry.memLow ?? defaults.memLow;

    const regions = {};
    for (const [rawRegion, regionConfig] of Object.entries(entry.regions)) {
      // Normalize to the base region name (e.g. "europe-west4-drams3a" and
      // "europe-west4" both become "europe-west4") so this always matches
      // the real live region key and metrics tags at runtime, regardless of
      // which exact suffix was typed here - see src/regions.js.
      const region = baseRegionOf(rawRegion);
      const minReplicas = regionConfig.minReplicas;
      const maxReplicas = regionConfig.maxReplicas ?? serviceMaxReplicas;

      if (maxReplicas < minReplicas) {
        throw new Error(
          `SCALE_TARGETS entry ${entry.serviceId} region "${rawRegion}" has maxReplicas (${maxReplicas}) ` +
            `below its required minReplicas (${minReplicas})`
        );
      }

      if (regions[region]) {
        throw new Error(
          `SCALE_TARGETS entry ${entry.serviceId} lists region "${rawRegion}", which normalizes to base region ` +
            `"${region}" - but that base region is already configured under a different suffix. List each ` +
            `region once, using its base name (one of: ${KNOWN_REGIONS.join(", ")}).`
        );
      }

      regions[region] = {
        minReplicas,
        maxReplicas,
        cpuHigh: regionConfig.cpuHigh ?? serviceCpuHigh,
        cpuLow: regionConfig.cpuLow ?? serviceCpuLow,
        memHigh: regionConfig.memHigh ?? serviceMemHigh,
        memLow: regionConfig.memLow ?? serviceMemLow,
      };
    }

    targets.push({
      serviceId: entry.serviceId,
      label: entry.label ?? entry.serviceId,
      regions,
    });
  }

  return targets;
}

export function loadConfig() {
  const token = requireEnv("RAILWAY_API_TOKEN");
  const projectId = requireEnv("RAILWAY_PROJECT_ID");
  const environmentId = requireEnv("RAILWAY_ENVIRONMENT_ID");
  const selfServiceId = process.env.RAILWAY_SERVICE_ID?.trim() || null;

  const defaults = {
    maxReplicas: envInt("MAX_REPLICAS", 3),
    cpuHigh: envInt("CPU_HIGH", 75),
    cpuLow: envInt("CPU_LOW", 30),
    memHigh: envInt("MEM_HIGH", 75),
    memLow: envInt("MEM_LOW", 30),
  };

  const rawTargets = parseScaleTargets(process.env.SCALE_TARGETS ?? "[]");
  const targets = buildTargets(rawTargets, defaults, selfServiceId);

  if (targets.length === 0) {
    console.warn("[config] SCALE_TARGETS is empty (or only contained the autoscaler's own service). Nothing will be scaled.");
  }

  const pollIntervalSeconds = envInt("POLL_INTERVAL_SECONDS", 60);
  const cooldownSeconds = envInt("COOLDOWN_SECONDS", 180);
  const dryRun = envBool("DRY_RUN", false);

  // Not required, but tagged onto every log line - Railway does rolling
  // deploys, so the previous deployment's container can briefly keep
  // running (and logging) after a new one has started. Two processes
  // writing their own cycles to the same log stream at once can otherwise
  // look like one cycle is missing services, when really it's two
  // interleaved cycles from two different processes.
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim() || null;
  const replicaId = process.env.RAILWAY_REPLICA_ID?.trim() || null;

  return {
    token,
    projectId,
    environmentId,
    selfServiceId,
    deploymentId,
    replicaId,
    dryRun,
    logFormat: resolveLogFormat(dryRun),
    pollIntervalMs: pollIntervalSeconds * 1000,
    cooldownMs: cooldownSeconds * 1000,
    targets,
  };
}

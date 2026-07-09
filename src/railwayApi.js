const ENDPOINT = "https://backboard.railway.com/graphql/v2";

class RailwayApiError extends Error {}

async function graphqlRequest(token, query, variables) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Project-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new RailwayApiError(`Railway API returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new RailwayApiError(`Railway API request failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }
  if (body.errors?.length) {
    throw new RailwayApiError(`Railway API returned errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

/**
 * The full, serialized environment config (services, deploy settings,
 * multiRegionConfig, etc). This is the only place `multiRegionConfig` can be
 * read from - it is not exposed as a field on `ServiceInstance`.
 * See https://backboard.railway.com/schema/environment.schema.json
 */
export async function getEnvironmentConfig(token, environmentId) {
  const query = `
    query AutoscalerEnvironmentConfig($environmentId: String!) {
      environment(id: $environmentId) {
        config
      }
    }
  `;
  const data = await graphqlRequest(token, query, { environmentId });
  return data.environment?.config ?? {};
}

/**
 * Legacy single-region fallback for services that have never had their
 * region/replica config explicitly migrated into multiRegionConfig.
 */
export async function getServiceInstance(token, environmentId, serviceId) {
  const query = `
    query AutoscalerServiceInstance($environmentId: String!, $serviceId: String!) {
      serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
        region
        numReplicas
      }
    }
  `;
  const data = await graphqlRequest(token, query, { environmentId, serviceId });
  return data.serviceInstance;
}

/**
 * Given the environment config blob and the legacy serviceInstance fallback,
 * work out every region a service currently runs in and how many replicas
 * it has in each one. A service can be deployed to multiple regions at
 * once (each with its own replica count in `multiRegionConfig`), so this
 * returns one entry per region rather than assuming a single region.
 */
export function resolveRegionReplicas(envConfig, serviceInstance, serviceId) {
  const multiRegionConfig = envConfig?.services?.[serviceId]?.deploy?.multiRegionConfig;
  if (multiRegionConfig && typeof multiRegionConfig === "object") {
    const regions = Object.keys(multiRegionConfig).filter((r) => multiRegionConfig[r]);
    if (regions.length > 0) {
      return regions.map((region) => ({
        region,
        replicas: multiRegionConfig[region]?.numReplicas ?? 1,
        source: "multiRegionConfig",
      }));
    }
  }
  if (serviceInstance?.region) {
    return [{ region: serviceInstance.region, replicas: serviceInstance.numReplicas ?? 1, source: "serviceInstance" }];
  }
  return [];
}

const METRIC_NAMES = ["CPU_USAGE", "CPU_LIMIT", "MEMORY_USAGE_GB", "MEMORY_LIMIT_GB"];

function average(values) {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v.value, 0);
  return sum / values.length;
}

function pctFrom(averages) {
  const cpuPct =
    averages.CPU_USAGE != null && averages.CPU_LIMIT ? (averages.CPU_USAGE / averages.CPU_LIMIT) * 100 : null;
  const memPct =
    averages.MEMORY_USAGE_GB != null && averages.MEMORY_LIMIT_GB
      ? (averages.MEMORY_USAGE_GB / averages.MEMORY_LIMIT_GB) * 100
      : null;
  return { cpuPct, memPct, raw: averages };
}

function emptyAverages() {
  const initial = {};
  for (const name of METRIC_NAMES) initial[name] = null;
  return initial;
}

/**
 * Fetches usage/limit metrics for a whole service over the given lookback
 * window (not split by region) and reduces the samples to average CPU% and
 * Memory% utilization. Use this when a service only runs in a single
 * region - there's no ambiguity to resolve, and it sidesteps a real Railway
 * quirk where the region key in `multiRegionConfig` (config-time) doesn't
 * always match the `region` tag reported by the metrics API for the same
 * service (metrics reflect the actual physical rack a replica landed on,
 * e.g. "europe-west4-drams11a", which can differ from the region key you
 * configured, e.g. "europe-west4-drams3a").
 */
export async function getServiceUtilization(token, environmentId, serviceId, windowSeconds) {
  const startDate = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const query = `
    query AutoscalerMetrics($environmentId: String!, $serviceId: String!, $startDate: DateTime!) {
      metrics(
        environmentId: $environmentId
        serviceId: $serviceId
        startDate: $startDate
        measurements: [CPU_USAGE, CPU_LIMIT, MEMORY_USAGE_GB, MEMORY_LIMIT_GB]
        groupBy: [SERVICE_ID]
      ) {
        measurement
        values {
          ts
          value
        }
      }
    }
  `;
  const data = await graphqlRequest(token, query, { environmentId, serviceId, startDate });

  const averages = emptyAverages();
  for (const result of data.metrics ?? []) {
    averages[result.measurement] = average(result.values);
  }
  return pctFrom(averages);
}

/**
 * Fetches usage/limit metrics for a service over the given lookback window,
 * broken down per region, and reduces each region's samples to average CPU%
 * and Memory% utilization. Only meaningful for services with 2+ regions -
 * see the caveat on `getServiceUtilization` about region key mismatches
 * between `multiRegionConfig` and the metrics API's `region` tag. Callers
 * should match returned keys against a configured region by base region
 * (see `baseRegionOf` in src/regions.js), not exact string equality, and
 * treat a configured region whose base has no match at all as "region name
 * mismatch, not missing data" - surface it loudly rather than silently
 * treating it as zero usage.
 *
 * Returns a Map<region, { cpuPct, memPct, raw }> keyed by the raw region tag
 * exactly as reported by the metrics API (not normalized).
 */
export async function getUtilizationByRegion(token, environmentId, serviceId, windowSeconds) {
  const startDate = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const query = `
    query AutoscalerMetrics($environmentId: String!, $serviceId: String!, $startDate: DateTime!) {
      metrics(
        environmentId: $environmentId
        serviceId: $serviceId
        startDate: $startDate
        measurements: [CPU_USAGE, CPU_LIMIT, MEMORY_USAGE_GB, MEMORY_LIMIT_GB]
        groupBy: [SERVICE_ID, REGION]
      ) {
        measurement
        tags {
          region
        }
        values {
          ts
          value
        }
      }
    }
  `;
  const data = await graphqlRequest(token, query, { environmentId, serviceId, startDate });

  const averagesByRegion = new Map();
  for (const result of data.metrics ?? []) {
    const region = result.tags?.region;
    if (!region) continue;
    if (!averagesByRegion.has(region)) {
      averagesByRegion.set(region, emptyAverages());
    }
    averagesByRegion.get(region)[result.measurement] = average(result.values);
  }

  const utilizationByRegion = new Map();
  for (const [region, averages] of averagesByRegion.entries()) {
    utilizationByRegion.set(region, pctFrom(averages));
  }
  return utilizationByRegion;
}

/**
 * Stages and commits a patch to the environment in one call. `patch` should
 * be a partial EnvironmentConfig object, e.g.
 * { services: { "<serviceId>": { deploy: { multiRegionConfig: { "<region>": { numReplicas: N } } } } } }
 */
export async function applyPatch(token, environmentId, patch, commitMessage) {
  const mutation = `
    mutation AutoscalerApplyPatch($environmentId: String!, $patch: EnvironmentConfig!, $commitMessage: String) {
      environmentPatchCommit(environmentId: $environmentId, patch: $patch, commitMessage: $commitMessage)
    }
  `;
  const data = await graphqlRequest(token, mutation, { environmentId, patch, commitMessage });
  return data.environmentPatchCommit;
}

export { RailwayApiError };

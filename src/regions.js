/**
 * Railway's four documented deployment regions. The identifier Railway
 * actually stores in `multiRegionConfig` (and shows in the dashboard)
 * includes a datacenter suffix for three of the four - e.g.
 * "europe-west4-drams3a" - but the *metrics* API can tag the exact same
 * physical region with a different suffix (we've seen a service configured
 * with "europe-west4-drams3a" get its metrics tagged "europe-west4-drams11a").
 *
 * Rather than asking you to know the exact suffix (which can differ between
 * config and metrics, and isn't published anywhere), SCALE_TARGETS only
 * needs one of these base names. The autoscaler discovers the real live
 * suffix itself from the environment config, and matches metrics tags to it
 * by this same base prefix instead of requiring an exact string match.
 */
export const KNOWN_REGIONS = ["us-west2", "us-east4", "europe-west4", "asia-southeast1"];

/**
 * Reduces any Railway region identifier down to its base region name, e.g.
 * "europe-west4-drams3a" -> "europe-west4", "europe-west4-drams11a" ->
 * "europe-west4", "us-west2" -> "us-west2".
 *
 * Falls back to the raw value unchanged if it doesn't match a known base
 * (e.g. a brand new Railway region we don't know about yet), so nothing
 * silently breaks - it just won't automatically reconcile a differently
 * suffixed match for that region.
 */
export function baseRegionOf(regionKey) {
  if (!regionKey) return regionKey;
  const base = KNOWN_REGIONS.find((known) => regionKey === known || regionKey.startsWith(`${known}-`));
  return base ?? regionKey;
}

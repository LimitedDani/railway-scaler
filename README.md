# Railway Replica Autoscaler

A small Node.js service you deploy alongside your other services in a Railway
project. On a timer, it checks CPU and Memory usage for an allowlisted set of
services - per region, if a service runs in more than one - and scales each
region's replica count up or down by 1 (never below 1) via Railway's GraphQL
API, with a cooldown between scaling events so it never fights itself.

Railway doesn't have a native "auto-scale replicas" toggle. This is the
DIY approach [Railway's own docs point to](https://blog.railway.com/p/launch-week-01-horizontal-scaling):
poll metrics, decide, and call the API - built here so it watches every
service you list, not just one.

## How it decides

For each **region** of each target service, every cycle:

- **Scale up (+1 replica)** if CPU% or Memory% is above its "high" threshold
  (unless already at `maxReplicas`).
- **Scale down (-1 replica)** only if CPU% *and* Memory% are both below their
  "low" threshold (unless already at that region's `minReplicas` floor).
- Otherwise, do nothing.

If a service is deployed to multiple Railway regions, each region is read
and scaled completely independently, based on that region's own usage - a
busy `eu-west` and an idle `us-west2` for the same service can scale in
opposite directions in the same cycle. Thresholds and replica limits
(`minReplicas`, `maxReplicas`, `cpuHigh`, etc.) apply per region, not to the
service's combined total across all regions.

`minReplicas` has no global default - you must explicitly set it for every
region you list in `SCALE_TARGETS`, since it's the safety floor the
autoscaler will never go below. A region that's actually running on Railway
but isn't listed under a target's `regions` is left alone entirely (logged as
`skip_unconfigured_region`), so partially configuring a multi-region service
is safe.

After any scale event for a region, that specific `(service, region)` pair
is left alone for `COOLDOWN_SECONDS` so newly booted replicas get a chance to
settle and start taking traffic before being reconsidered. Cooldowns are
tracked independently per region, so scaling one region doesn't block
another region of the same service from scaling if it also needs to.

Only services you explicitly list in `SCALE_TARGETS` are ever touched. The
autoscaler also refuses to scale itself, even if you accidentally include its
own service ID.

**Limitations (by design, see the plan this was built from):**
- CPU/Memory only - no queue-depth or request-latency based scaling.
- A service must already have at least one explicit region + replica count
  set once via the Railway dashboard (Settings > Scale) before the
  autoscaler can manage it - it won't guess a region for a service that's
  never been touched.

**A real Railway quirk this works around:** the region key you set in
`multiRegionConfig` (e.g. `europe-west4-drams3a`) doesn't always match the
`region` tag the metrics API reports for that same service's usage (e.g.
`europe-west4-drams11a` - the actual physical rack a replica landed on, not
the logical region you configured). For a single-region service this is a
non-issue - the autoscaler just reads the whole service's usage without
trying to match region names. If a service has 2+ regions and one of them
can't be matched to a metrics tag, you'll see a `getUtilizationByRegion`
error in the logs naming the mismatch and listing the region(s) the metrics
API actually reported, so you can fix the region code in `SCALE_TARGETS`.

## Setup

### 1. Find your service IDs

For each service you want to autoscale, in the Railway dashboard: open the
service, press `Cmd/Ctrl + K`, and use "Copy Service ID".

### 2. Create a Project Token

In your Railway project: **Settings > Tokens > Create Token**, scoped to the
environment you want to autoscale (e.g. `production`). This token is used via
the `Project-Access-Token` header and never leaves the project.

### 3. Deploy this repo as a new service

In the same Railway project: **New Service > GitHub Repo** (or **Empty
Service** and connect it later), pointing at this repo. Railway's Nixpacks
builder auto-detects the Node app - no Dockerfile needed.

Leave this service's own replica count at 1.

### 4. Configure environment variables

Set these on the autoscaler service (see [.env.example](.env.example) for the
full list with defaults):

- `RAILWAY_API_TOKEN` - the Project Token from step 2.
- `SCALE_TARGETS` - JSON array of services to manage. Each service must list
  its regions with a required `minReplicas` per region, e.g.:

  ```json
  [
    { "serviceId": "abc-123", "regions": { "us-west2": { "minReplicas": 1 } } },
    {
      "serviceId": "def-456",
      "regions": {
        "eu-west4-drams3a": { "minReplicas": 2, "maxReplicas": 8, "cpuHigh": 80 }
      }
    }
  ]
  ```

  `serviceId` and `regions` are required; `regions.<region>.minReplicas` is
  required for every region you list (there's no default - it's your safety
  floor). Optional overrides at either the region level or the service level:
  `label` (service level only), `maxReplicas`, `cpuHigh`, `cpuLow`, `memHigh`,
  `memLow`. These cascade region -> service -> the global env vars below.
  A region actually running on Railway that you don't list here is left
  completely untouched.

- `MAX_REPLICAS`, `CPU_HIGH`, `CPU_LOW`, `MEM_HIGH`, `MEM_LOW` - global
  defaults for all targets that don't override them.
- `POLL_INTERVAL_SECONDS` - how often to check (default `60`).
- `COOLDOWN_SECONDS` - how long to wait after scaling a service before
  reconsidering it (default `180`).
- `DRY_RUN` - set to `true` to log decisions without ever applying them.
  Recommended for your first deploy so you can sanity-check the thresholds
  against your real traffic before letting it make changes.
- `LOG_FORMAT` - `json` (one structured line per event, good for log
  aggregators) or `pretty` (short human-readable lines, good for watching
  along). Defaults to `pretty` whenever `DRY_RUN=true`, and `json` otherwise -
  set it explicitly to override that default in either mode.

`RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and `RAILWAY_SERVICE_ID` don't
need to be set manually - Railway injects them automatically into every
deployed service.

### 5. Watch the logs

Every cycle is logged as a single message: one aligned line per region of
each target service with its current CPU%, Memory%, replica count, and the
decision made (and why), plus the outcome (applied, or what a dry run would
have applied) at the bottom of the same block. With the default
`DRY_RUN=true` -> `pretty` logging, that looks like:

```
[2026-07-08T18:28:25.756Z]
----------------------------------------------------------------------------------------------------
  web       [us-west2]  cpu=82.3% mem=40.1% replicas=1  =>  up to 2 replicas  (cpu or memory usage above high threshold)
  web       [eu-west4]  skipped - cooling down (45s left)
  worker    [us-west2]  cpu=4.1% mem=12.0% replicas=1  =>  no change
  [DRY RUN] Would apply:
  - web [us-west2] 1 -> 2
----------------------------------------------------------------------------------------------------
```

Start with `DRY_RUN=true`, watch a few cycles, tune your thresholds, then
flip it to `false` (which also switches logging to structured `json` unless
you set `LOG_FORMAT` explicitly).

## Local development

```bash
cp .env.example .env
# fill in RAILWAY_API_TOKEN, SCALE_TARGETS, and (for local testing only)
# RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID / RAILWAY_SERVICE_ID
node --env-file=.env src/index.js
```

(Requires Node 20.6+ for `--env-file`; on older Node versions use `dotenv` or
export the variables manually.)

## Project layout

- [src/config.js](src/config.js) - env var parsing/validation, `SCALE_TARGETS`
  parsing, defaults merge, self-service guard.
- [src/railwayApi.js](src/railwayApi.js) - GraphQL client and the operations
  used: reading environment config, reading legacy service instance fields,
  reading per-region metrics, and applying a patch.
- [src/decide.js](src/decide.js) - pure up/down/none decision function.
- [src/logger.js](src/logger.js) - `json`/`pretty` log line formatting.
- [src/index.js](src/index.js) - the polling loop that ties it all together.

import http from "node:http";
import crypto from "node:crypto";
import { getActiveOverride, setOverride, clearOverride, listOverrides } from "./state.js";

// Hard cap on how far in the future an override may expire, as a guardrail
// against a typo ("200 hours") quietly pinning replicas for weeks.
const MAX_OVERRIDE_DURATION_HOURS = 168; // 7 days

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length mismatches don't return faster.
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req, user, password) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const givenUser = decoded.slice(0, separator);
  const givenPassword = decoded.slice(separator + 1);
  // Bitwise & instead of && so both comparisons always run (no short-circuit
  // timing signal on which of the two was wrong).
  return Boolean(Number(timingSafeEqual(givenUser, user)) & Number(timingSafeEqual(givenPassword, password)));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 16 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function findRegionConfig(config, serviceId, region) {
  const target = config.targets.find((t) => t.serviceId === serviceId);
  if (!target) return { error: `unknown serviceId "${serviceId}" - not in SCALE_TARGETS` };
  const regionConfig = target.regions[region];
  if (!regionConfig) {
    return { error: `unknown region "${region}" for service ${target.label} (configured: ${Object.keys(target.regions).join(", ")})` };
  }
  return { target, regionConfig };
}

function buildStateResponse(config, state) {
  const rows = [];
  for (const target of config.targets) {
    for (const [region, regionConfig] of Object.entries(target.regions)) {
      const latest = state.latestByRegion.get(`${target.serviceId}::${region}`) ?? null;
      const override = getActiveOverride(state, target.serviceId, region);
      rows.push({
        serviceId: target.serviceId,
        label: target.label,
        region,
        minReplicas: regionConfig.minReplicas,
        maxReplicas: regionConfig.maxReplicas,
        cpuHigh: regionConfig.cpuHigh,
        cpuLow: regionConfig.cpuLow,
        memHigh: regionConfig.memHigh,
        memLow: regionConfig.memLow,
        latest,
        override: override
          ? {
              minReplicas: override.minReplicas,
              expiresAt: new Date(override.expiresAt).toISOString(),
              remainingSeconds: Math.max(0, Math.round((override.expiresAt - Date.now()) / 1000)),
            }
          : null,
      });
    }
  }
  return {
    now: new Date().toISOString(),
    startedAt: state.startedAt,
    lastCycleAt: state.lastCycleAt,
    dryRun: config.dryRun,
    pollIntervalSeconds: config.pollIntervalMs / 1000,
    cooldownSeconds: config.cooldownMs / 1000,
    rows,
    overrides: listOverrides(state),
    auditLog: state.auditLog.slice(0, 20),
    scalingLog: state.scalingLog.slice(0, 50),
  };
}

async function handleApi(req, res, config, state, log) {
  if (req.method === "GET" && req.url === "/api/state") {
    sendJson(res, 200, buildStateResponse(config, state));
    return;
  }

  if (req.url === "/api/override" && (req.method === "POST" || req.method === "DELETE")) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }

    const serviceId = typeof body.serviceId === "string" ? body.serviceId.trim() : "";
    const region = typeof body.region === "string" ? body.region.trim() : "";
    const found = findRegionConfig(config, serviceId, region);
    if (found.error) {
      sendJson(res, 400, { error: found.error });
      return;
    }

    if (req.method === "DELETE") {
      const cleared = clearOverride(state, serviceId, region);
      if (!cleared) {
        sendJson(res, 404, { error: "no active override for that service/region" });
        return;
      }
      log("override_cleared", { serviceId, label: found.target.label, region });
      sendJson(res, 200, { ok: true });
      return;
    }

    const minReplicas = body.minReplicas;
    const durationHours = body.durationHours;
    if (!Number.isInteger(minReplicas) || minReplicas < 1) {
      sendJson(res, 400, { error: "minReplicas must be an integer >= 1" });
      return;
    }
    if (minReplicas > found.regionConfig.maxReplicas) {
      sendJson(res, 400, {
        error: `minReplicas (${minReplicas}) exceeds maxReplicas (${found.regionConfig.maxReplicas}) for ${found.target.label} [${region}]`,
      });
      return;
    }
    if (typeof durationHours !== "number" || !(durationHours > 0) || durationHours > MAX_OVERRIDE_DURATION_HOURS) {
      sendJson(res, 400, { error: `durationHours must be a number between 0 and ${MAX_OVERRIDE_DURATION_HOURS}` });
      return;
    }

    const override = setOverride(state, serviceId, region, minReplicas, durationHours * 3600 * 1000);
    log("override_set", {
      serviceId,
      label: found.target.label,
      region,
      minReplicas,
      durationHours,
      expiresAt: new Date(override.expiresAt).toISOString(),
    });
    sendJson(res, 200, { ok: true, override: { minReplicas, expiresAt: new Date(override.expiresAt).toISOString() } });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

export function startWebPanel(config, state, log) {
  const { port, user, password } = config.webPanel;

  const server = http.createServer(async (req, res) => {
    if (!isAuthorized(req, user, password)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="railway-autoscaler", charset="UTF-8"',
        "Content-Type": "text/plain",
      });
      res.end("Authentication required");
      return;
    }

    try {
      if (req.url?.startsWith("/api/")) {
        await handleApi(req, res, config, state, log);
        return;
      }
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PANEL_HTML);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      log("web_panel_error", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    }
  });

  server.listen(port, () => {
    log("web_panel_started", { port });
  });

  return server;
}

const PANEL_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Railway Autoscaler</title>
<style>
  :root {
    --bg: #0e1116; --panel: #171c24; --border: #2a3140; --text: #e6e9ef;
    --muted: #8b94a7; --accent: #7c5cff; --ok: #3fb27f; --warn: #e0a63f; --bad: #e05c5c;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; border: 1px solid var(--border); margin-left: 8px; vertical-align: 2px; }
  .badge.dry { color: var(--warn); border-color: var(--warn); }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  .section { margin-top: 32px; }
  .section h2 { font-size: 14px; color: var(--muted); font-weight: 500; margin: 0 0 8px; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  input, select, button { font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
  input:focus, select:focus { outline: 1px solid var(--accent); }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.small { padding: 2px 8px; font-size: 12px; }
  #msg { margin-top: 8px; font-size: 13px; min-height: 20px; }
  .rep { font-size: 11px; color: var(--muted); white-space: nowrap; }
  ul.audit { list-style: none; padding: 0; margin: 0; font-size: 12px; color: var(--muted); }
  ul.audit li { padding: 2px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Railway Autoscaler <span id="dryBadge"></span></h1>
  <div class="sub" id="meta">Loading…</div>

  <table>
    <thead>
      <tr>
        <th>Service</th><th>Region</th><th>Replicas</th><th>CPU</th><th>Mem</th>
        <th>Min / Max</th><th>Last decision</th><th>Override</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

  <div class="section">
    <h2>Scaling history (only actual up/down events)</h2>
    <table>
      <thead>
        <tr><th>When</th><th>Service</th><th>Region</th><th>Change</th><th>Reason</th></tr>
      </thead>
      <tbody id="scalingLog"><tr><td colspan="5" class="muted">No scaling events yet.</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2>Add override (temporarily raise the minimum replica floor)</h2>
    <form id="overrideForm">
      <label>Service / region
        <select id="targetSelect"></select>
      </label>
      <label>min replicas
        <input id="minReplicas" type="number" min="1" step="1" value="2" style="width:90px">
      </label>
      <label>duration (hours)
        <input id="durationHours" type="number" min="0.25" step="0.25" value="2" style="width:90px">
      </label>
      <button class="primary" type="submit">Apply</button>
    </form>
    <div id="msg"></div>
  </div>

  <div class="section">
    <h2>Recent override activity</h2>
    <ul class="audit" id="audit"><li class="muted">None yet.</li></ul>
  </div>
</div>

<script>
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (v) => (v == null ? '<span class="muted">n/a</span>' : v.toFixed(1) + "%");
  const ago = (iso) => {
    if (!iso) return "never";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    return s < 90 ? s + "s ago" : Math.round(s / 60) + "m ago";
  };
  const remaining = (sec) => sec >= 5400 ? (sec / 3600).toFixed(1) + "h" : Math.ceil(sec / 60) + "m";

  let currentRows = [];

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
    return body;
  }

  function render(data) {
    currentRows = data.rows;
    document.getElementById("dryBadge").innerHTML = data.dryRun ? '<span class="badge dry">DRY RUN</span>' : "";
    document.getElementById("meta").textContent =
      "last cycle: " + ago(data.lastCycleAt) + " · poll every " + data.pollIntervalSeconds + "s · cooldown " +
      data.cooldownSeconds + "s · panel started " + new Date(data.startedAt).toLocaleString();

    document.getElementById("rows").innerHTML = data.rows.map((r) => {
      const l = r.latest;
      const action = !l ? '<span class="muted">no data yet</span>'
        : l.action === "up" ? '<span class="warn">up → ' + l.desiredReplicas + "</span>"
        : l.action === "down" ? '<span class="ok">down → ' + l.desiredReplicas + "</span>"
        : '<span class="muted">' + esc(l.reason) + "</span>";
      const override = r.override
        ? '<span class="warn">min ' + r.override.minReplicas + " for " + remaining(r.override.remainingSeconds) + "</span> " +
          '<button class="small" onclick="removeOverride(\\'' + esc(r.serviceId) + '\\',\\'' + esc(r.region) + '\\')">cancel</button>'
        : '<span class="muted">—</span>';
      // Aggregate first; with 2+ replicas each replica's own usage below it.
      const perReplica = (key) => (l && l.replicaMetrics
        ? l.replicaMetrics.map((rm) => '<div class="rep">' + esc(rm.instanceId) + " " + pct(rm[key]) + "</div>").join("")
        : "");
      return "<tr><td>" + esc(r.label) + "</td><td>" + esc(r.region) + "</td>" +
        "<td>" + (l ? l.currentReplicas : '<span class="muted">?</span>') + "</td>" +
        "<td>" + pct(l && l.cpuPct) + perReplica("cpuPct") + "</td>" +
        "<td>" + pct(l && l.memPct) + perReplica("memPct") + "</td>" +
        "<td>" + r.minReplicas + " / " + r.maxReplicas + "</td>" +
        "<td>" + action + (l ? ' <span class="muted">(' + ago(l.at) + ")</span>" : "") + "</td>" +
        "<td>" + override + "</td></tr>";
    }).join("");

    document.getElementById("scalingLog").innerHTML = data.scalingLog.length
      ? data.scalingLog.map((s) => {
          const dir = s.to > s.from
            ? '<span class="warn">' + s.from + " → " + s.to + " (up)</span>"
            : '<span class="ok">' + s.from + " → " + s.to + " (down)</span>";
          const dry = s.dryRun ? ' <span class="badge dry">DRY RUN</span>' : "";
          return "<tr><td>" + new Date(s.at).toLocaleString() + "</td><td>" + esc(s.label) + "</td>" +
            "<td>" + esc(s.region) + "</td><td>" + dir + dry + "</td>" +
            '<td class="muted">' + esc(s.reason || "") + "</td></tr>";
        }).join("")
      : '<tr><td colspan="5" class="muted">No scaling events yet.</td></tr>';

    const select = document.getElementById("targetSelect");
    const selected = select.value;
    select.innerHTML = data.rows.map((r, i) =>
      '<option value="' + i + '">' + esc(r.label) + " [" + esc(r.region) + "]</option>").join("");
    if (selected) select.value = selected;

    document.getElementById("audit").innerHTML = data.auditLog.length
      ? data.auditLog.map((a) => "<li>" + new Date(a.at).toLocaleString() + " · " + esc(a.action) + " · " +
          esc(a.key.replace("::", " [")) + "] min=" + a.minReplicas + "</li>").join("")
      : '<li class="muted">None yet.</li>';
  }

  async function refresh() {
    try {
      render(await api("/api/state"));
    } catch (err) {
      document.getElementById("meta").textContent = "Failed to load state: " + err.message;
    }
  }

  document.getElementById("overrideForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("msg");
    const row = currentRows[Number(document.getElementById("targetSelect").value)];
    if (!row) return;
    try {
      await api("/api/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: row.serviceId,
          region: row.region,
          minReplicas: Number(document.getElementById("minReplicas").value),
          durationHours: Number(document.getElementById("durationHours").value),
        }),
      });
      msg.innerHTML = '<span class="ok">Override set. It takes effect on the next poll cycle.</span>';
      refresh();
    } catch (err) {
      msg.innerHTML = '<span class="bad">' + esc(err.message) + "</span>";
    }
  });

  async function removeOverride(serviceId, region) {
    try {
      await api("/api/override", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId, region }),
      });
      refresh();
    } catch (err) {
      document.getElementById("msg").innerHTML = '<span class="bad">' + esc(err.message) + "</span>";
    }
  }

  refresh();
  setInterval(refresh, 10000);
</script>
</body>
</html>`;

import { exec, home } from "herdr";

const LOG_LINES = 1000;
const TRACE_LIMIT = 100;
const SQL_DIFF_CONCURRENCY = 4;

export function errorText(error) {
  return error?.message ?? String(error);
}

export function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 300);
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function asText(value, fallback = "") {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: the response is not JSON (${firstLine(text) || "empty"})`);
  }
}

async function request(dashboard, path, options) {
  if (!dashboard) throw Object.assign(new Error("Orbit reports no dashboard for this instance"), { unreachable: true });
  let response;
  try {
    response = await fetch(`${dashboard}${path}`, options);
  } catch (error) {
    const unreachable = new Error(`Orbit daemon unreachable at ${dashboard}: ${errorText(error)}`);
    throw Object.assign(unreachable, { unreachable: true });
  }
  const text = await response.text();
  const body = text.trim() ? parseJson(text, path) : {};
  const reported = asText(asObject(body).error);
  if (!response.ok || reported) throw new Error(reported || `${path}: HTTP ${response.status}`);
  return body;
}

function getJson(dashboard, path) {
  return request(dashboard, path, undefined);
}

function postJson(dashboard, path) {
  return request(dashboard, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

function parseHealth(raw) {
  const health = asObject(raw);
  const attempts = asNumber(health.attempts);
  const max = asNumber(health.max_retries);
  return attempts || max ? `${attempts}/${max}` : "";
}

function parseSidecars(raw) {
  return asArray(raw).map(asObject).filter((one) => asText(one.url)).map((one) => ({ name: asText(one.name, "sidecar"), url: asText(one.url) }));
}

function byKindAndName(a, b) {
  return a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "service" ? -1 : b.kind === "service" ? 1 : a.kind.localeCompare(b.kind);
}

export function sortResources(resources) {
  return [...resources].sort(byKindAndName);
}

export function parseResource(raw) {
  const r = asObject(raw);
  return {
    name: asText(r.name, "?"), kind: asText(r.kind), role: asText(r.role), state: asText(r.state, "unknown"),
    phase: asText(r.starting_phase), logs: r.logs_available === true, restarts: asNumber(r.restart_count),
    ports: Object.entries(asObject(r.ports)).map(([key, value]) => `${key} ${asText(value)}`),
    url: asText(r.url), uptime: asText(r.uptime), startup: asText(r.startup_time), image: asText(r.image),
    health: parseHealth(r.health_progress), sidecars: parseSidecars(r.sidecars),
  };
}

function envName(context, configPath) {
  const name = asText(context.display_name) || asText(context.name);
  if (name) return name;
  return configPath.split("/").pop()?.replace(/\.ya?ml$/, "") || "unknown";
}

export function parseDaemonStatus(raw) {
  const body = asObject(raw);
  const context = asObject(body.context);
  const managed = asObject(context.managed_selection);
  const configPath = asText(body.config_path) || asText(context.config_path);
  const selected = managed.active === false ? asText(managed.name) : "";
  return {
    source: "daemon", env: envName(context, configPath), configPath, selected, error: "",
    resources: sortResources(asArray(body.resources).map(parseResource)),
  };
}

export async function loadDaemonStatus(dashboard) {
  return parseDaemonStatus(await getJson(dashboard, "/api/status"));
}

// cwd is HOME so Orbit never picks up a project's orbit.yaml: the default runtime is then the
// environment selected with `orbit switch`, the one its daemon runs.
async function runOrbit(args) {
  const options = { cwd: home() };
  try {
    return await exec("orbit", args, options);
  } catch {
    return exec(`${home()}/.local/bin/orbit`, args, options);
  }
}

async function orbitJson(args) {
  const ran = await runOrbit(args);
  const text = ran.stdout.trim();
  if (!text) throw new Error(firstLine(ran.stderr) || `orbit ${args.join(" ")} exited ${ran.code}`);
  return asObject(parseJson(text, `orbit ${args.join(" ")}`));
}

function cliError(body) {
  const error = asObject(body.error);
  const message = asText(error.message) || "orbit status failed";
  const hint = asText(error.hint);
  return hint ? `${message}\n${hint}` : message;
}

async function orbitData(args) {
  const body = await orbitJson(args);
  if (body.ok === true) return asObject(body.data);
  throw Object.assign(new Error(cliError(body)), { code: asText(asObject(body.error).code) });
}

/** `--instance` for a named instance, `-c` for both, so every call reaches the same runtime. */
export function targetArgs(instance) {
  if (!instance) return [];
  return [...(instance.name ? ["--instance", instance.name] : []), ...(instance.configPath ? ["-c", instance.configPath] : [])];
}

function countsOf(states) {
  if (!states || typeof states !== "object") return { up: null, total: null };
  const entries = Object.entries(states).map(([state, n]) => [state, asNumber(n)]);
  return {
    up: entries.filter(([state]) => state !== "stopped").reduce((sum, [, n]) => sum + n, 0),
    total: entries.reduce((sum, [, n]) => sum + n, 0),
  };
}

function parseDefaultInstance(data) {
  const daemon = asObject(data.daemon);
  const env = asObject(data.environment);
  return {
    name: "", env: asText(env.selected_name), daemon: daemon.running === true, dashboard: asText(daemon.dashboard),
    configPath: asText(env.selected_path), up: null, total: null,
  };
}

function parseNamedInstance(raw) {
  const one = asObject(raw);
  return {
    name: asText(one.name), env: asText(one.environment), daemon: asText(one.state) === "running", dashboard: asText(one.dashboard),
    configPath: asText(one.config_path), ...countsOf(one.resource_states),
  };
}

/** The default runtime (from `inspect`) followed by every named `--instance`; never throws. */
export async function loadInstances() {
  const [inspect, named] = await Promise.all([
    orbitData(["inspect", "--json"]).catch(() => ({})),
    orbitData(["instance", "list", "--json"]).catch(() => ({})),
  ]);
  const instances = asArray(named.instances).map(parseNamedInstance).filter((one) => one.name);
  return [parseDefaultInstance(inspect), ...instances];
}

async function inspectedEnv(instance) {
  const body = await orbitJson([...targetArgs(instance), "inspect", "--json"]).catch(() => ({}));
  return asText(asObject(asObject(body.data).environment).selected_name);
}

export async function loadCliStatus(instance) {
  const body = await orbitJson([...targetArgs(instance), "status", "--json"]);
  const data = asObject(body.data);
  const env = asText(asObject(data.environment).selected_name);
  const resources = sortResources(asArray(data.resources).map((raw) => ({ ...parseResource(raw), state: asText(asObject(raw).state) || "stopped" })));
  if (body.ok === true) return { source: "cli", env: env || "unknown", configPath: "", selected: "", error: "", resources };
  return { source: "cli", env: env || (await inspectedEnv(instance)) || instance?.env || "unknown", configPath: "", selected: "", error: cliError(body), resources };
}

export async function loadLogs(dashboard, name) {
  const body = asObject(await getJson(dashboard, `/api/logs/${encodeURIComponent(name)}?lines=${LOG_LINES}`));
  return asArray(body.lines).map((line) => asText(line, JSON.stringify(line)));
}

function parseTraceSummary(raw) {
  const r = asObject(raw);
  return {
    id: asText(r.traceId), rootService: asText(r.rootService, "?"), rootName: asText(r.rootName), start: asNumber(r.startUnixNano),
    durationMs: asNumber(r.durationMs), spanCount: asNumber(r.spanCount), services: asArray(r.services).map((one) => asText(one)),
    status: asText(r.status, "unset"),
  };
}

function parseSpan(raw) {
  const r = asObject(raw);
  return {
    id: asText(r.spanId), parentId: asText(r.parentId), service: asText(r.service, "?"), name: asText(r.name), kind: asText(r.kind),
    start: asNumber(r.startUnixNano), durationMs: asNumber(r.durationMs), status: asText(r.status, "unset"),
    attributes: Object.entries(asObject(r.attributes)).map(([key, value]) => [key, asText(value, JSON.stringify(value))]),
  };
}

export async function loadTraces(dashboard, includeHealth) {
  const query = includeHealth ? `limit=${TRACE_LIMIT}&include_health=1` : `limit=${TRACE_LIMIT}`;
  const body = await getJson(dashboard, `/api/traces?${query}`);
  return asArray(body).map(parseTraceSummary).filter((one) => one.id);
}

export async function loadTrace(dashboard, id) {
  const body = asObject(await getJson(dashboard, `/api/traces/${encodeURIComponent(id)}`));
  return { ...parseTraceSummary(body), spans: asArray(body.spans).map(parseSpan) };
}

export async function loadTraceLogs(dashboard, id) {
  const body = asObject(await getJson(dashboard, `/api/traces/${encodeURIComponent(id)}/logs`));
  return asArray(body.lines).map(asObject).map((one) => `[${asText(one.service, "?")}] ${asText(one.line)}`);
}

export async function runAction(dashboard, action, name) {
  if (action !== "restart" && action !== "stop") throw new Error(`unknown action ${action}`);
  await postJson(dashboard, `/api/${action}/${encodeURIComponent(name)}`);
}

/**
 * Stops the instance's containers and services, then its daemon. `daemon stop` alone leaves the
 * containers running with nothing supervising them.
 */
export async function stopDaemon(instance) {
  const target = targetArgs(instance);
  await orbitData([...target, "down", "--json"]);
  await orbitData([...target, "daemon", "stop", "--json"]);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await fn(items[at]);
    }
  });
  await Promise.all(workers);
  return results;
}

function sqlFromDiff(target, data) {
  if (data.in_sync === true) return { ...target, status: "in-sync", detail: "In sync" };
  const files = asArray(data.file_changes).length;
  const detail = files
    ? `${files} file${files === 1 ? "" : "s"} changed since publish`
    : `+${asNumber(data.created)} ~${asNumber(data.altered)} -${asNumber(data.dropped)}`;
  return { ...target, status: "changed", detail };
}

/**
 * Each database of the environment's SQL projects, or null when the environment has no SQL Server
 * workflow. Only databases with a publish record get `sqlserver diff`: on one Orbit never published
 * it runs the full SqlPackage comparison (seconds each).
 */
export async function loadSql(instance) {
  const target = targetArgs(instance);
  let data;
  try {
    data = await orbitData([...target, "sqlserver", "list", "--json"]);
  } catch (error) {
    if (error?.code === "not_configured") return null;
    throw error;
  }
  const databases = asArray(data.projects).map(asObject)
    .flatMap((project) => asArray(project.databases).map((db) => ({ project: asText(project.name), db: asText(db) })));
  const published = Array.isArray(data.publish_records)
    ? new Set(data.publish_records.map(asObject).filter((one) => one.last_publish != null).map((one) => asText(one.database)))
    : null;
  return mapLimit(databases, SQL_DIFF_CONCURRENCY, async (one) => {
    if (!published) return { ...one, status: "unknown", detail: "Needs Orbit 0.16.10 or later" };
    if (!published.has(one.db)) return { ...one, status: "not-published", detail: "Not published" };
    try {
      return sqlFromDiff(one, await orbitData([...target, "sqlserver", "diff", one.db, "--json"]));
    } catch (error) {
      return { ...one, status: "unknown", detail: errorText(error) };
    }
  });
}

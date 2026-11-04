import { loadInstances, loadDaemonStatus, loadCliStatus, loadLogs, loadTraces, loadTrace, loadTraceLogs, loadSql, runAction, stopDaemon, errorText } from "./api.js";
import { askAgent, logsPrompt, tracePrompt } from "./ask.js";
import { dockBeside } from "./dock.js";
import { isErrorTrace } from "./model.js";

const CLI_RETRY_MS = 15_000;
const INSTANCES_MS = 15_000;
export const CONFIRM_MS = 6_000;
const NEEDS_DAEMON = "Needs the running Orbit daemon (start it with orbit up).";

export const EMPTY_STATUS = { source: "loading", env: "", configPath: "", selected: "", error: "", resources: [], at: 0 };
export const EMPTY_LOGS = { name: "", lines: [], error: "", loading: false, at: 0 };
export const EMPTY_TRACES = { list: [], error: "", loading: false, at: 0 };
export const EMPTY_SQL = { list: [], configured: true, live: false, error: "", loading: false, at: 0 };

export function isLive(panel) {
  return panel.state.status.source === "daemon";
}

/** The instance the panel shows; the default runtime when the saved one is gone. */
export function currentInstance(panel) {
  const { instances, instance } = panel.state;
  return instances.find((one) => one.name === instance) ?? instances.find((one) => one.name === "") ?? null;
}

export function dashboardOf(panel) {
  return currentInstance(panel)?.dashboard ?? "";
}

/**
 * Each instance switch bumps `panel.generation`; a load started before it must not write its
 * result into the instance shown now (A -> B -> A included), and a closed copy takes nothing.
 */
function isCurrent(panel, generation) {
  return !panel.closed && panel.generation === generation;
}

async function cliStatus(panel, instance, isForced) {
  const { status } = panel.state;
  if (!isForced && status.source === "cli" && Date.now() - status.at < CLI_RETRY_MS) return null;
  try {
    return await loadCliStatus(instance);
  } catch (error) {
    const resources = status.resources.map((one) => ({ ...one, state: "stopped" }));
    return { ...EMPTY_STATUS, source: "none", env: status.env || instance?.env || "", resources, error: `orbit status --json failed: ${errorText(error)}` };
  }
}

async function readStatus(panel, instance, isForced) {
  try {
    return await loadDaemonStatus(instance?.dashboard ?? "");
  } catch (error) {
    if (!error?.unreachable) return { ...panel.state.status, source: "daemon", error: `Status unreadable: ${errorText(error)}` };
  }
  return cliStatus(panel, instance, isForced);
}

// Each tick asks the shown instance's dashboard (one local HTTP call). The instance list (two CLI
// processes) is re-read every INSTANCES_MS, on a forced refresh, and on every tick while the shown
// instance has no dashboard: a stopped daemon reports none, so that is how a start is noticed.
export function refreshStatus(panel, cx, isForced) {
  if (panel.state.loadingStatus) return;
  const { generation } = panel;
  const needsInstances = isForced || !dashboardOf(panel) || Date.now() - panel.instancesAt > INSTANCES_MS;
  panel.set({ loadingStatus: true });
  cx.spawn(async (cx) => {
    try {
      if (needsInstances) {
        const instances = await loadInstances();
        if (!isCurrent(panel, generation)) return;
        panel.instancesAt = Date.now();
        panel.set({ instances });
      }
      const status = await readStatus(panel, currentInstance(panel), isForced);
      if (isCurrent(panel, generation) && status) panel.set({ status: { ...status, at: Date.now() } });
    } catch (error) {
      if (isCurrent(panel, generation)) panel.set({ message: `Could not read Orbit: ${errorText(error)}` });
    } finally {
      if (isCurrent(panel, generation)) {
        panel.set({ loadingStatus: false });
        cx.notify();
      }
    }
  });
}

/** Whether the SQL rows were read with a different daemon state than now, or too long ago. */
export function isSqlStale(panel, maxAgeMs) {
  const { sql, status } = panel.state;
  if (sql.loading || status.source === "loading") return false;
  return sql.at === 0 || sql.live !== isLive(panel) || (isLive(panel) && Date.now() - sql.at > maxAgeMs);
}

export function reloadSql(panel, cx) {
  // Whether to diff depends on the daemon, which is unknown until the status has been read.
  if (panel.state.sql.loading || panel.state.status.source === "loading") return;
  const instance = currentInstance(panel);
  if (!instance) return;
  const { generation } = panel;
  const live = isLive(panel);
  // `orbit sqlserver list` itself fails while the runtime is stopped, so nothing runs then.
  if (!live) {
    panel.set({ sql: { ...EMPTY_SQL, live, at: Date.now() } });
    return;
  }
  panel.set({ sql: { ...panel.state.sql, loading: true } });
  cx.spawn(async (cx) => {
    try {
      const list = await loadSql(instance);
      if (isCurrent(panel, generation)) panel.set({ sql: { list: list ?? [], configured: list !== null, live, error: "", loading: false, at: Date.now() } });
    } catch (error) {
      if (isCurrent(panel, generation)) panel.set({ sql: { ...panel.state.sql, live, loading: false, error: `SQL: ${errorText(error)}`, at: Date.now() } });
    } finally {
      if (!panel.closed) cx.notify();
    }
  });
}

export function selectedResource(panel) {
  const { resources } = panel.state.status;
  return resources.find((one) => one.name === panel.state.selected) ?? null;
}

export function moveSelection(panel, step) {
  const { resources } = panel.state.status;
  if (resources.length === 0) return;
  const at = resources.findIndex((one) => one.name === panel.state.selected);
  const next = at < 0 ? 0 : Math.max(0, Math.min(resources.length - 1, at + step));
  panel.set({ selected: resources[next].name, confirm: null });
}

// Called from inside cx.spawn, where timers are not allowed: the second scroll waits with sleep,
// after the new rows have been laid out.
async function scrollLogsDown(panel, before, after, cx) {
  // A busy resource stays at the line limit, so a new last line, not a new length, means new output.
  if (!panel.state.follow || (after.length === before.length && after.at(-1) === before.at(-1))) return;
  panel.logScroll.scroll_to_bottom();
  await cx.sleep(60);
  if (!panel.closed) panel.logScroll.scroll_to_bottom();
}

export function reloadLogs(panel, cx) {
  const name = panel.state.logResource;
  const { logs } = panel.state;
  if (!name || logs.loading || panel.state.status.source === "loading") return;
  if (!isLive(panel)) {
    panel.set({ logs: { ...EMPTY_LOGS, name } });
    return;
  }
  const previous = logs.name === name ? logs.lines : [];
  panel.set({ logs: { ...logs, name, lines: previous, loading: true } });
  const { generation } = panel;
  const dashboard = dashboardOf(panel);
  cx.spawn(async (cx) => {
    try {
      const lines = await loadLogs(dashboard, name);
      if (!isCurrent(panel, generation)) return;
      // Another resource was picked meanwhile: only clear the loading flag if this load still owns it.
      if (panel.state.logResource !== name) {
        if (panel.state.logs.name === name) panel.set({ logs: { ...panel.state.logs, loading: false } });
        return;
      }
      panel.set({ logs: { name, lines, error: "", loading: false, at: Date.now() } });
      cx.notify();
      await scrollLogsDown(panel, previous, lines, cx);
    } catch (error) {
      if (!isCurrent(panel, generation) || panel.state.logs.name !== name) return;
      const failed = panel.state.logResource === name ? `Logs for ${name}: ${errorText(error)}` : panel.state.logs.error;
      panel.set({ logs: { ...panel.state.logs, loading: false, error: failed } });
    } finally {
      if (!panel.closed) cx.notify();
    }
  });
}

export function reloadTraces(panel, cx) {
  const { traces, includeHealth } = panel.state;
  if (traces.loading || panel.state.status.source === "loading") return;
  if (!isLive(panel)) {
    panel.set({ traces: EMPTY_TRACES });
    return;
  }
  panel.set({ traces: { ...traces, loading: true } });
  const { generation } = panel;
  const dashboard = dashboardOf(panel);
  cx.spawn(async (cx) => {
    try {
      const list = await loadTraces(dashboard, includeHealth);
      if (isCurrent(panel, generation)) panel.set({ traces: { list, error: "", loading: false, at: Date.now() } });
    } catch (error) {
      if (isCurrent(panel, generation)) panel.set({ traces: { ...panel.state.traces, loading: false, error: `Traces: ${errorText(error)}` } });
    } finally {
      if (!panel.closed) cx.notify();
    }
  });
}

export function shownTraces(panel) {
  const { list } = panel.state.traces;
  return panel.state.errorsOnly ? list.filter(isErrorTrace) : list;
}

export function openTrace(panel, id, cx) {
  if (!id) return;
  panel.set({ trace: { id, detail: null, logs: [], error: "", loading: true }, traceCursor: id });
  cx.notify();
  const { generation } = panel;
  const dashboard = dashboardOf(panel);
  const isShown = () => isCurrent(panel, generation) && panel.state.trace?.id === id;
  cx.spawn(async (cx) => {
    try {
      const [detail, logs] = await Promise.all([loadTrace(dashboard, id), loadTraceLogs(dashboard, id).catch((error) => [`(trace logs unavailable: ${errorText(error)})`])]);
      if (!isShown()) return;
      panel.set({ trace: { id, detail, logs, error: "", loading: false } });
    } catch (error) {
      if (isShown()) panel.set({ trace: { id, detail: null, logs: [], error: `Trace ${id.slice(0, 8)}: ${errorText(error)}`, loading: false } });
    } finally {
      if (!panel.closed) cx.notify();
    }
  });
}

export function moveTraceCursor(panel, step) {
  const list = shownTraces(panel);
  if (list.length === 0) return;
  const at = list.findIndex((one) => one.id === panel.state.traceCursor);
  const next = at < 0 ? 0 : Math.max(0, Math.min(list.length - 1, at + step));
  panel.set({ traceCursor: list[next].id });
}

/**
 * Two-press confirmation: the first press arms `confirm` ({ action, name }), a second press of the
 * same action and name within CONFIRM_MS runs it. Only called from event handlers (it sets a timer).
 */
function armOrRun(panel, action, name, cx) {
  const { confirm } = panel.state;
  if (confirm && confirm.action === action && confirm.name === name && Date.now() - confirm.at < CONFIRM_MS) {
    runConfirmed(panel, cx);
    return;
  }
  const at = Date.now();
  panel.set({ confirm: { action, name, at }, message: "" });
  panel.later(CONFIRM_MS, cx, (cx) => {
    if (panel.state.confirm?.at !== at) return;
    panel.set({ confirm: null });
    cx.notify();
  });
}

/** Runs what `confirm` holds: a resource restart/stop, or stopping the shown instance's daemon. */
export function runConfirmed(panel, cx) {
  const { confirm } = panel.state;
  if (!confirm) return;
  if (confirm.action === "daemon") {
    const instance = currentInstance(panel);
    if (instance && (instance.name || "default") === confirm.name) performStopDaemon(panel, instance, cx);
    else panel.set({ confirm: null });
  } else {
    performAction(panel, confirm.action, confirm.name, cx);
  }
}

export function requestAction(panel, action, cx) {
  const row = selectedResource(panel);
  if (!row) return panel.set({ message: "Select a resource first." });
  if (panel.state.acting) return panel.set({ message: `Wait for ${panel.state.acting} to finish.` });
  if (!isLive(panel)) return panel.set({ message: `${action === "restart" ? "Restart" : "Stop"}: ${NEEDS_DAEMON}` });
  armOrRun(panel, action, row.name, cx);
}

/** First press arms, a second within CONFIRM_MS runs `down` + `daemon stop` for the shown instance. */
export function requestStopDaemon(panel, cx) {
  const instance = currentInstance(panel);
  if (!instance || panel.state.acting) return;
  armOrRun(panel, "daemon", instance.name || "default", cx);
}

export function isArmedStopDaemon(panel) {
  const instance = currentInstance(panel);
  const { confirm } = panel.state;
  return Boolean(instance) && confirm?.action === "daemon" && confirm.name === (instance.name || "default");
}

function performStopDaemon(panel, instance, cx) {
  const label = instance.name || "default";
  panel.set({ confirm: null, acting: `daemon:${label}`, message: `Stopping ${label}: orbit down, then daemon stop...` });
  cx.notify();
  const { generation } = panel;
  cx.spawn(async (cx) => {
    let message;
    try {
      await stopDaemon(instance);
      message = `${label} stopped.`;
    } catch (error) {
      message = `Could not stop ${label}: ${errorText(error)}`;
    } finally {
      if (!isCurrent(panel, generation)) return;
      panel.set({ acting: "", message });
      refreshStatus(panel, cx, true);
      cx.notify();
    }
  });
}

function performAction(panel, action, name, cx) {
  panel.set({ confirm: null, acting: name, message: `${action === "restart" ? "Restarting" : "Stopping"} ${name}...` });
  cx.notify();
  const { generation } = panel;
  const dashboard = dashboardOf(panel);
  cx.spawn(async (cx) => {
    let message;
    try {
      await runAction(dashboard, action, name);
      message = `${action === "restart" ? "Restart" : "Stop"} requested for ${name}.`;
    } catch (error) {
      message = `Could not ${action} ${name}: ${errorText(error)}`;
    } finally {
      if (!isCurrent(panel, generation)) return;
      panel.set({ acting: "", message });
      refreshStatus(panel, cx, true);
      cx.notify();
    }
  });
}

function runAsk(panel, cx, build) {
  if (panel.state.asking) return;
  panel.set({ asking: true, message: "" });
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const { title, text } = build();
      const result = await askAgent(panel.state.status.env || "local", title, text);
      await dockBeside(result, cx, "orbit");
    } catch (error) {
      panel.set({ message: `Could not ask the agent: ${errorText(error)}` });
    } finally {
      if (panel.closed) return;
      panel.set({ asking: false });
      cx.notify();
    }
  });
}

export function askLogs(panel, cx) {
  const { logs, filter } = panel.state;
  const lines = panel.shownLogLines();
  if (!logs.name || lines.length === 0) return panel.set({ message: "No log lines to send." });
  runAsk(panel, cx, () => ({ title: `${logs.name} logs`, text: logsPrompt(panel.state.status.env, logs.name, lines, filter) }));
}

export function askTrace(panel, cx) {
  const trace = panel.state.trace;
  if (!trace?.detail) return panel.set({ message: "Open a trace first." });
  runAsk(panel, cx, () => ({
    title: `trace ${trace.id.slice(0, 8)}`,
    text: tracePrompt(panel.state.status.env, trace.detail, trace.logs),
  }));
}

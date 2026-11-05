const HEALTHY = new Set(["healthy", "running", "ready"]);
const STARTING = new Set(["starting", "building", "pending", "probing", "restarting", "stopping"]);
const UNHEALTHY = new Set(["unhealthy", "degraded", "failed", "error", "crashed", "exited", "port_conflict", "blocked"]);
const ERROR_WORDS = /\b(fail|error|crit|fatal|exception|unhandled)\b|\berr\b/i;
const WARN_WORDS = /\b(warn|warning)\b/i;

export function stateTone(state) {
  const value = String(state ?? "").toLowerCase();
  if (HEALTHY.has(value)) return "healthy";
  if (STARTING.has(value)) return "starting";
  if (UNHEALTHY.has(value)) return "unhealthy";
  return "stopped";
}

export function countTones(resources) {
  return resources.reduce((counts, one) => ({ ...counts, [stateTone(one.state)]: (counts[stateTone(one.state)] ?? 0) + 1 }), {});
}

export function lineTone(line) {
  if (ERROR_WORDS.test(line)) return "error";
  if (WARN_WORDS.test(line)) return "warning";
  return "";
}

export function filterLines(lines, filter) {
  const wanted = filter.trim().toLowerCase();
  return wanted ? lines.filter((line) => line.toLowerCase().includes(wanted)) : lines;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function clockOf(unixNano) {
  if (!unixNano) return "--:--:--";
  return new Date(unixNano / 1e6).toTimeString().slice(0, 8);
}

export function clock(ms) {
  return ms ? new Date(ms).toTimeString().slice(0, 8) : "never";
}

/** "5m ago" style age of a past time in ms, or "" when unknown. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function isErrorTrace(trace) {
  return trace.status === "error";
}

function depthOf(span, byId) {
  const seen = new Set();
  let depth = 0;
  let current = span;
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function waterfall(trace) {
  const spans = [...trace.spans].sort((a, b) => a.start - b.start);
  const byId = new Map(spans.map((span) => [span.id, span]));
  const origin = spans.length ? Math.min(trace.start || spans[0].start, spans[0].start) : trace.start;
  const total = Math.max(trace.durationMs, ...spans.map((span) => (span.start - origin) / 1e6 + span.durationMs), 0.001);
  return spans.map((span) => {
    const offset = Math.min(Math.max((span.start - origin) / 1e6 / total, 0), 1);
    const width = Math.min(Math.max(span.durationMs / total, 0.008), 1 - offset);
    return { span, depth: depthOf(span, byId), offset, width, offsetMs: (span.start - origin) / 1e6 };
  });
}

export function serviceColor(t, service) {
  const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi12, t.ansi13, t.ansi14];
  const hash = [...service].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  return palette[hash % palette.length];
}

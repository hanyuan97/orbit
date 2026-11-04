import * as fs from "fs/promises";
import { appHome, writeTextFile } from "herdr";
import { deliver, loadTargetName } from "./target.js";
import { waterfall, formatMs, clockOf } from "./model.js";

const SECTION_LIMIT = 12000;
const INLINE_LIMIT = 400;
const ATTRIBUTE_LIMIT = 30;

function clip(text, keep) {
  const body = text.trim() || "(empty)";
  if (body.length <= SECTION_LIMIT) return body;
  return keep === "tail" ? `...(clipped)\n${body.slice(-SECTION_LIMIT)}` : `${body.slice(0, SECTION_LIMIT)}\n...(clipped)`;
}

function fenced(title, text, keep) {
  return ["", `## ${title}`, "```", clip(text, keep), "```"];
}

export function logsPrompt(env, resource, lines, filter) {
  return [
    `These are the last ${lines.length} log lines of ${resource} in the local Orbit dev environment ${env}${filter ? ` (filtered by "${filter}")` : ""}.`,
    "Find errors or anomalies, say what likely causes them, and suggest the next check or code change.",
    "Do not restart, stop or reconfigure Orbit resources unless asked.",
    ...fenced(`${resource} logs`, lines.join("\n"), "tail"),
  ].join("\n");
}

function waterfallText(trace) {
  return waterfall(trace).map((row) => {
    const indent = "  ".repeat(row.depth);
    const mark = row.span.status === "error" ? " ERROR" : "";
    return `${indent}[${row.span.service}] ${row.span.name} ${formatMs(row.span.durationMs)} @+${formatMs(row.offsetMs)} (${row.span.kind || "span"})${mark}`;
  }).join("\n");
}

function errorSpans(trace) {
  return trace.spans.filter((span) => span.status === "error").map((span) => {
    const attributes = span.attributes.slice(0, ATTRIBUTE_LIMIT).map(([key, value]) => `  ${key}: ${value}`);
    return [`[${span.service}] ${span.name}`, ...attributes].join("\n");
  }).join("\n\n");
}

function traceSummary(env, trace) {
  return [
    `env: ${env}`,
    `trace: ${trace.id}`,
    `root: ${trace.rootService} ${trace.rootName}`,
    `status: ${trace.status}`,
    `started: ${clockOf(trace.start)}`,
    `duration: ${formatMs(trace.durationMs)}`,
    `spans: ${trace.spans.length || trace.spanCount}`,
    `services: ${trace.services.join(", ")}`,
  ].join("\n");
}

export function tracePrompt(env, trace, logs) {
  const errors = errorSpans(trace);
  return [
    `This is a distributed trace from the local Orbit dev environment ${env}: summary, span waterfall and the log lines carrying its trace id.`,
    "Explain what the request did, find where and why it failed or was slow, and suggest the code change or next check.",
    "Do not restart, stop or reconfigure Orbit resources unless asked.",
    ...fenced("Summary", traceSummary(env, trace), "head"),
    ...fenced("Waterfall (indent = depth, @+ = offset from trace start)", waterfallText(trace), "head"),
    ...(errors ? fenced("Error span attributes", errors, "head") : []),
    ...fenced("Logs with this trace id", logs.join("\n"), "tail"),
  ].join("\n");
}

function askFolder() {
  return `${appHome()}/data/orbit`;
}

const KEEP_ASK_FILES = 20;

/** Keeps the newest KEEP_ASK_FILES snapshots; older ones were already read by their agent. */
async function pruneAskFiles() {
  const names = (await fs.readdir(askFolder()).catch(() => [])).filter((name) => /^ask-\d+\.md$/.test(name));
  const old = names.sort((a, b) => Number(b.slice(4, -3)) - Number(a.slice(4, -3))).slice(KEEP_ASK_FILES);
  await Promise.all(old.map((name) => fs.unlink(`${askFolder()}/${name}`).catch(() => {})));
}

async function writeAskFile(text) {
  const path = `${askFolder()}/ask-${Date.now()}.md`;
  await fs.mkdir(askFolder(), { recursive: true });
  await writeTextFile(path, text, null);
  await pruneAskFiles();
  return path;
}

async function messageFor(env, title, text) {
  if (text.length <= INLINE_LIMIT && !text.includes("\n")) return text;
  const path = await writeAskFile(text);
  return `Read ${path} (a snapshot of ${title} from the local Orbit env ${env}) and do what it asks.`;
}

export async function askAgent(env, title, text) {
  const message = await messageFor(env, title, text);
  return deliver(loadTargetName(), message, { name: `orbit ${env}/${title}` });
}

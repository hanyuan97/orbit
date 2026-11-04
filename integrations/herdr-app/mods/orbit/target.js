import { terminals, spaces, panes, focused, hc, run, notify, shared, setShared, readTextFile, home } from "herdr";

const STORE_KEY = "orbit.agentTarget";
const ARROW = "\u{2192}";
const DOT = "\u{b7}";

let sessionNames = {};

export function loadTargetName() {
  try {
    const value = shared(STORE_KEY);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export function saveTargetName(name) {
  try {
    setShared(STORE_KEY, name.trim());
    return "";
  } catch (e) {
    return `Could not save the agent name: ${e.message ?? e}`;
  }
}

function liveTerminals() {
  return terminals().filter((one) => one.state === "live" || one.state === undefined);
}

function isClaude(foreground) {
  const program = foreground?.argv?.[0] ?? "";
  return (program.split("/").pop() ?? "").startsWith("claude");
}

async function foregroundOf(address) {
  const ran = await hc(["get", address, "--json"]);
  if (ran.code !== 0) return null;
  try {
    return JSON.parse(ran.stdout).foreground ?? null;
  } catch {
    return null;
  }
}

function parseSessionName(text) {
  if (!text) return null;
  try {
    const name = JSON.parse(text).name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

async function claudeSessionName(address) {
  const foreground = await foregroundOf(address);
  if (!isClaude(foreground) || !foreground.pid) return null;
  const text = await readTextFile(`${home()}/.claude/sessions/${foreground.pid}.json`).catch(() => null);
  return parseSessionName(text);
}

export async function refreshSessionNames() {
  const live = liveTerminals();
  const names = await Promise.all(live.map((one) => claudeSessionName(one.address).catch(() => null)));
  sessionNames = Object.fromEntries(live.map((one, index) => [one.address, names[index]]).filter(([, name]) => name));
  return sessionNames;
}

function labelGroups() {
  const live = liveTerminals();
  const tabNames = new Map(spaces().flatMap((space) => space.tabs.map((tab) => [tab.id, tab.name])));
  return [
    live.map((one) => ({ address: one.address, label: one.name })),
    live.map((one) => ({ address: one.address, label: one.address })),
    live.map((one) => ({ address: one.address, label: sessionNames[one.address] })),
    panes().filter((pane) => pane.terminal).map((pane) => ({ address: pane.terminal, label: tabNames.get(pane.tab) })),
  ];
}

function matches(name) {
  const groups = labelGroups();
  const lower = name.toLowerCase();
  const exact = groups.flatMap((group) => group.filter((one) => one.label === name));
  const loose = groups.flatMap((group) => group.filter((one) => typeof one.label === "string" && one.label.toLowerCase() === lower));
  const all = [...exact, ...loose];
  return all.filter((one, index) => all.findIndex((other) => other.address === one.address) === index);
}

export function candidateAddresses(name) {
  return matches(name).map((one) => one.address);
}

export async function resolveTarget(name) {
  const wanted = name.trim();
  if (!wanted) return { reason: "unset" };
  await refreshSessionNames();
  const found = candidateAddresses(wanted);
  for (const address of found) {
    if (isClaude(await foregroundOf(address))) return { address };
  }
  return { reason: found.length ? "not-claude" : "missing", matched: found };
}

export function focusedPlace() {
  const f = focused();
  const list = spaces();
  const space = list.find((one) => one.id === f?.space) ?? list.find((one) => one.active) ?? null;
  const tabs = new Set(space?.tabs.map((tab) => tab.id) ?? []);
  const all = panes();
  const pane = all.find((one) => one.pane === f?.pane && one.cwd)
    ?? all.find((one) => one.tab === f?.tab && one.cwd)
    ?? all.find((one) => tabs.has(one.tab) && one.cwd);
  return { space: space?.id ?? null, folder: f?.cwd || pane?.cwd || space?.folder || home() };
}

function openSession(text, session) {
  const place = focusedPlace();
  const known = spaces().find((one) => one.id === place.space)?.tabs.map((tab) => tab.id) ?? [];
  run("tab.new", { name: session.name, argv: ["claude"], task: text, folder: place.folder, ...(place.space ? { space: place.space } : {}) });
  return { space: place.space, known };
}

function fallbackBody(name, reason) {
  if (reason === "unset") return "No agent name set: opened a new Claude session.";
  if (reason === "not-claude") return `${name} is not running claude: opened a new session.`;
  return `${name} not found: opened a new Claude session.`;
}

export async function deliver(name, text, session) {
  const target = await resolveTarget(name);
  if (target.address) {
    const ran = await hc(["send", target.address, text]);
    if (ran.code !== 0) throw new Error((ran.stderr || ran.stdout).trim() || `hc send exited ${ran.code}`);
    notify({ title: `Sent to ${name}`, body: target.address, level: "success", timeout: 3000, action: { name: "pane.focus", args: { terminal: target.address } } });
    return { sent: target.address };
  }
  const opened = openSession(text, session);
  notify({ title: session.name, body: fallbackBody(name, target.reason), level: target.reason === "unset" ? "info" : "warning", timeout: 4000 });
  return { opened: true, reason: target.reason, ...opened };
}

export function targetHint(name) {
  const wanted = name.trim();
  if (!wanted) return "";
  const [found] = matches(wanted);
  if (!found) return "not found: new session";
  return found.label === found.address ? `${ARROW} ${found.address}` : `${ARROW} ${found.address} ${DOT} ${found.label}`;
}

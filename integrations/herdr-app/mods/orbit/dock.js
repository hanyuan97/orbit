import { panes, spaces, focused, run, props, closeOverlay } from "herdr";

const WAIT_MS = 250;
const WAIT_TRIES = 24;
const DOCK_WEIGHT = 0.6;

function paneOf(address) {
  return panes().find((pane) => pane.terminal === address) ?? null;
}

function tabIds(spaceId) {
  return spaces().find((one) => one.id === spaceId)?.tabs.map((tab) => tab.id) ?? [];
}

function newTab(spaceId, known) {
  return spaces().find((one) => one.id === spaceId)?.tabs.find((tab) => !known.includes(tab.id)) ?? null;
}

function newSessionPane(opened) {
  const tab = newTab(opened.space, opened.known);
  return tab ? panes().find((pane) => pane.tab === tab.id && pane.terminal) ?? null : null;
}

async function waitFor(find, cx) {
  for (let attempt = 0; attempt < WAIT_TRIES; attempt += 1) {
    const found = find();
    if (found) return found;
    await cx.sleep(WAIT_MS);
  }
  return null;
}

function agentPane(result, cx) {
  if (result.sent) return waitFor(() => paneOf(result.sent), cx);
  if (result.opened && result.space) return waitFor(() => newSessionPane(result), cx);
  return Promise.resolve(null);
}

function modPane(tab, mod) {
  return panes().find((one) => one.tab === tab && one.mod === mod) ?? null;
}

async function splitBeside(host, mod, cx) {
  const existing = modPane(host.tab, mod);
  if (existing) return existing;
  run("pane.split", { pane: host.pane, direction: "right", mod });
  const docked = await waitFor(() => modPane(host.tab, mod), cx);
  if (docked) {
    run("layout.resize", { id: host.pane, weight: 1 });
    run("layout.resize", { id: docked.pane, weight: DOCK_WEIGHT });
  }
  return null;
}

export async function dockBeside(result, cx, mod) {
  const overlay = props()?.overlay;
  if (!overlay || !result) return;
  const pane = await agentPane(result, cx);
  if (pane) {
    await splitBeside(pane, mod, cx);
    run("pane.focus", { pane: pane.pane });
  }
  closeOverlay(overlay);
}

function hostPane() {
  const f = focused();
  const all = panes();
  return all.find((one) => one.pane === f?.pane) ?? all.find((one) => one.tab === f?.tab && one.terminal) ?? null;
}

export async function dockHere(mod, cx) {
  const overlay = props()?.overlay;
  const host = hostPane();
  if (!overlay || !host) return "No pane to dock beside.";
  const existing = await splitBeside(host, mod, cx);
  if (existing) run("pane.focus", { pane: existing.pane });
  closeOverlay(overlay);
  return "";
}

export async function openAsTab(mod, name, cx) {
  const overlay = props()?.overlay;
  const space = focused()?.space;
  if (!overlay || !space) return "No space to open a tab in.";
  const known = tabIds(space);
  run("tab.new", { space, mod, name });
  const tab = await waitFor(() => newTab(space, known), cx);
  if (tab) run("tab.select", { id: tab.id });
  closeOverlay(overlay);
  return tab ? "" : "The new tab did not appear.";
}

export function floatAgain(mod) {
  if (props()?.overlay) return "";
  const own = panes().find((one) => one.mod === mod && one.focused);
  run("mod.open", { name: mod });
  if (own) run("pane.close", { pane: own.pane });
  return "";
}

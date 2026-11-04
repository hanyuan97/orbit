import { v_flex, InputState, VirtualListScrollHandle } from "gpui-base";
import { theme, nextCommand, props, closeOverlay, spaces, panes } from "herdr";
import * as act from "./actions.js";
import { errorText } from "./api.js";
import { loadUiState, saveUiState, TABS } from "./ui-state.js";
import { loadTargetName, saveTargetName, refreshSessionNames } from "./target.js";
import { dockHere, openAsTab, floatAgain } from "./dock.js";
import { shellView } from "./views/shell.js";
import { mono } from "./views/widgets.js";
import { filterLines } from "./model.js";

const STATUS_MS = 3_000;
const TRACES_MS = 5_000;
const FILTER_DELAY_MS = 200;
const NAMES_DELAY_MS = 400;
const SQL_RECHECK_MS = 60_000;
const TAB_KEYS = { 1: "resources", 2: "logs", 3: "traces", 4: "sql" };
const COMMON_KEYS = { r: "refresh", "/": "focusFilter", i: "nextInstance" };

function initialState(ui) {
  return {
    ...ui.value, filter: "", instances: [], status: act.EMPTY_STATUS, loadingStatus: false, logs: act.EMPTY_LOGS, traces: act.EMPTY_TRACES,
    sql: act.EMPTY_SQL,
    trace: null, traceCursor: null, confirm: null, acting: "", asking: false, message: ui.error,
  };
}

export class Panel {
  init(cx) {
    this.state = initialState(loadUiState());
    this.closed = false;
    this.tasks = [];
    this.filterToken = 0;
    this.generation = 0;
    this.instancesAt = 0;
    this.namesToken = 0;
    this.readingNames = false;
    this.logView = null;
    this.handle = cx.focus_handle();
    this.logScroll = VirtualListScrollHandle.new();
    this.makeInputs();
    this.refreshNames(cx);
    act.refreshStatus(this, cx, true);
    this.tasks.push(
      { task: cx.timer.every(STATUS_MS, (cx) => this.tick(cx)), done: false },
      { task: cx.timer.every(TRACES_MS, (cx) => this.traceTick(cx)), done: false },
    );
    // A floating window is a new copy each time it opens; a command loop would keep every closed
    // copy alive (QuickJS heap). Only a docked pane or tab needs commands ("focus" from pane.go).
    if (props()?.overlay) this.later(300, cx, () => this.handle.focus());
    else cx.spawn((cx) => this.commandLoop(cx));
  }

  /** A one-shot timer this copy cancels on close. Only from init or event handlers, never from spawn. */
  later(ms, cx, fn) {
    this.tasks = this.tasks.filter((one) => !one.done);
    const entry = { task: null, done: false };
    entry.task = cx.timer.after(ms, (cx) => { entry.done = true; if (!this.closed) fn(cx); });
    this.tasks.push(entry);
  }

  /** Floating windows are always on screen; a docked copy only while its tab is the active one. */
  isVisible() {
    if (props()?.overlay) return true;
    const tab = spaces().find((one) => one.active)?.tabs.find((one) => one.active);
    return Boolean(tab) && panes().some((one) => one.tab === tab.id && one.mod === "orbit");
  }

  /** Log lines after the filter, worked out once per (lines, filter) pair rather than per render. */
  shownLogLines() {
    const { logs, logResource, filter } = this.state;
    const lines = logs.name === logResource ? logs.lines : [];
    if (this.logView?.lines !== lines || this.logView.filter !== filter) this.logView = { lines, filter, shown: filterLines(lines, filter) };
    return this.logView.shown;
  }

  makeInputs() {
    this.filterInput = InputState.new({ placeholder: "filter lines  /" });
    this.filterInput.on("change", (_e, cx) => this.scheduleFilter(cx));
    this.filterInput.on("submit", (_e, cx) => { this.set({ filter: this.filterInput.value() }); this.handle.focus(); cx.notify(); });
    this.targetInput = InputState.new({ placeholder: "new session", value: loadTargetName() });
    this.targetInput.on("change", (_e, cx) => { this.set({ message: saveTargetName(this.targetInput.value()) }); this.scheduleNames(cx); cx.notify(); });
    this.targetInput.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.typing = new Set();
    [["filter", this.filterInput], ["target", this.targetInput]].forEach(([name, input]) => {
      input.on("focus", () => { this.typing = new Set([...this.typing, name]); });
      input.on("blur", () => { this.typing = new Set([...this.typing].filter((one) => one !== name)); });
    });
  }

  // Reads every live terminal's Claude session name (one `hc get` each), so typing is debounced
  // and only one read runs at a time.
  refreshNames(cx) {
    if (this.readingNames) return;
    this.readingNames = true;
    cx.spawn(async (cx) => {
      await refreshSessionNames().catch((error) => this.set({ message: `Could not read Claude sessions: ${errorText(error)}` }));
      this.readingNames = false;
      if (!this.closed) cx.notify();
    });
  }

  scheduleNames(cx) {
    const token = ++this.namesToken;
    this.later(NAMES_DELAY_MS, cx, (cx) => {
      if (token === this.namesToken) this.refreshNames(cx);
    });
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
  }

  persist() {
    const error = saveUiState(this.state);
    if (error) this.set({ message: error });
  }

  scheduleFilter(cx) {
    const token = ++this.filterToken;
    this.later(FILTER_DELAY_MS, cx, (cx) => {
      if (token !== this.filterToken) return;
      this.set({ filter: this.filterInput.value() });
      cx.notify();
    });
  }

  tick(cx) {
    if (this.closed || !this.isVisible()) return;
    act.refreshStatus(this, cx, false);
    const { tab, follow, logs, logResource } = this.state;
    if (tab === "logs" && !logResource && this.state.status.resources.length) this.ensureLogResource(cx);
    else if (tab === "logs" && (follow || logs.name !== logResource)) act.reloadLogs(this, cx);
    if (tab === "sql" && act.isSqlStale(this, SQL_RECHECK_MS)) act.reloadSql(this, cx);
  }

  switchInstance(name, cx) {
    if (name === act.currentInstance(this)?.name) return;
    this.generation += 1;
    this.set({
      instance: name, logResource: "", status: act.EMPTY_STATUS, loadingStatus: false, logs: act.EMPTY_LOGS, traces: act.EMPTY_TRACES,
      trace: null, traceCursor: null, sql: act.EMPTY_SQL, confirm: null, acting: "", message: "",
    });
    this.persist();
    this.handle.focus();
    act.refreshStatus(this, cx, true);
    cx.notify();
  }

  nextInstance(cx) {
    const { instances } = this.state;
    if (instances.length < 2) return false;
    const at = instances.findIndex((one) => one.name === act.currentInstance(this)?.name);
    this.switchInstance(instances[(at + 1) % instances.length].name, cx);
    return true;
  }

  traceTick(cx) {
    if (this.closed || !this.isVisible()) return;
    if (this.state.tab === "traces" && !this.state.trace) act.reloadTraces(this, cx);
  }

  async commandLoop(cx) {
    while (!this.closed) {
      const command = await nextCommand();
      if (this.closed) return;
      if (command === "focus") this.handle.focus();
      else if (command === "escape") this.escape(cx);
      else if (command === "dock" && props()?.overlay) this.togglePlace(cx);
      else if (command === "float" && !props()?.overlay) this.togglePlace(cx);
      else if (command === "tab") this.openTab(cx);
      else if (command === "refresh") this.refresh(cx);
      else if (TABS.includes(command)) this.setTab(command, cx);
      cx.notify();
    }
  }

  setTab(tab, cx) {
    this.set({ tab, confirm: null, message: "" });
    this.persist();
    this.handle.focus();
    if (tab === "logs") this.ensureLogResource(cx);
    if (tab === "traces" && !this.state.trace) act.reloadTraces(this, cx);
    if (tab === "sql") act.reloadSql(this, cx);
    cx.notify();
  }

  // Entering Logs keeps the last resource only while it runs; otherwise the selected row if it
  // runs, then the first running resource, so the tab rarely opens on an empty stream.
  ensureLogResource(cx) {
    const { resources } = this.state.status;
    const running = (one) => one && one.state !== "stopped";
    const byName = (name) => resources.find((one) => one.name === name);
    const current = byName(this.state.logResource);
    if (!running(current)) {
      const selected = byName(this.state.selected);
      const pick = (running(selected) ? selected : null) ?? resources.find(running) ?? current
        ?? resources.find((one) => one.logs) ?? resources[0];
      if (pick && pick.name !== this.state.logResource) this.set({ logResource: pick.name, logs: { ...act.EMPTY_LOGS, name: pick.name } });
    }
    act.reloadLogs(this, cx);
  }

  pickLogResource(name, cx) {
    this.set({ logResource: name, logs: { ...act.EMPTY_LOGS, name } });
    this.persist();
    this.handle.focus();
    act.reloadLogs(this, cx);
    cx.notify();
  }

  stepLogResource(step, cx) {
    const { resources } = this.state.status;
    if (resources.length === 0) return;
    const at = resources.findIndex((one) => one.name === this.state.logResource);
    const next = resources[(Math.max(at, 0) + step + resources.length) % resources.length];
    this.pickLogResource(next.name, cx);
  }

  logsOf(name, cx) {
    if (!name) { this.set({ message: "Select a resource first." }); return; }
    this.set({ selected: name, logResource: name, logs: { ...act.EMPTY_LOGS, name }, tab: "logs", confirm: null, message: "" });
    this.persist();
    act.reloadLogs(this, cx);
    cx.notify();
  }

  // One click selects the row and shows the side panel; the same row again hides it.
  selectRow(name, cx) {
    const same = name === this.state.selected;
    this.set({ selected: name, panelOpen: same ? !this.state.panelOpen : true, confirm: this.state.confirm?.name === name ? this.state.confirm : null, message: "" });
    this.persist();
    this.handle.focus();
    cx.notify();
  }

  setPanel(open, cx) {
    this.set({ panelOpen: open, confirm: open ? this.state.confirm : null });
    this.persist();
    this.handle.focus();
    cx.notify();
  }

  hide() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  stopDaemon(cx) {
    act.requestStopDaemon(this, cx);
    cx.notify();
  }

  requestAction(action, cx) {
    act.requestAction(this, action, cx);
    cx.notify();
  }

  confirmAction(cx) {
    act.runConfirmed(this, cx);
    cx.notify();
  }

  cancelConfirm(cx) {
    this.set({ confirm: null });
    cx.notify();
  }

  openUrl(url, cx) {
    if (url) cx.open_url(url);
    else this.set({ message: "This resource has no URL." });
  }

  refresh(cx) {
    act.refreshStatus(this, cx, true);
    if (this.state.tab === "logs") act.reloadLogs(this, cx);
    if (this.state.tab === "traces") {
      if (this.state.trace) act.openTrace(this, this.state.trace.id, cx);
      else act.reloadTraces(this, cx);
    }
    if (this.state.tab === "sql") act.reloadSql(this, cx);
    cx.notify();
  }

  toggle(field, cx) {
    this.set({ [field]: !this.state[field] });
    this.persist();
    if (field === "includeHealth") act.reloadTraces(this, cx);
    if (field === "follow" && this.state.follow) { act.reloadLogs(this, cx); this.logScroll.scroll_to_bottom(); }
    cx.notify();
  }

  focusFilter(cx) {
    if (this.state.tab !== "logs") return;
    this.filterInput.focus();
    cx.notify();
  }

  copyLines(text, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.set({ message: `Copied ${text.length} characters.` });
    cx.notify();
  }

  // Both close this copy when they succeed, so the result is only shown if it is still open.
  togglePlace(cx) {
    cx.spawn(async (cx) => {
      const message = props()?.overlay ? await dockHere("orbit", cx) : floatAgain("orbit");
      if (this.closed) return;
      this.set({ message });
      cx.notify();
    });
  }

  openTab(cx) {
    if (!props()?.overlay) return;
    cx.spawn(async (cx) => {
      const message = await openAsTab("orbit", "Orbit", cx);
      if (this.closed) return;
      this.set({ message });
      cx.notify();
    });
  }

  placeKey(e, cx) {
    const { platform, shift, control, alt } = e.modifiers;
    if (!platform || control || alt) return false;
    if (e.key === "enter" && !shift) this.togglePlace(cx);
    else if ((e.key === "t" || e.key === "T") && shift) this.openTab(cx);
    else return false;
    return true;
  }

  onKey(e, cx) {
    if (this.placeKey(e, cx)) { cx.stop_propagation(); return; }
    if (e.modifiers.platform || e.modifiers.control || e.modifiers.alt) return;
    if (e.key === "escape") {
      this.escape(cx);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.typing.size > 0) return;
    const key = e.modifiers.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (this.handleKey(key, cx)) {
      cx.stop_propagation();
      cx.notify();
    }
  }

  handleKey(key, cx) {
    if (TAB_KEYS[key]) { this.setTab(TAB_KEYS[key], cx); return true; }
    const common = COMMON_KEYS[key];
    if (common === "refresh") { this.refresh(cx); return true; }
    if (common === "focusFilter") { this.focusFilter(cx); return this.state.tab === "logs"; }
    if (common === "nextInstance") return this.nextInstance(cx);
    if (this.state.tab === "resources") return this.resourceKey(key, cx);
    if (this.state.tab === "logs") return this.logKey(key, cx);
    if (this.state.tab === "sql") return false;
    return this.traceKey(key, cx);
  }

  resourceKey(key, cx) {
    const row = act.selectedResource(this);
    if (key === "j" || key === "down") act.moveSelection(this, 1);
    else if (key === "k" || key === "up") act.moveSelection(this, -1);
    else if (key === "l") this.logsOf(row?.name, cx);
    else if (key === "o" || key === "enter") this.openUrl(row?.url, cx);
    else if (key === "space" || key === " " || key === "p") this.setPanel(!this.state.panelOpen, cx);
    else if (key === "R") act.requestAction(this, "restart", cx);
    else if (key === "S") act.requestAction(this, "stop", cx);
    else return false;
    if (key === "j" || key === "k" || key === "down" || key === "up") this.persist();
    return true;
  }

  logKey(key, cx) {
    if (key === "f") this.toggle("follow", cx);
    else if (key === "c") act.askLogs(this, cx);
    else if (key === "]") this.stepLogResource(1, cx);
    else if (key === "[") this.stepLogResource(-1, cx);
    else return false;
    return true;
  }

  traceKey(key, cx) {
    if (key === "e") this.toggle("errorsOnly", cx);
    else if (key === "h") this.toggle("includeHealth", cx);
    else if (key === "c") act.askTrace(this, cx);
    else if (this.state.trace) return false;
    else if (key === "j" || key === "down") act.moveTraceCursor(this, 1);
    else if (key === "k" || key === "up") act.moveTraceCursor(this, -1);
    else if (key === "enter" || key === "o") act.openTrace(this, this.state.traceCursor ?? act.shownTraces(this)[0]?.id, cx);
    else return false;
    return true;
  }

  openTraceRow(id, cx) {
    act.openTrace(this, id, cx);
    this.handle.focus();
  }

  askLogs(cx) {
    act.askLogs(this, cx);
    cx.notify();
  }

  askTrace(cx) {
    act.askTrace(this, cx);
    cx.notify();
  }

  closeTrace(cx) {
    this.set({ trace: null });
    act.reloadTraces(this, cx);
    this.handle.focus();
    cx.notify();
  }

  escape(cx) {
    const { confirm, trace, tab, filter } = this.state;
    if (this.typing.size > 0) this.handle.focus();
    else if (confirm) this.set({ confirm: null });
    else if (tab === "resources" && this.state.panelOpen) { this.set({ panelOpen: false }); this.persist(); }
    else if (tab === "traces" && trace) this.closeTrace(cx);
    else if (tab === "logs" && (filter || this.filterInput.value())) { this.filterInput.set_value(""); this.set({ filter: "" }); }
    else if (props()?.overlay) closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    return v_flex().id("orbit").track_focus(this.handle).size_full().min_h(0).font_family(mono()).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(shellView(this, t));
  }

  // Everything this copy holds is let go here: timers stop, host objects are released, and
  // late async results are dropped (this.closed).
  async close() {
    this.closed = true;
    for (const one of this.tasks) one.task?.cancel();
    this.tasks = [];
    this.logView = null;
    // A docked copy's pending nextCommand() keeps this object reachable until the host's next
    // command; dropping the state leaves only a small shell behind.
    this.state = { ...this.state, logs: act.EMPTY_LOGS, traces: act.EMPTY_TRACES, trace: null, sql: act.EMPTY_SQL, status: act.EMPTY_STATUS, instances: [] };
    for (const one of [this.logScroll, this.filterInput, this.targetInput, this.handle]) one?.release?.();
  }
}

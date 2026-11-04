import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { targetHint } from "../target.js";
import { currentInstance, dashboardOf, isArmedStopDaemon } from "../actions.js";
import { countTones, clock } from "../model.js";
import { resourcesView } from "./resources.js";
import { logsView } from "./logs.js";
import { tracesView } from "./traces.js";
import { sqlView } from "./sql.js";
import { button, windowButtons, chip, glyph, iconLabel, note, errorRow, targetField, ICONS } from "./widgets.js";

const TAB_LABELS = { resources: "Resources", logs: "Logs", traces: "Traces", sql: "SQL" };
const TAB_ICONS = { resources: ICONS.resources, logs: ICONS.logs, traces: ICONS.traces, sql: ICONS.sql };

function daemonChip(app, t) {
  const { source } = app.state.status;
  if (source === "daemon") return chip(t, "daemon running", t.ansi2);
  if (source === "loading") return chip(t, "checking...", t.dim);
  return chip(t, "stopped", t.dim);
}

function healthChips(app, t) {
  const counts = countTones(app.state.status.resources);
  const total = app.state.status.resources.length;
  if (total === 0) return [];
  return [
    chip(t, `${counts.healthy ?? 0}/${total} healthy`, t.ansi2),
    ...(counts.starting ? [chip(t, `${counts.starting} starting`, t.ansi3)] : []),
    ...(counts.unhealthy ? [chip(t, `${counts.unhealthy} unhealthy`, t.ansi1)] : []),
  ];
}

function stopDaemonButton(app, t) {
  const armed = isArmedStopDaemon(app);
  const busy = app.state.acting.startsWith("daemon:");
  const name = currentInstance(app)?.name || "default";
  return button(t, "stop-daemon", busy ? "Stopping..." : armed ? "Confirm stop" : iconLabel(t.foreground, ICONS.power, "Stop daemon"), (_e, cx) => app.stopDaemon(cx),
    { danger: armed, disabled: busy, tooltip: `Stop ${name}: orbit down, then daemon stop. Press twice.` });
}

function headerBar(app, t) {
  const { status, loadingStatus } = app.state;
  const isLive = status.source === "daemon" && Boolean(dashboardOf(app));
  return h_flex().flex_none().px(10).py(8).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
    .child(glyph(t.accent, ICONS.orbit))
    .child(div().flex_none().font_bold().text_size(13).child("Orbit"))
    .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center()
      .children(instancePills(app, t))
      .when(!isLive, (el) => el.child(daemonChip(app, t)))
      .children(healthChips(app, t))
      .when(Boolean(status.selected), (el) => el.child(chip(t, `selected env: ${status.selected} (not running)`, t.ansi3, "outline"))))
    .child(div().flex_none().text_size(10.5).text_color(t.dim).child(loadingStatus ? "refreshing" : `updated ${clock(status.at)}`))
    .when(isLive, (el) => el.child(stopDaemonButton(app, t)))
    .child(windowButtons(t, app));
}

function tabItem(app, t, key, index) {
  const on = app.state.tab === key;
  return h_flex().id(`tab-${key}`).h(24).px(10).gap(6).items_center().rounded(5).text_size(11.5).cursor_pointer()
    .when(on, (e) => e.bg(t.solid).text_color(t.solid_foreground).font_semibold())
    .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => app.setTab(key, cx))
    .child(glyph(on ? t.solid_foreground : t.dim, TAB_ICONS[key]))
    .child(TAB_LABELS[key])
    .child(div().text_size(9.5).text_color(on ? t.solid_foreground : t.dim).child(String(index + 1)));
}

function instanceLabel(app, one) {
  const isCurrent = one.name === currentInstance(app)?.name;
  const { resources } = app.state.status;
  if (isCurrent && resources.length) return `${resources.filter((r) => r.state !== "stopped").length}/${resources.length}`;
  if (one.total !== null && one.total !== undefined) return `${one.up}/${one.total}`;
  return one.daemon ? "" : "off";
}

function instanceColor(t, index) {
  return [t.ansi6, t.ansi5, t.ansi4, t.ansi3, t.ansi2, t.ansi1][index % 6];
}

function instancePills(app, t) {
  const { instances, status } = app.state;
  if (instances.length === 0) return [div().flex_none().text_size(12.5).text_color(t.dim).child(status.env || "...")];
  const current = currentInstance(app)?.name;
  return instances.map((one, index) => {
    const on = one.name === current;
    const color = instanceColor(t, index);
    return h_flex().id(`inst-${one.name || "default"}`).flex_none().h(24).px(9).gap(6).items_center().rounded(12).cursor_pointer().text_size(12)
      .border_1().border_color(on ? color : t.border).text_color(on ? t.foreground : t.dim)
      .when(on, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
      .tooltip([one.env, one.dashboard].filter(Boolean).join(" \u{b7} ") || "no environment")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => app.switchInstance(one.name, cx))
      .child(div().w(7).h(7).rounded(4).bg(on || one.daemon ? color : t.border))
      .child(div().when(on, (el) => el.font_semibold()).child(one.name || "default"))
      .when(Boolean(instanceLabel(app, one)), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(instanceLabel(app, one))));
  });
}

function tabBar(app, t) {
  return h_flex().flex_none().px(8).py(5).gap(8).items_center().border_b(1).border_color(t.border)
    .child(h_flex().id("orbit-tabs").p(2).gap(2).rounded(7).bg(t.surface).border_1().border_color(t.border)
      .children(Object.keys(TAB_LABELS).map((key, index) => tabItem(app, t, key, index))))
    .child(div().flex_1())
    .when(Boolean(dashboardOf(app)) && app.state.status.source === "daemon", (el) => el.child(button(t, "open-dashboard", "Dashboard", (_e, cx) => app.openUrl(dashboardOf(app), cx), { tooltip: dashboardOf(app) })))
    .child(button(t, "refresh", "Refresh", (_e, cx) => app.refresh(cx), { hotkey: "r" }))
    .child(div().w(220).flex_none().child(targetField(t, "agent-target", app.targetInput, targetHint(app.targetInput.value()))));
}

function upCommand(app) {
  const name = currentInstance(app)?.name;
  return name ? `orbit --instance ${name} up` : "orbit up";
}

function stoppedBanner(app, t) {
  const { status } = app.state;
  if (status.source === "daemon" || status.source === "loading") return null;
  // A stopped runtime is a normal state (e.g. after Stop daemon), so it reads as information, not an error.
  return v_flex().flex_none().mx(8).mt(8).px(12).py(9).gap(4).rounded(8).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().gap(8).items_center()
      .child(glyph(t.dim, ICONS.orbit))
      .child(div().font_semibold().text_color(t.foreground).child(`Stopped \u{2014} ${status.env || "unknown"}`)))
    .child(div().text_size(11.5).text_color(t.muted).child(`Start it with \`${upCommand(app)}\` in a terminal. This panel picks it up within a few seconds.`))
    .when(Boolean(status.error), (el) => el.child(div().text_size(11).text_color(t.dim).child(status.error)));
}

function body(app, t) {
  if (app.state.tab === "logs") return logsView(app, t);
  if (app.state.tab === "traces") return tracesView(app, t);
  if (app.state.tab === "sql") return sqlView(app, t);
  return resourcesView(app, t);
}

export function shellView(app, t) {
  const { status, message } = app.state;
  const banner = stoppedBanner(app, t);
  return v_flex().flex_1().min_h(0)
    .child(headerBar(app, t))
    .child(tabBar(app, t))
    .when(Boolean(banner), (el) => el.child(banner))
    .when(status.source === "daemon" && Boolean(status.error), (el) => el.child(errorRow(t, "status-error", status.error, (_e, cx) => app.refresh(cx))))
    .when(Boolean(message), (el) => el.child(note(t, message, "warning")))
    .child(v_flex().flex_1().min_h(0).pb(4).child(body(app, t)));
}

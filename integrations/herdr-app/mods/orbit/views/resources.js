import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { selectedResource, isLive } from "../actions.js";
import { stateTone } from "../model.js";
import { button, chip, card, cardHeader, note, glyph, tint, iconButton, ICONS } from "./widgets.js";

const DOT = "\u{25cf}";
const COLUMNS = [["name", 150], ["kind", 78], ["state", 104], ["ports", 170], ["uptime", 70], ["restarts", 66]];

export function toneOf(t, state) {
  const tone = stateTone(state);
  if (tone === "healthy") return t.ansi2;
  if (tone === "starting") return t.ansi3;
  if (tone === "unhealthy") return t.ansi1;
  return t.dim;
}

function cell(width, child) {
  return div().w(width).flex_none().min_w(0).truncate().child(child);
}

function headerRow(t) {
  return h_flex().flex_none().h(24).px(10).gap(8).items_center().text_size(10.5).font_bold().text_color(t.dim).border_b(1).border_color(t.border)
    .child(div().w(12).flex_none())
    .children(COLUMNS.map(([label, width]) => cell(width, label.toUpperCase())))
    .child(div().flex_1().min_w(0).child("URL"));
}

function stateText(row) {
  return row.phase && row.phase !== row.state ? `${row.state} \u{b7} ${row.phase}` : row.state;
}

function resourceRow(app, t, row) {
  const isSelected = row.name === app.state.selected;
  const color = toneOf(t, row.state);
  return h_flex().id(`res-${row.name}`).flex_none().h(26).px(10).gap(8).items_center().text_size(12).cursor_pointer()
    .when(isSelected, (el) => el.bg(t.selected))
    .when(!isSelected, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => app.selectRow(row.name, cx))
    .child(div().w(12).flex_none().text_color(color).child(DOT))
    .child(cell(150, div().font_semibold().child(row.name)))
    .child(cell(78, div().text_color(t.muted).child(row.kind || "-")))
    .child(cell(104, div().text_color(color).child(stateText(row))))
    .child(cell(170, div().text_color(t.muted).child(row.ports.join("  ") || "-")))
    .child(cell(70, div().text_color(t.muted).child(row.uptime || "-")))
    .child(cell(66, div().text_color(row.restarts > 0 ? t.ansi3 : t.dim).child(String(row.restarts))))
    .child(div().flex_1().min_w(0).truncate().text_color(t.accent).child(row.url || ""));
}

function tableCard(app, t) {
  const { resources } = app.state.status;
  return card(t, "resources-card").flex_1().min_h(0)
    .child(cardHeader(t, { icon: ICONS.resources, title: "Resources", meta: `${resources.length} total` }))
    .child(headerRow(t))
    .child(v_flex().id("resource-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(resources.map((row) => resourceRow(app, t, row)))
      .when(resources.length === 0, (el) => el.child(note(t, app.state.status.source === "loading" ? "Reading Orbit status..." : "No resources reported."))));
}

function confirmStrip(app, t) {
  const { confirm } = app.state;
  if (!confirm || confirm.action === "daemon") return null;
  const verb = confirm.action === "restart" ? "Restart" : "Stop";
  return h_flex().mx(10).mt(8).px(10).py(6).gap(8).items_center().rounded(7).border_1().border_color(t.ansi1).bg(tint(t.ansi1, "18"))
    .child(glyph(t.ansi1, ICONS.warning))
    .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.foreground).child(`${verb} ${confirm.name}? Press ${confirm.action === "restart" ? "R" : "S"} again or confirm.`))
    .child(button(t, "confirm-yes", `Confirm ${verb.toLowerCase()}`, (_e, cx) => app.confirmAction(cx), { danger: true }))
    .child(button(t, "confirm-no", "Cancel", (_e, cx) => app.cancelConfirm(cx), { hotkey: "esc" }));
}

function linkRow(t, id, label, url, app) {
  return h_flex().id(id).gap(6).items_center().text_size(11.5).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => app.openUrl(url, cx))
    .child(glyph(t.accent, ICONS.link))
    .child(div().min_w(0).truncate().child(`${label}  ${url}`));
}

function facts(t, row) {
  const items = [["role", row.role], ["image", row.image], ["startup", row.startup], ["health", row.health]].filter(([, value]) => value);
  return v_flex().px(10).pt(6).gap(2).children(items.map(([label, value]) => h_flex().gap(6).text_size(11)
    .child(div().w(56).flex_none().text_color(t.dim).child(label))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(value))));
}

function actionButtons(app, t, row) {
  const live = isLive(app);
  const busy = app.state.acting === row.name;
  const pending = app.state.confirm?.name === row.name ? app.state.confirm.action : "";
  return h_flex().px(10).pt(8).gap(4).flex_wrap()
    .child(button(t, "act-open", "Open", (_e, cx) => app.openUrl(row.url, cx), { hotkey: "o", disabled: !row.url }))
    .child(button(t, "act-logs", "Logs", (_e, cx) => app.logsOf(row.name, cx), { hotkey: "l" }))
    .child(button(t, "act-restart", pending === "restart" ? "Confirm restart" : "Restart", (_e, cx) => app.requestAction("restart", cx),
      { hotkey: "R", disabled: !live || busy, danger: pending === "restart", tooltip: live ? "Press twice to restart" : "Needs the Orbit daemon" }))
    .child(button(t, "act-stop", pending === "stop" ? "Confirm stop" : "Stop", (_e, cx) => app.requestAction("stop", cx),
      { hotkey: "S", disabled: !live || busy, danger: pending === "stop", tooltip: live ? "Press twice to stop" : "Needs the Orbit daemon" }));
}

function closeButton(t, onClick) {
  return iconButton(t, "panel-close", ICONS.close, onClick, 22);
}

function sidePanel(app, t) {
  const row = selectedResource(app);
  const close = (_e, cx) => app.setPanel(false, cx);
  const shell = v_flex().id("side-panel").absolute().top(0).right(0).bottom(0).w(400).min_h(0)
    .bg(t.background).border_l(1).border_color(t.border).shadow_lg()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  if (!row) return shell.child(h_flex().px(12).pt(10).gap(8).child(div().flex_1().text_color(t.dim).child("Select a row")).child(closeButton(t, close)));
  return shell
    .child(v_flex().flex_none().px(12).pt(10).pb(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(11).text_color(t.dim).child(row.kind))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(row.name))
        .child(closeButton(t, close)))
      .child(h_flex().gap(6).items_center().child(chip(t, row.state, toneOf(t, row.state)))
        .when(row.restarts > 0, (el) => el.child(chip(t, `${row.restarts} restarts`, t.ansi3)))))
    .child(v_flex().id("panel-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8)
      .child(facts(t, row))
      .when(Boolean(row.url), (el) => el.child(div().px(10).pt(6).child(linkRow(t, "link-main", "url", row.url, app))))
      .children(row.sidecars.map((one, index) => div().px(10).pt(4).child(linkRow(t, `link-side-${index}`, one.name, one.url, app))))
      .child(actionButtons(app, t, row)));
}

export function resourcesView(app, t) {
  const strip = confirmStrip(app, t);
  const open = app.state.panelOpen;
  // The panel floats over the right of the table (as in the k8s mod) instead of narrowing it.
  return v_flex().flex_1().min_h(0).relative()
    .when(Boolean(strip), (el) => el.child(strip))
    .child(tableCard(app, t))
    .when(open, (el) => el.child(sidePanel(app, t)));
}

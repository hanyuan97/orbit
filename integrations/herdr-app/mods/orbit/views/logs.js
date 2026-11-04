import { div } from "gpui-kit";
import { h_flex, v_flex, Input, v_virtual_list, Scrollbar } from "gpui-base";
import { lineTone, clock } from "../model.js";
import { toneOf } from "./resources.js";
import { isLive } from "../actions.js";
import { button, card, cardHeader, note, errorRow, glyph, toneColor, ICONS } from "./widgets.js";

const LINE_PX = 18;
const DOT = "\u{25cf}";

function resourcePicker(app, t) {
  const current = app.state.logResource;
  return h_flex().px(10).pt(8).gap(4).flex_wrap()
    .children(app.state.status.resources.map((one) => {
      const on = one.name === current;
      return h_flex().id(`log-pick-${one.name}`).h(22).px(8).gap(5).items_center().rounded(5).text_size(11.5).cursor_pointer()
        .border_1().border_color(on ? t.accent : t.border)
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground).font_semibold())
        .when(!on, (el) => el.bg(t.raised).text_color(one.logs ? t.muted : t.dim).hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => app.pickLogResource(one.name, cx))
        .child(div().text_size(9).text_color(toneOf(t, one.state)).child(DOT))
        .child(one.name);
    }));
}

function filterBox(app, t) {
  return h_flex().id("log-filter").flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(6).border_1()
    .border_color(app.state.filter ? t.accent : t.border).bg(t.surface)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(glyph(t.dim, ICONS.filter))
    .child(Input.new(app.filterInput).flex_1().h_full().text_size(11.5).text_color(t.foreground));
}

function toolRow(app, t, shown) {
  const { follow, asking } = app.state;
  return h_flex().px(10).py(8).gap(6).items_center()
    .child(filterBox(app, t))
    .child(button(t, "log-follow", follow ? "Following" : "Paused", (_e, cx) => app.toggle("follow", cx), { hotkey: "f", active: follow, tooltip: "Re-poll every 3 s" }))
    .child(button(t, "log-copy", "Copy", (_e, cx) => app.copyLines(shown.join("\n"), cx), { disabled: shown.length === 0 }))
    .child(button(t, "log-ask", asking ? "Asking..." : "Ask agent", (_e, cx) => app.askLogs(cx), { hotkey: "c", primary: true, disabled: asking || shown.length === 0 }));
}

function lineRow(t, line, index) {
  const tone = lineTone(line);
  return div().id(`log-${index}`).h(LINE_PX).px(10).truncate().text_size(11.5).text_color(tone ? toneColor(t, tone) : t.foreground).child(line || " ");
}

function linesArea(app, t, shown) {
  const { logs } = app.state;
  if (!isLive(app) && shown.length === 0) return note(t, "Orbit is stopped, so there are no live logs.");
  if (logs.error && shown.length === 0) return errorRow(t, "logs-error", logs.error, (_e, cx) => app.refresh(cx));
  if (shown.length === 0) return note(t, logs.loading ? "Loading logs..." : app.state.filter ? "No lines match the filter." : "No log lines.");
  return v_flex().relative().flex_1().min_h(0).border_t(1).border_color(t.border)
    .child(v_virtual_list("orbit-log-lines", shown.length, LINE_PX, (index) => String(index),
      (range) => shown.slice(range.start, range.end).map((line, offset) => lineRow(t, line, range.start + offset))).track_scroll(app.logScroll).flex_1())
    .child(Scrollbar.vertical("orbit-log-lines").absolute().inset_0());
}

function meta(app) {
  const { logs } = app.state;
  const shown = app.shownLogLines();
  const count = app.state.filter ? `${shown.length}/${logs.lines.length} lines` : `${logs.lines.length} lines`;
  return `${count} \u{b7} ${logs.loading ? "loading" : `updated ${clock(logs.at)}`}`;
}

export function logsView(app, t) {
  const { logs, logResource } = app.state;
  const shown = app.shownLogLines();
  return card(t, "logs-card").flex_1().min_h(0)
    .child(cardHeader(t, { icon: ICONS.logs, title: logResource ? `Logs \u{b7} ${logResource}` : "Logs", meta: meta(app) }))
    .child(resourcePicker(app, t))
    .child(toolRow(app, t, shown))
    .when(Boolean(logs.error) && shown.length > 0, (el) => el.child(note(t, logs.error, "error")))
    .child(linesArea(app, t, shown));
}

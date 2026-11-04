import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shownTraces, isLive } from "../actions.js";
import { formatMs, clockOf, clock, waterfall, serviceColor, isErrorTrace, lineTone } from "../model.js";
import { button, chip, card, cardHeader, note, errorRow, toneColor, tint, ICONS } from "./widgets.js";

const BAR_PX = 260;
const NAME_PX = 320;
const MAX_LOG_ROWS = 400;

function listTools(app, t) {
  const { errorsOnly, includeHealth } = app.state;
  return [
    button(t, "tr-errors", errorsOnly ? "Errors only" : "All traces", (_e, cx) => app.toggle("errorsOnly", cx), { hotkey: "e", active: errorsOnly }),
    button(t, "tr-health", includeHealth ? "With health checks" : "No health checks", (_e, cx) => app.toggle("includeHealth", cx), { hotkey: "h", active: includeHealth }),
  ];
}

function traceRow(app, t, trace) {
  const isError = isErrorTrace(trace);
  const isCursor = trace.id === app.state.traceCursor;
  const color = isError ? t.ansi1 : t.foreground;
  return h_flex().id(`tr-${trace.id}`).flex_none().h(26).px(10).gap(10).items_center().text_size(12).cursor_pointer()
    .when(isCursor, (el) => el.bg(t.selected))
    .when(!isCursor, (el) => el.hover((s) => s.bg(t.hover)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => app.openTraceRow(trace.id, cx))
    .child(div().w(64).flex_none().text_color(t.dim).child(clockOf(trace.start)))
    .child(div().w(52).flex_none().text_color(isError ? t.ansi1 : t.ansi2).font_semibold().child(isError ? "ERROR" : "ok"))
    .child(div().w(110).flex_none().truncate().text_color(serviceColor(t, trace.rootService)).child(trace.rootService))
    .child(div().flex_1().min_w(0).truncate().text_color(color).child(trace.rootName || "(unnamed)"))
    .child(div().w(70).flex_none().text_color(t.muted).child(formatMs(trace.durationMs)))
    .child(div().w(70).flex_none().text_color(t.dim).child(`${trace.spanCount} spans`))
    .child(div().w(180).flex_none().truncate().text_color(t.dim).child(trace.services.join(", ")));
}

function listView(app, t) {
  const { traces } = app.state;
  const list = shownTraces(app);
  const meta = `${list.length}/${traces.list.length} \u{b7} ${traces.loading ? "loading" : `updated ${clock(traces.at)}`}`;
  return card(t, "traces-card").flex_1().min_h(0)
    .child(cardHeader(t, { icon: ICONS.traces, title: "Recent traces", meta, actions: listTools(app, t) }))
    .when(Boolean(traces.error), (el) => el.child(errorRow(t, "traces-error", traces.error, (_e, cx) => app.refresh(cx))))
    .child(v_flex().id("trace-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(list.map((trace) => traceRow(app, t, trace)))
      .when(list.length === 0 && !traces.error, (el) => el.child(note(t, !isLive(app) ? "Orbit is stopped, so there are no traces." : traces.loading ? "Loading traces..." : app.state.errorsOnly ? "No error traces." : "No traces yet. Health-check traces are hidden (h)."))));
}

function spanRow(t, row, index) {
  const { span } = row;
  const isError = span.status === "error";
  const color = serviceColor(t, span.service);
  return h_flex().id(`span-${index}`).flex_none().h(22).px(10).gap(8).items_center().text_size(11.5)
    .when(isError, (el) => el.bg(tint(t.ansi1, "14")))
    .child(h_flex().w(NAME_PX).flex_none().min_w(0).gap(6).items_center().pl(Math.min(row.depth, 12) * 12)
      .child(div().flex_none().max_w(110).truncate().text_color(color).font_semibold().child(span.service))
      .child(div().flex_1().min_w(0).truncate().text_color(isError ? t.ansi1 : t.foreground).child(span.name || "(unnamed)")))
    .child(div().w(BAR_PX).flex_none().h(10).rounded(3).bg(t.surface)
      .child(div().ml(row.offset * BAR_PX).w(Math.max(row.width * BAR_PX, 2)).h_full().rounded(3).bg(isError ? t.ansi1 : color)))
    .child(div().w(64).flex_none().text_color(isError ? t.ansi1 : t.muted).child(formatMs(span.durationMs)))
    .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(span.kind));
}

function waterfallCard(t, detail) {
  const rows = waterfall(detail);
  return card(t, "waterfall-card").flex_1().min_h(0)
    .child(cardHeader(t, { icon: ICONS.traces, title: "Waterfall", meta: `${rows.length} spans` }))
    .child(v_flex().id("span-rows").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .children(rows.map((row, index) => spanRow(t, row, index)))
      .when(rows.length === 0, (el) => el.child(note(t, "No spans in this trace."))));
}

function traceLogsCard(t, logs) {
  const shown = logs.slice(-MAX_LOG_ROWS);
  return card(t, "trace-logs-card").flex_1().min_h(0)
    .child(cardHeader(t, { icon: ICONS.logs, title: "Logs with this trace id", meta: `${logs.length} lines` }))
    .child(v_flex().id("trace-log-rows").flex_1().min_h(0).overflow_y_scrollbar().py(4)
      .children(shown.map((line, index) => div().id(`tl-${index}`).px(10).text_size(11.5)
        .text_color(lineTone(line) ? toneColor(t, lineTone(line)) : t.foreground).child(line)))
      .when(logs.length === 0, (el) => el.child(note(t, "No log lines carry this trace id."))));
}

function detailHeader(app, t) {
  const { trace, asking } = app.state;
  const detail = trace.detail;
  const isError = detail ? isErrorTrace(detail) : false;
  const title = detail ? `${detail.rootService} \u{b7} ${detail.rootName || "(unnamed)"}` : `Trace ${trace.id.slice(0, 8)}`;
  return card(t, "trace-head").flex_none()
    .child(cardHeader(t, {
      icon: ICONS.traces, color: isError ? t.ansi1 : t.accent, title: "Trace",
      chips: [div().min_w(0).truncate().text_size(11.5).text_color(isError ? t.ansi1 : t.muted).child(title)],
      actions: [
        button(t, "tr-copy-id", "Copy id", (_e, cx) => app.copyLines(trace.id, cx)),
        button(t, "tr-ask", asking ? "Asking..." : "Ask agent", (_e, cx) => app.askTrace(cx), { hotkey: "c", primary: true, disabled: asking || !detail }),
        button(t, "tr-back", "Back", (_e, cx) => app.closeTrace(cx), { hotkey: "esc" }),
      ],
    }))
    .when(Boolean(detail), (el) => el.child(h_flex().px(10).py(6).gap(6).items_center().flex_wrap()
      .child(chip(t, isError ? "error" : detail.status, isError ? t.ansi1 : t.ansi2))
      .child(chip(t, formatMs(detail.durationMs), t.accent))
      .child(chip(t, `${detail.spans.length} spans`, t.muted))
      .child(div().text_size(11).text_color(t.dim).child(`${clockOf(detail.start)} \u{b7} ${trace.id}`))));
}

function detailView(app, t) {
  const { trace } = app.state;
  const content = trace.loading ? note(t, "Loading trace...")
    : trace.error ? errorRow(t, "trace-error", trace.error, (_e, cx) => app.openTraceRow(trace.id, cx))
      : v_flex().flex_1().min_h(0).child(waterfallCard(t, trace.detail)).child(traceLogsCard(t, trace.logs));
  return v_flex().flex_1().min_h(0)
    .child(detailHeader(app, t))
    .child(content);
}

export function tracesView(app, t) {
  return app.state.trace ? detailView(app, t) : v_flex().flex_1().min_h(0).child(listView(app, t));
}

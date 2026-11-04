import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { clock } from "../model.js";
import { chip, card, cardHeader, note, errorRow, button, ICONS } from "./widgets.js";

const DOT = "\u{25cf}";
const LABELS = { "in-sync": "in sync", changed: "changed", "not-published": "not published", unknown: "unknown" };

function statusColor(t, status) {
  if (status === "in-sync") return t.ansi2;
  if (status === "changed") return t.ansi3;
  if (status === "unknown") return t.ansi1;
  return t.dim;
}

function headerRow(t) {
  return h_flex().flex_none().h(24).px(10).gap(8).items_center().text_size(10.5).font_bold().text_color(t.dim).border_b(1).border_color(t.border)
    .child(div().w(12).flex_none())
    .child(div().w(170).flex_none().child("PROJECT"))
    .child(div().w(210).flex_none().child("DATABASE"))
    .child(div().w(110).flex_none().child("STATUS"))
    .child(div().flex_1().min_w(0).child("DETAIL"));
}

function dbRow(t, row) {
  const color = statusColor(t, row.status);
  return h_flex().id(`sql-${row.project}-${row.db}`).flex_none().h(26).px(10).gap(8).items_center().text_size(12)
    .child(div().w(12).flex_none().text_color(color).child(DOT))
    .child(div().w(170).flex_none().min_w(0).truncate().text_color(t.muted).child(row.project))
    .child(div().w(210).flex_none().min_w(0).truncate().font_semibold().child(row.db))
    .child(div().w(110).flex_none().text_color(color).child(LABELS[row.status] ?? row.status))
    .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(row.detail));
}

function chips(t, list) {
  const changed = list.filter((one) => one.status === "changed").length;
  const synced = list.filter((one) => one.status === "in-sync").length;
  return [
    ...(synced ? [chip(t, `${synced} in sync`, t.ansi2)] : []),
    ...(changed ? [chip(t, `${changed} changed`, t.ansi3)] : []),
  ];
}

function emptyText(sql) {
  if (!sql.live && sql.at > 0) return "Orbit is stopped, so SQL status is not checked.";
  if (sql.loading && sql.at === 0) return "Reading SQL projects...";
  if (!sql.configured) return "This environment has no SQL Server workflow.";
  return "No SQL databases.";
}

export function sqlView(app, t) {
  const { sql } = app.state;
  const meta = sql.loading ? "checking" : sql.at ? `checked ${clock(sql.at)}` : "";
  return v_flex().flex_1().min_h(0)
    .when(Boolean(sql.error), (el) => el.child(errorRow(t, "sql-error", sql.error, (_e, cx) => app.refresh(cx))))
    .child(card(t, "sql-card").flex_1().min_h(0)
      .child(cardHeader(t, { icon: ICONS.sql, title: "SQL", chips: chips(t, sql.list), meta,
        actions: [button(t, "sql-refresh", "Check", (_e, cx) => app.refresh(cx), { hotkey: "r", disabled: sql.loading })] }))
      .when(sql.list.length > 0, (el) => el.child(headerRow(t)))
      .child(v_flex().id("sql-rows").flex_1().min_h(0).overflow_y_scrollbar()
        .children(sql.list.map((row) => dbRow(t, row)))
        .when(sql.list.length === 0, (el) => el.child(note(t, emptyText(sql))))));
}

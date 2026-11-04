import { div } from "gpui-kit";
import { h_flex, v_flex, Input } from "gpui-base";
import { settings, fonts, props } from "herdr";

export const ICONS = {
  orbit: "\u{f1b3}", resources: "\u{f233}", logs: "\u{f15c}", traces: "\u{f0e8}", agent: "\u{f120}",
  error: "\u{f06a}", filter: "\u{f0b0}", link: "\u{f08e}", warning: "\u{f071}", sql: "\u{f1c0}",
  split: "\u{eb56}", tab: "\u{f2d2}", float: "\u{f2d0}", close: "\u{f00d}", power: "\u{f011}",
};

const NERD_FONT = "JetBrainsMono Nerd Font";

export function tint(color, alpha) {
  return `${String(color).slice(0, 7)}${alpha}`;
}

export function mono() {
  return fonts().includes(NERD_FONT) ? NERD_FONT : settings().font_family ?? "JetBrains Mono";
}

export function glyph(color, text) {
  return div().flex_none().font_family(mono()).text_color(color).child(text);
}

/** A button label: a Nerd Font icon, then its text. */
export function iconLabel(color, icon, text) {
  return h_flex().gap(5).items_center().child(glyph(color, icon)).child(div().child(text));
}

/** A 24px square icon-only button, such as a close x. */
export function iconButton(t, id, icon, onClick, size = 24) {
  return div().id(id).flex_none().w(size).h(size).flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .child(glyph(t.muted, icon));
}

export function toneColor(t, tone) {
  switch (tone) {
    case "error": return t.ansi1;
    case "warning": return t.ansi3;
    case "success": return t.ansi2;
    case "subtle": return t.muted;
    case "dim": return t.dim;
    default: return t.foreground;
  }
}

function buttonLook(t, options) {
  if (options.disabled) return { bg: t.surface, border: t.border, text: t.dim, hover: t.surface };
  if (options.danger) return { bg: t.ansi1, border: t.ansi1, text: t.background, hover: t.ansi9 };
  if (options.primary) return { bg: t.solid, border: t.solid, text: t.solid_foreground, hover: t.solid };
  if (options.active) return { bg: t.selected, border: t.accent, text: t.foreground, hover: t.selected };
  return { bg: t.raised, border: t.border, text: t.foreground, hover: t.hover };
}

export function button(t, id, label, onClick, options = {}) {
  const look = buttonLook(t, options);
  return div().id(id).flex_none().h(24).px(9).flex().items_center().rounded(6)
    .border_1().border_color(look.border).bg(look.bg).text_size(11.5).text_color(look.text)
    .when(!options.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(look.hover)))
    .when(Boolean(options.tooltip), (el) => el.tooltip(options.tooltip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      if (!options.disabled) onClick(e, cx);
    })
    .child(h_flex().gap(5).items_center()
      .child(typeof label === "string" ? div().child(label) : label)
      .when(Boolean(options.hotkey), (el) => el.child(div().px(3).rounded(3).bg(options.primary || options.danger ? tint(look.text, "22") : t.background)
        .text_size(10).text_color(options.primary || options.danger ? look.text : t.dim).child(options.hotkey ?? ""))));
}

/** Split / tab / close while floating; back to a floating window once docked. */
export function windowButtons(t, app) {
  if (!props()?.overlay) {
    return button(t, "as-float", iconLabel(t.foreground, ICONS.float, "Float"), (_e, cx) => app.togglePlace(cx), { hotkey: "\u{2318}\u{21b5}", tooltip: "Back to a floating window" });
  }
  return h_flex().flex_none().gap(4).items_center()
    .child(button(t, "as-split", iconLabel(t.foreground, ICONS.split, "Split"), (_e, cx) => app.togglePlace(cx), { tooltip: "Dock beside the focused pane (cmd-enter)" }))
    .child(button(t, "as-tab", iconLabel(t.foreground, ICONS.tab, "Tab"), (_e, cx) => app.openTab(cx), { tooltip: "Open as a tab (cmd-shift-t)" }))
    .child(iconButton(t, "close", ICONS.close, () => app.hide()));
}

export function chip(t, text, color, variant = "tint") {
  const el = div().flex_none().h(18).px(6).flex().items_center().rounded(5).text_size(10.5).font_semibold();
  if (variant === "solid") return el.bg(color).text_color(t.background).child(text);
  if (variant === "outline") return el.border_1().border_color(color).text_color(color).child(text);
  return el.bg(tint(color, "24")).text_color(color).child(text);
}

export function card(t, id) {
  return v_flex().id(id).mx(8).my(4).rounded(10).border_1().border_color(t.border).bg(t.background).overflow_hidden();
}

export function cardHeader(t, spec) {
  return h_flex().h(32).flex_none().px(10).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
    .child(glyph(spec.color ?? t.accent, spec.icon))
    .child(div().flex_none().font_bold().text_size(12.5).text_color(t.foreground).child(spec.title))
    .children(spec.chips ?? [])
    .child(div().flex_1())
    .when(Boolean(spec.meta), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(spec.meta ?? "")))
    .children(spec.actions ?? []);
}

export function note(t, text, tone) {
  return div().px(10).py(5).text_size(11.5).text_color(tone ? toneColor(t, tone) : t.dim).child(text);
}

export function errorRow(t, id, text, onRetry) {
  return h_flex().id(id).mx(8).my(4).px(10).py(7).gap(8).items_start().rounded(8)
    .border_1().border_color(tint(t.ansi1, "66")).bg(tint(t.ansi1, "14")).text_size(12)
    .child(glyph(t.ansi1, ICONS.error))
    .child(div().flex_1().min_w(0).text_color(t.ansi1).child(text))
    .when(Boolean(onRetry), (el) => el.child(button(t, `${id}-retry`, "Retry", onRetry)));
}

export function targetField(t, id, input, label) {
  return h_flex().id(id).flex_1().min_w(90).h(24).px(7).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.surface)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(glyph(t.accent, ICONS.agent))
    .child(div().flex_1().min_w(0).child(Input.new(input).h_full().text_size(11.5).text_color(t.foreground)))
    .when(Boolean(label), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim).child(label ?? "")));
}

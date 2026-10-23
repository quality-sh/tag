/**
 * The quality-sh design language as StyleX variables: the palette hyp.dev and
 * provenance.sh share (Aether Rose), the two typefaces, one type scale.
 *
 * Hue means one thing each:
 *   ink       content            mauve     metadata, secondary text
 *   gold      a link             rosegold  interaction: hover, focus, selection
 *   rose      failure            sage      pass
 *   amber     flaky, warning     iris      the metric colour, big numerals
 */
import * as stylex from "@stylexjs/stylex";

export const tokens = stylex.defineVars({
  bg: "#000000",
  ink: "#e0def4",
  mauve: "#908caa",
  muted: "#525252",
  rose: "#eb6f92",
  rosegold: "#ebbcba",
  gold: "#c4a56a",
  iris: "#c4a7e7",
  amber: "#f6c177",
  sage: "#a3be8c",
  line: "rgba(224, 222, 244, 0.14)",
  lineSoft: "rgba(224, 222, 244, 0.08)",
  hair: "rgba(224, 222, 244, 0.1)",
  quiet: "rgba(224, 222, 244, 0.22)",
  surface: "#0c0b10",
  surface2: "#16141c",
  onPrimary: "#0c0b10",
  primaryHover: "#f3d3d1",
});

/** Test outcomes and chart series, by name. */
export const tones = stylex.defineVars({
  passed: "#a3be8c",
  failed: "#eb6f92",
  flaky: "#f6c177",
  pending: "#f6c177",
  skipped: "rgba(224, 222, 244, 0.22)",
  other: "#908caa",
  metric: "#c4a7e7",
  quiet: "rgba(224, 222, 244, 0.22)",
  ran: "#908caa",
});

export const fonts = stylex.defineVars({
  display: '"Cormorant Garamond", Georgia, "Times New Roman", serif',
  mono: '"Fragment Mono", ui-monospace, Menlo, Consolas, monospace',
});

/** One type scale. Every size in the components is one of these. */
export const text = stylex.defineVars({
  micro: "11px",
  small: "12px",
  body: "14px",
  lead: "17px",
  prose: "18px",
  h3: "21px",
  h2: "26px",
  h1: "32px",
  labelTracking: "0.38em",
});

export const sizes = stylex.defineVars({
  radius: "3px",
  cardRadius: "6px",
  topbar: "73px",
  shadowOverlay: "0 18px 50px rgba(0, 0, 0, 0.8)",
  shadowFrame: "0 30px 80px rgba(0, 0, 0, 0.6)",
});

/** Layout constants inlined at build time. `edge` is the page gutter set in global.css. */
export const layout = stylex.defineConsts({
  edge: "var(--edge)",
});

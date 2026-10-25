// The meter: one value drawn against its threshold on a hairline track.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";
import { toneColor } from "./text.tsx";

const INK = "#e0def4";

const meter = stylex.create({
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "11rem minmax(0, 1fr) 7rem",
      "@media (max-width: 700px)": "1fr",
    },
    gap: { default: 14, "@media (max-width: 700px)": 6 },
    alignItems: "center",
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
  },
  name: { color: tokens.ink },
  track: { position: "relative", height: 8, borderRadius: 2, backgroundColor: tokens.hair },
  fill: (color: string, width: string) => ({
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    backgroundColor: color,
    width,
  }),
  tick: (left: string) => ({
    position: "absolute",
    top: -4,
    bottom: -4,
    width: 1,
    left,
    borderLeftWidth: 1,
    borderLeftStyle: "dashed",
    borderLeftColor: tokens.rosegold,
  }),
  value: (color: string) => ({
    textAlign: { default: "right", "@media (max-width: 700px)": "left" },
    color,
    fontVariantNumeric: "tabular-nums",
  }),
  threshold: { color: tokens.mauve, marginLeft: 6 },
});

/** A value drawn against its threshold. */
export function Meter({
  name,
  value,
  max = 1,
  threshold,
  comparator,
  passed,
  format = (v) => v.toFixed(2),
}: {
  name: ReactNode;
  value: number | null;
  max?: number;
  threshold?: number | null;
  comparator?: string | null;
  passed?: boolean | null;
  format?: (v: number) => string;
}) {
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100))}%`;
  const color =
    passed === false ? toneColor.failed : passed === true ? toneColor.passed : toneColor.metric;
  return (
    <div {...stylex.props(meter.row)}>
      <span {...stylex.props(meter.name)}>{name}</span>
      <div {...stylex.props(meter.track)}>
        {value !== null && <div {...stylex.props(meter.fill(color, pct(value)))} />}
        {threshold !== null && threshold !== undefined && (
          <div
            title={`threshold ${comparator ?? "≥"} ${threshold}`}
            {...stylex.props(meter.tick(pct(threshold)))}
          />
        )}
      </div>
      <span {...stylex.props(meter.value(passed === false ? toneColor.failed : INK))}>
        {value === null ? "error" : format(value)}
        {threshold !== null && threshold !== undefined && (
          <span {...stylex.props(meter.threshold)}>
            {comparator ?? "≥"} {format(threshold)}
          </span>
        )}
      </span>
    </div>
  );
}

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, tokens } from "./theme.stylex";
import { toneColor, type, type Tone } from "./text.tsx";

export interface PlotPoint {
  readonly y: number | null;
  readonly label: string;
  readonly failed?: boolean;
}

const plot = stylex.create({
  card: {
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.hair,
    borderRadius: sizes.cardRadius,
    overflow: "hidden",
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "baseline",
    rowGap: 6,
    columnGap: 16,
    paddingTop: 16,
    paddingLeft: 18,
    paddingRight: 18,
  },
  area: { position: "relative", marginTop: 10, marginLeft: 18, marginRight: 18 },
  svg: { display: "block", width: "100%", height: "auto", overflow: "visible" },
  tick: (top: string) => ({
    position: "absolute",
    left: 0,
    top,
    transform: "translateY(-50%)",
    fontFamily: fonts.mono,
    fontSize: 10,
    color: tokens.muted,
    fontVariantNumeric: "tabular-nums",
  }),
  x: { position: "relative", height: 28, marginLeft: 18, marginRight: 18 },
  xLabel: (left: string) => ({
    position: "absolute",
    top: 8,
    left,
    transform: "translateX(-50%)",
    fontFamily: fonts.mono,
    fontSize: 10,
    color: tokens.mauve,
    whiteSpace: "nowrap",
  }),
});

/**
 * The hyp line plot: a hairline grid, a faint area, a 2px line, hollow dots.
 * `max` fixes the y range (1 for a score); otherwise the data sets it.
 */
export function Plot({
  points,
  max,
  ticks = 4,
  format = (v) => v.toFixed(2),
  title,
  note,
  tone = "metric",
  marks = [],
}: {
  points: ReadonlyArray<PlotPoint>;
  max?: number;
  ticks?: number;
  format?: (v: number) => string;
  title?: ReactNode;
  note?: ReactNode;
  tone?: Tone;
  marks?: ReadonlyArray<number>;
}) {
  const W = 720;
  const H = 180;
  const top = 8;
  const bottom = 8;
  const n = points.length;
  const ys = points.map((p) => p.y).filter((v): v is number => v !== null);
  const yMax = max ?? (ys.length ? Math.max(...ys) * 1.1 || 1 : 1);
  const xOf = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const yOf = (v: number) => top + (1 - Math.min(1, v / yMax)) * (H - top - bottom);
  const pts = points.map((p, i) => (p.y === null ? null : ([xOf(i), yOf(p.y), p] as const)));
  let line = "";
  let prev = false;
  for (const p of pts) {
    if (!p) {
      prev = false;
      continue;
    }
    line += `${prev ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)} `;
    prev = true;
  }
  const first = pts.find(Boolean);
  const last = [...pts].reverse().find(Boolean);
  const area =
    first && last
      ? `${line.replace(/M/g, (m, i) => (i === 0 ? "M" : "L"))}L${last[0].toFixed(1)},${(H - bottom).toFixed(1)} L${first[0].toFixed(1)},${(H - bottom).toFixed(1)} Z`
      : "";
  const grid = Array.from({ length: ticks + 1 }, (_, i) => (yMax * i) / ticks);
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const color = toneColor[tone];
  return (
    <div {...stylex.props(plot.card)}>
      {(title || note) && (
        <div {...stylex.props(plot.head)}>
          <p {...stylex.props(type.eyebrow)}>{title}</p>
          <p {...stylex.props(type.k)}>{note}</p>
        </div>
      )}
      <div {...stylex.props(plot.area)}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={typeof title === "string" ? title : "plot"}
          {...stylex.props(plot.svg)}
        >
          <path
            d={grid.map((v) => `M0,${yOf(v).toFixed(1)} H${W}`).join(" ")}
            stroke="rgba(224, 222, 244, 0.1)"
            strokeWidth="1"
            fill="none"
          />
          {marks.map((i) => (
            <path
              key={i}
              d={`M${xOf(i).toFixed(1)},${top} V${H - bottom}`}
              stroke="#ebbcba"
              strokeWidth="1"
              strokeDasharray="4 4"
              fill="none"
              opacity="0.7"
            />
          ))}
          {area && <path d={area} fill={color} opacity="0.1" />}
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
          <g>
            {pts.map(
              (p, i) =>
                p && (
                  <circle
                    key={i}
                    cx={p[0]}
                    cy={p[1]}
                    r="3.5"
                    fill={p[2].failed ? "#eb6f92" : "#000000"}
                    stroke={p[2].failed ? "#eb6f92" : color}
                    strokeWidth="2"
                  />
                ),
            )}
          </g>
        </svg>
        {grid.map((v, i) => (
          <span key={i} {...stylex.props(plot.tick(`${(yOf(v) / H) * 100}%`))}>
            {format(v)}
          </span>
        ))}
      </div>
      <div aria-hidden="true" {...stylex.props(plot.x)}>
        {points.map((p, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <span key={i} {...stylex.props(plot.xLabel(`${(xOf(i) / W) * 100}%`))}>
              {p.label}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

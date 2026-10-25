// The small charts of the summary strip: the sparkline of recent runs and the
// mini bars of a single figure.
import * as stylex from "@stylexjs/stylex";
import { toneColor, type Tone } from "./text.tsx";

// ---------------------------------------------------------------------------
// Small charts

const charts = stylex.create({
  spark: { display: "block", width: 120, height: 22, overflow: "visible" },
  mini: { display: "flex", alignItems: "flex-end", gap: 3, height: 30, width: 96 },
  bar: (color: string, height: string) => ({
    display: "block",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    backgroundColor: color,
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
    opacity: 0.85,
    height,
    minHeight: 1,
  }),
});

/** Pass rate over the recent runs, newest at the right; failed runs get a rose dot. */
export function Spark({
  points,
  label,
}: {
  points: ReadonlyArray<{ readonly value: number; readonly bad?: boolean }>;
  label?: string;
}) {
  const w = 120;
  const h = 22;
  const n = points.length;
  if (n === 0) return <svg {...stylex.props(charts.spark)} aria-hidden="true" />;
  const x = (i: number) => (n === 1 ? w : (i / (n - 1)) * w);
  const y = (v: number) => 3 + (1 - Math.max(0, Math.min(1, v))) * (h - 6);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(" ");
  const last = points[n - 1]!;
  const stroke = last.bad ? toneColor.failed : toneColor.metric;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...stylex.props(charts.spark)}
    >
      {n > 1 && <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} />}
      {points.map((p, i) =>
        p.bad ? <circle key={i} cx={x(i)} cy={y(p.value)} r={2.2} fill={toneColor.failed} /> : null,
      )}
      {!last.bad && (
        <circle
          cx={x(n - 1)}
          cy={y(last.value)}
          r={2.2}
          fill="#000"
          stroke={toneColor.metric}
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}

/** Bars whose heights are relative to the largest value. */
export function MiniBars({
  values,
  tone = "metric",
}: {
  values: ReadonlyArray<number>;
  tone?: Tone;
}) {
  const max = Math.max(1, ...values);
  return (
    <span aria-hidden="true" {...stylex.props(charts.mini)}>
      {values.map((v, i) => (
        <i key={i} {...stylex.props(charts.bar(toneColor[tone], `${(v / max) * 100}%`))} />
      ))}
    </span>
  );
}

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";
import { toneColor, type, type Tone } from "./text.tsx";

const INK = "#e0def4";

export interface Segment {
  readonly tone: Tone;
  readonly value: number;
  readonly label: string;
}

const bars = stylex.create({
  track: {
    display: "flex",
    height: 10,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: tokens.hair,
  },
  thin: { height: 6 },
  gapped: { gap: 2, backgroundColor: "transparent" },
  seg: (color: string, width: string) => ({ backgroundColor: color, width, minWidth: 0 }),
  segRounded: { borderRadius: 1 },
  keys: { display: "flex", flexWrap: "wrap", rowGap: 8, columnGap: 16, marginTop: 10 },
  key: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    color: tokens.ink,
    whiteSpace: "nowrap",
  },
  keyDim: { color: tokens.mauve },
  dot: (color: string) => ({
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: 2,
    backgroundColor: color,
  }),
});

/** One stacked bar and its key. Zero segments are left out of the key. */
export function Bars({
  segments,
  thin,
  gapped,
  keys = true,
  label,
}: {
  segments: ReadonlyArray<Segment>;
  thin?: boolean;
  gapped?: boolean;
  keys?: boolean;
  label?: string;
}) {
  const total = Math.max(
    1,
    segments.reduce((s, x) => s + x.value, 0),
  );
  const shown = segments.filter((s) => s.value > 0);
  return (
    <>
      <p
        role="img"
        aria-label={label ?? shown.map((s) => `${s.value} ${s.label}`).join(", ")}
        {...stylex.props(bars.track, thin && bars.thin, gapped && bars.gapped)}
      >
        {shown.map((s) => (
          <span
            key={s.label}
            {...stylex.props(
              bars.seg(toneColor[s.tone], `${(s.value / total) * 100}%`),
              gapped && bars.segRounded,
            )}
          />
        ))}
      </p>
      {keys && (
        <p {...stylex.props(bars.keys)}>
          {shown.map((s) => (
            <span
              key={s.label}
              {...stylex.props(
                bars.key,
                (s.tone === "skipped" || s.tone === "quiet") && bars.keyDim,
              )}
            >
              <i aria-hidden="true" {...stylex.props(bars.dot(toneColor[s.tone]))} />
              {s.value} {s.label}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

const big = stylex.create({
  number: (color: string) => ({
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "clamp(4.5rem, 9vw, 7rem)",
    lineHeight: 0.9,
    color,
    paddingBottom: "0.16em",
    fontVariantNumeric: "lining-nums tabular-nums",
  }),
  title: { marginTop: "0.6rem", color: tokens.ink },
});

/** The one number a page is about. */
export function Big({
  children,
  tone = "metric",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title: ReactNode;
}) {
  return (
    <>
      <p {...stylex.props(big.number(toneColor[tone]))}>{children}</p>
      <p {...stylex.props(type.eyebrow, big.title)}>{title}</p>
    </>
  );
}

export interface StatItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly unit?: ReactNode | undefined;
  readonly tone?: Tone | undefined;
}

const stats = stylex.create({
  list: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
    rowGap: "1.1rem",
    columnGap: "1.5rem",
    marginTop: "1.75rem",
  },
  item: { display: "flex", flexDirection: "column-reverse", justifyContent: "flex-end" },
  value: (color: string) => ({
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "2rem",
    lineHeight: 1,
    paddingBottom: "0.11em",
    color,
    fontVariantNumeric: "lining-nums tabular-nums",
  }),
  label: { marginTop: 4 },
  unit: {
    fontFamily: fonts.mono,
    fontSize: text.micro,
    letterSpacing: "0.08em",
    color: tokens.mauve,
    marginLeft: 8,
  },
});

export function Stats({ items }: { items: ReadonlyArray<StatItem> }) {
  return (
    <dl {...stylex.props(stats.list)}>
      {items.map((s, i) => (
        <div key={i} {...stylex.props(stats.item)}>
          <dt {...stylex.props(type.k, stats.label)}>{s.label}</dt>
          <dd {...stylex.props(stats.value(s.tone ? toneColor[s.tone] : INK))}>
            {s.value}
            {s.unit && <span {...stylex.props(stats.unit)}>{s.unit}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

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

export interface Column<T> {
  readonly key: string;
  readonly head: ReactNode;
  readonly cell: (row: T) => ReactNode;
  readonly right?: boolean;
  readonly dim?: boolean;
  /** The one column that may wrap; the rest stay on one line. */
  readonly wrap?: boolean;
  /** Leave the column out under this viewport width, so the table never scrolls sideways. */
  readonly hideUnder?: 1280 | 1100 | 900;
}

export interface TableSection<T> {
  readonly key: string;
  readonly head: ReactNode;
  readonly rows: ReadonlyArray<T>;
}

const table = stylex.create({
  wrap: { overflowX: "auto" },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.6,
  },
  th: {
    textAlign: "left",
    fontFamily: fonts.mono,
    fontSize: text.micro,
    fontWeight: 400,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: tokens.mauve,
    paddingLeft: { default: 12, ":first-child": 0 },
    paddingRight: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.line,
    whiteSpace: "nowrap",
  },
  td: {
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: { default: 12, ":first-child": 0 },
    paddingRight: 12,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.hair,
    verticalAlign: "top",
  },
  right: {
    textAlign: "right",
    paddingLeft: 10,
    paddingRight: 0,
    fontVariantNumeric: "tabular-nums",
  },
  dim: { color: tokens.mauve },
  middle: { verticalAlign: "middle", whiteSpace: "nowrap" },
  wrapCell: { whiteSpace: "normal", minWidth: "16rem" },
  hover: { backgroundColor: { default: "transparent", ":hover": "rgba(224, 222, 244, 0.02)" } },
  hide1280: { display: { default: "table-cell", "@media (max-width: 1280px)": "none" } },
  hide1100: { display: { default: "table-cell", "@media (max-width: 1100px)": "none" } },
  hide900: { display: { default: "table-cell", "@media (max-width: 900px)": "none" } },
  groupHead: {
    paddingTop: 22,
    paddingBottom: 8,
    paddingRight: 0,
    borderBottomWidth: 0,
  },
  sub: { display: "block", color: tokens.muted, fontSize: text.micro },
});

const hideUnder = {
  1280: table.hide1280,
  1100: table.hide1100,
  900: table.hide900,
} as const;

/**
 * One table. Pass `rows`, or `sections` to head groups of rows with an eyebrow
 * line. `middle` centres cells vertically and keeps them on one line, for tables
 * of figures and sparklines.
 */
export function Table<T>({
  columns,
  rows,
  sections,
  rowKey,
  middle,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows?: ReadonlyArray<T>;
  sections?: ReadonlyArray<TableSection<T>>;
  rowKey: (row: T, i: number) => string;
  middle?: boolean;
}) {
  const body = (list: ReadonlyArray<T>) =>
    list.map((r, i) => (
      <tr key={rowKey(r, i)} {...stylex.props(middle && table.hover)}>
        {columns.map((c) => (
          <td
            key={c.key}
            {...stylex.props(
              table.td,
              c.right && table.right,
              c.dim && table.dim,
              c.hideUnder && hideUnder[c.hideUnder],
              middle && table.middle,
              middle && c.wrap && table.wrapCell,
            )}
          >
            {c.cell(r)}
          </td>
        ))}
      </tr>
    ));
  return (
    <div {...stylex.props(table.wrap)}>
      <table {...stylex.props(table.table)}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                {...stylex.props(
                  table.th,
                  c.right && table.right,
                  c.hideUnder && hideUnder[c.hideUnder],
                )}
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        {sections ? (
          sections.map((s) => (
            <tbody key={s.key}>
              <tr>
                <td colSpan={columns.length} {...stylex.props(table.td, table.groupHead)}>
                  {s.head}
                </td>
              </tr>
              {body(s.rows)}
            </tbody>
          ))
        ) : (
          <tbody>{body(rows ?? [])}</tbody>
        )}
      </table>
    </div>
  );
}

/** A second line under a table cell's value. */
export function Sub({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return <span {...stylex.props(table.sub, tone === "bad" && type.bad)}>{children}</span>;
}

const figures = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
    gap: 1,
    backgroundColor: tokens.hair,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.hair,
  },
  single: { gridTemplateColumns: "1fr" },
  cell: {
    backgroundColor: tokens.surface,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 18,
    paddingRight: 18,
  },
  value: { display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 },
  b: (color: string) => ({
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "1.7rem",
    lineHeight: 1,
    color,
    fontVariantNumeric: "lining-nums tabular-nums",
  }),
  note: { marginTop: 4, color: tokens.muted },
});

/** Side-by-side figures in a hairline grid, as the hyp eval page shows versions. */
export function Figures({
  items,
  single,
}: {
  items: ReadonlyArray<{
    key: string;
    label: ReactNode;
    value: ReactNode;
    unit?: ReactNode | undefined;
    note?: ReactNode | undefined;
    tone?: Tone | undefined;
  }>;
  single?: boolean;
}) {
  return (
    <div {...stylex.props(figures.grid, single && figures.single)}>
      {items.map((it) => (
        <div key={it.key} {...stylex.props(figures.cell)}>
          <p {...stylex.props(type.k)}>{it.label}</p>
          <p {...stylex.props(figures.value)}>
            <b {...stylex.props(figures.b(it.tone ? toneColor[it.tone] : INK))}>{it.value}</b>
            {it.unit && <span {...stylex.props(type.k)}>{it.unit}</span>}
          </p>
          {it.note && <p {...stylex.props(type.k, figures.note)}>{it.note}</p>}
        </div>
      ))}
    </div>
  );
}

/** A plain cell in the figures grid for free-form content (an artifact row, say). */
export function FigureCell({ children }: { children: ReactNode }) {
  return <div {...stylex.props(figures.cell)}>{children}</div>;
}
export function FigureGrid({ children, single }: { children: ReactNode; single?: boolean }) {
  return <div {...stylex.props(figures.grid, single && figures.single)}>{children}</div>;
}

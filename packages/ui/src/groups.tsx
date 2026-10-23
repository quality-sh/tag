// The home page pieces: a search bar whose words become filter chips, the
// group-by rail, sparklines and mini bars for the summary strip, tabs, and
// the delta against a baseline. Plain data in, no knowledge of the API.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, text, tokens } from "./theme.stylex";
import { toneColor, type, type Tone } from "./text.tsx";

// ---------------------------------------------------------------------------
// Search bar

export interface Chip {
  readonly key: string;
  readonly field: string;
  readonly value: string;
}

export interface Suggestion {
  readonly key: string;
  /** Null for the free-text search row. */
  readonly field: string | null;
  readonly value: string;
  readonly count: number | null;
  readonly note: string;
  /** True when choosing it only narrows the next suggestions (a field name). */
  readonly partial: boolean;
}

const search = stylex.create({
  wrap: { position: "relative", zIndex: 5 },
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 2,
    paddingRight: 2,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: { default: tokens.line, ":focus-within": tokens.rosegold },
    transitionProperty: "border-color",
    transitionDuration: "0.2s",
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "12rem",
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    color: tokens.ink,
    backgroundColor: "transparent",
    borderWidth: 0,
    outline: "none",
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 2,
    paddingRight: 2,
    "::placeholder": { color: tokens.muted },
  },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    justifyContent: "flex-end",
    marginLeft: "auto",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    backgroundColor: tokens.surface2,
    borderRadius: sizes.radius,
    paddingTop: 5,
    paddingBottom: 5,
    paddingLeft: 8,
    paddingRight: 6,
    whiteSpace: "nowrap",
  },
  chipField: { color: tokens.mauve, "::after": { content: '":"' } },
  chipValue: { color: tokens.ink },
  chipX: {
    color: { default: tokens.muted, ":hover": tokens.rose },
    backgroundColor: "transparent",
    borderWidth: 0,
    cursor: "pointer",
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    padding: 2,
  },
  menu: {
    position: "absolute",
    left: 0,
    top: "calc(100% + 4px)",
    width: "min(340px, 100%)",
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.hair,
    borderRadius: sizes.cardRadius,
    boxShadow: sizes.shadowOverlay,
    paddingTop: 4,
    paddingBottom: 4,
    listStyle: "none",
    margin: 0,
  },
  item: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "center",
    paddingTop: 7,
    paddingBottom: 7,
    paddingLeft: 12,
    paddingRight: 12,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.4,
    color: tokens.ink,
    cursor: "pointer",
    backgroundColor: { default: "transparent", ":hover": tokens.surface2 },
  },
  itemOn: { backgroundColor: tokens.surface2 },
  itemField: { color: tokens.mauve, "::after": { content: '":"', marginRight: 2 } },
  itemNote: { color: tokens.muted, fontSize: text.micro, whiteSpace: "nowrap" },
  textRow: {
    color: tokens.mauve,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.lineSoft,
    marginTop: 4,
    paddingTop: 9,
  },
});

/**
 * Typed text at the left, applied filters as chips at the right, a flat menu
 * of suggestions under the bar. The parent owns both the typed text and the
 * chips; the bar only reports picks and removals.
 */
export function SearchBar({
  typed,
  onTyped,
  chips,
  onRemove,
  suggestions,
  onPick,
  onSubmit,
  label,
  placeholder = "filter: repo, branch, tag, env, failed:>0, or any text",
}: {
  typed: string;
  onTyped: (text: string) => void;
  chips: ReadonlyArray<Chip>;
  onRemove: (chip: Chip) => void;
  suggestions: ReadonlyArray<Suggestion>;
  onPick: (s: Suggestion) => void;
  /** Enter with no suggestion chosen: the typed text as written. */
  onSubmit: (text: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setActive(0), [suggestions]);
  const show = open && typed.trim().length > 0 && suggestions.length > 0;

  const pick = (s: Suggestion) => {
    onPick(s);
    setOpen(true);
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && show) {
      e.preventDefault();
      setActive((a) => Math.min(suggestions.length - 1, a + 1));
    } else if (e.key === "ArrowUp" && show) {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = show ? suggestions[active] : undefined;
      if (s) pick(s);
      else if (typed.trim()) onSubmit(typed.trim());
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && typed === "" && chips.length > 0) {
      onRemove(chips[chips.length - 1]!);
    }
  };

  return (
    <div {...stylex.props(search.wrap)}>
      <div role="search" aria-label={label} {...stylex.props(search.bar)}>
        <input
          ref={input}
          value={typed}
          onChange={(e) => {
            onTyped(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKey}
          placeholder={chips.length ? "" : placeholder}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={show}
          autoComplete="off"
          spellCheck={false}
          {...stylex.props(search.input)}
        />
        {chips.length > 0 && (
          <span {...stylex.props(search.chips)}>
            {chips.map((c) => (
              <span key={c.key} {...stylex.props(search.chip)}>
                <span {...stylex.props(search.chipField)}>{c.field}</span>
                <span {...stylex.props(search.chipValue)}>{c.value}</span>
                <button
                  type="button"
                  aria-label={`remove ${c.field} ${c.value}`}
                  onClick={() => onRemove(c)}
                  {...stylex.props(search.chipX)}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
      </div>
      {show && (
        <ul role="listbox" aria-label="Suggestions" {...stylex.props(search.menu)}>
          {suggestions.map((s, i) => (
            <li
              key={s.key}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
              {...stylex.props(
                search.item,
                i === active && search.itemOn,
                s.field === null && search.textRow,
              )}
            >
              <span>
                {s.field !== null && <span {...stylex.props(search.itemField)}>{s.field}</span>}
                {s.field === null ? `search for “${s.value}”` : s.value}
              </span>
              <span {...stylex.props(search.itemNote)}>{s.count !== null ? s.count : s.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail and shell

const rail = stylex.create({
  shell: { display: "flex", flexWrap: "wrap", flexGrow: 1 },
  nav: {
    width: 220,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 220,
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: 32,
    paddingRight: 20,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: tokens.hair,
    display: { default: "flex", "@media (max-width: 1000px)": "none" },
    flexDirection: "column",
    gap: 22,
  },
  main: {
    flexGrow: 999,
    flexShrink: 1,
    flexBasis: "720px",
    minWidth: 0,
    paddingTop: 24,
    paddingBottom: 48,
    paddingLeft: 32,
    paddingRight: 32,
  },
  group: { display: "flex", flexDirection: "column", gap: 2 },
  title: { paddingLeft: 10, paddingRight: 10, paddingBottom: 8 },
  item: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.4,
    letterSpacing: "0.04em",
    color: { default: tokens.mauve, ":hover": tokens.ink },
    backgroundColor: { default: "transparent", ":hover": tokens.surface },
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 10,
    borderRadius: sizes.radius,
    textDecoration: "none",
    minWidth: 0,
  },
  itemOn: {
    color: tokens.ink,
    backgroundColor: tokens.surface2,
    boxShadow: `inset 2px 0 0 ${tokens.rosegold}`,
  },
  itemAction: { color: { default: tokens.gold, ":hover": tokens.rosegold } },
  itemLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  count: { color: tokens.muted, fontVariantNumeric: "tabular-nums" },
  countBad: { color: tokens.rose },
  narrow: { display: { default: "none", "@media (max-width: 1000px)": "block" } },
});

/** Shown only where the rail is hidden: a home for the controls the rail holds. */
export function NarrowOnly({ children }: { children: ReactNode }) {
  return <div {...stylex.props(rail.narrow)}>{children}</div>;
}

/** The rail at the left and the page at the right. The rail hides under 1000px. */
export function Shell({ rail: nav, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div {...stylex.props(rail.shell)}>
      <nav aria-label="Views" {...stylex.props(rail.nav)}>
        {nav}
      </nav>
      <main {...stylex.props(rail.main)}>{children}</main>
    </div>
  );
}

export function RailGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div {...stylex.props(rail.group)}>
      <p {...stylex.props(type.eyebrow, rail.title)}>{title}</p>
      {children}
    </div>
  );
}

export function RailItem({
  href,
  on,
  count,
  bad,
  action,
  children,
}: {
  href: string;
  on?: boolean;
  count?: number | undefined;
  bad?: boolean;
  /** Gold: the item does something (new collection) rather than selects a view. */
  action?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      aria-current={on ? "page" : undefined}
      {...stylex.props(rail.item, on && rail.itemOn, action && rail.itemAction)}
    >
      <span {...stylex.props(rail.itemLabel)}>{children}</span>
      {count !== undefined && (
        <span {...stylex.props(rail.count, bad && rail.countBad)}>{count}</span>
      )}
    </a>
  );
}

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

// ---------------------------------------------------------------------------
// Summary strip

const strip = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(4, minmax(0, 1fr))",
      "@media (max-width: 1000px)": "repeat(2, minmax(0, 1fr))",
      "@media (max-width: 560px)": "minmax(0, 1fr)",
    },
    gap: 1,
    backgroundColor: tokens.hair,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.hair,
    borderRadius: sizes.cardRadius,
    overflow: "hidden",
  },
  cell: {
    backgroundColor: tokens.surface,
    paddingTop: 14,
    paddingBottom: 14,
    paddingLeft: 18,
    paddingRight: 18,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: 12,
    alignItems: "end",
    minWidth: 0,
  },
  value: (color: string) => ({
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "1.9rem",
    lineHeight: 1,
    color,
    marginTop: 6,
    fontVariantNumeric: "lining-nums tabular-nums",
  }),
  note: { marginTop: 4 },
});

export interface StripItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly note?: ReactNode | undefined;
  readonly tone?: Tone | undefined;
  readonly bars?: { readonly values: ReadonlyArray<number>; readonly tone?: Tone } | undefined;
}

/** Four figures in a hairline strip, each with its own mini bars. */
export function Strip({ items, label }: { items: ReadonlyArray<StripItem>; label: string }) {
  return (
    <div role="group" aria-label={label} {...stylex.props(strip.grid)}>
      {items.map((it) => (
        <div key={it.key} {...stylex.props(strip.cell)}>
          <div>
            <p {...stylex.props(type.k)}>{it.label}</p>
            <p {...stylex.props(strip.value(it.tone ? toneColor[it.tone] : "#e0def4"))}>
              {it.value}
            </p>
            {it.note && <p {...stylex.props(type.k, strip.note)}>{it.note}</p>}
          </div>
          {it.bars && <MiniBars values={it.bars.values} tone={it.bars.tone ?? "metric"} />}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs, deltas, head rows

const misc = stylex.create({
  tabs: {
    display: "flex",
    gap: 22,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.line,
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  tab: {
    fontFamily: fonts.mono,
    fontSize: text.micro,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: { default: tokens.mauve, ":hover": tokens.ink },
    paddingTop: 10,
    paddingBottom: 10,
    textDecoration: "none",
    whiteSpace: "nowrap",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    marginBottom: -1,
  },
  tabOn: { color: tokens.ink, borderBottomColor: tokens.rosegold },
  delta: { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" },
  unit: { color: tokens.muted, marginLeft: 4 },
  headRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "1.5ch",
  },
  headCount: { color: tokens.muted, letterSpacing: "0.08em", textTransform: "none" },
  name: { fontFamily: fonts.mono, fontSize: 15, lineHeight: 1.3, letterSpacing: 0 },
  sub: {
    display: "block",
    color: tokens.muted,
    fontSize: text.micro,
    letterSpacing: "0.04em",
    marginTop: 2,
    whiteSpace: "normal",
  },
});

export function Tabs({
  items,
}: {
  items: ReadonlyArray<{ key: string; label: ReactNode; href: string; on?: boolean }>;
}) {
  return (
    <nav aria-label="Sections" {...stylex.props(misc.tabs)}>
      {items.map((t) => (
        <a
          key={t.key}
          href={t.href}
          aria-current={t.on ? "page" : undefined}
          {...stylex.props(misc.tab, t.on && misc.tabOn)}
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}

/** A change in percentage points against a baseline. */
export function Delta({ pp, title }: { pp: number | null; title?: string | undefined }) {
  if (pp === null) return <span {...stylex.props(misc.delta, type.dim)}>—</span>;
  const r = Math.round(pp * 10) / 10;
  if (r === 0) return <span {...stylex.props(misc.delta, type.dim)}>±0</span>;
  return (
    <span title={title} {...stylex.props(misc.delta)}>
      <span {...stylex.props(r > 0 ? type.good : type.bad)}>
        {r > 0 ? "+" : "−"}
        {Math.abs(r).toFixed(1)}
      </span>
      <span {...stylex.props(misc.unit)}>pp</span>
    </span>
  );
}

/** The eyebrow that heads a group of table rows: "acme/widgets · 3 releases". */
export function HeadRow({ title, count }: { title: ReactNode; count?: ReactNode }) {
  return (
    <p {...stylex.props(type.eyebrow, misc.headRow)}>
      <span>{title}</span>
      {count !== undefined && <span {...stylex.props(misc.headCount)}>{count}</span>}
    </p>
  );
}

/** A table's name cell: a larger mono name with a dim line under it. */
export function Name({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <span>
      <span {...stylex.props(misc.name)}>{children}</span>
      {sub && <span {...stylex.props(misc.sub)}>{sub}</span>}
    </span>
  );
}

// Tabs, deltas and head rows: the section navigation, the change against a
// baseline in percentage points, and the eyebrow of a table group.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";
import { type } from "./text.tsx";

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

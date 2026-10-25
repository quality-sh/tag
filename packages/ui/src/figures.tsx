// The figures grid: side-by-side labelled values in a hairline grid, and the
// free-form cell a row of artifacts drops into it.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, tokens } from "./theme.stylex";
import { toneColor, type, type Tone } from "./text.tsx";

const INK = "#e0def4";

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

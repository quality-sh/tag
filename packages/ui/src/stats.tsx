// Figures: the one number a page is about, and the stat list under it.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";
import { toneColor, type, type Tone } from "./text.tsx";

const INK = "#e0def4";

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

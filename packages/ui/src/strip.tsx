// The summary strip: four figures in a hairline grid, each with its own mini
// bars.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, tokens } from "./theme.stylex";
import { toneColor, type, type Tone } from "./text.tsx";
import { MiniBars } from "./charts.tsx";

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

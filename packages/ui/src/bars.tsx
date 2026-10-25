// Bars: one stacked bar of tone-coloured segments and the key that reads it.
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";
import { toneColor, type Tone } from "./text.tsx";

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

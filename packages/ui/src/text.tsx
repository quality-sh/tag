import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";

export type Tone =
  "passed" | "failed" | "flaky" | "pending" | "skipped" | "other" | "metric" | "quiet" | "ran";

/** The tone colours as plain strings, for SVG attributes and dynamic styles. Mirrors `tones`. */
export const toneColor: Record<Tone, string> = {
  passed: "#a3be8c",
  failed: "#eb6f92",
  flaky: "#f6c177",
  pending: "#f6c177",
  skipped: "rgba(224, 222, 244, 0.22)",
  other: "#908caa",
  metric: "#c4a7e7",
  quiet: "rgba(224, 222, 244, 0.22)",
  ran: "#908caa",
};

export const type = stylex.create({
  /** Tracked uppercase mono: the section and page eyebrows. */
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: text.micro,
    fontWeight: 400,
    lineHeight: 1.4,
    letterSpacing: text.labelTracking,
    textTransform: "uppercase",
    color: tokens.mauve,
  },
  /** Key facts: small mono, lightly tracked, in mauve. */
  k: {
    fontFamily: fonts.mono,
    fontSize: text.micro,
    fontWeight: 400,
    lineHeight: 1.5,
    letterSpacing: "0.08em",
    color: tokens.mauve,
  },
  small: {
    fontFamily: fonts.mono,
    fontSize: text.small,
    fontWeight: 400,
    lineHeight: 1.6,
    color: tokens.ink,
  },
  /** An italic line under a title. */
  q: {
    fontFamily: fonts.display,
    fontStyle: "italic",
    fontWeight: 400,
    fontSize: "1.2rem",
    lineHeight: 1.35,
    color: tokens.mauve,
  },
  prose: {
    fontFamily: fonts.display,
    fontSize: text.prose,
    lineHeight: 1.5,
    color: tokens.ink,
  },
  num: { fontVariantNumeric: "lining-nums tabular-nums" },
  ink: { color: tokens.ink },
  accent: { color: tokens.rosegold },
  bad: { color: tokens.rose },
  warn: { color: tokens.amber },
  good: { color: tokens.sage },
  dim: { color: tokens.muted },
  link: {
    color: { default: tokens.gold, ":hover": tokens.rosegold },
    textDecoration: "none",
    transitionProperty: "color",
    transitionDuration: "0.15s",
  },
  inkLink: {
    color: { default: tokens.ink, ":hover": tokens.rosegold },
    textDecoration: "none",
  },
});

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p {...stylex.props(type.eyebrow)}>{children}</p>;
}

/** A small mono fact. Inline by default. */
export function K({
  children,
  block,
  tone,
}: {
  children: ReactNode;
  block?: boolean;
  tone?: "ink" | "bad" | "warn" | "good" | "dim";
}) {
  const styles = [type.k, tone && type[tone]];
  return block ? (
    <p {...stylex.props(...styles)}>{children}</p>
  ) : (
    <span {...stylex.props(...styles)}>{children}</span>
  );
}

export function Accent({ children }: { children: ReactNode }) {
  return <span {...stylex.props(type.accent)}>{children}</span>;
}
export function Bad({ children }: { children: ReactNode }) {
  return <span {...stylex.props(type.bad)}>{children}</span>;
}
export function Warn({ children }: { children: ReactNode }) {
  return <span {...stylex.props(type.warn)}>{children}</span>;
}
export function Ink({ children }: { children: ReactNode }) {
  return <span {...stylex.props(type.ink)}>{children}</span>;
}

export function Link({
  href,
  children,
  external,
  ink,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
  ink?: boolean;
}) {
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      {...stylex.props(ink ? type.inkLink : type.link)}
    >
      {children}
    </a>
  );
}

export function Q({ children }: { children: ReactNode }) {
  return <p {...stylex.props(type.q)}>{children}</p>;
}

const mark = stylex.create({
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1,
    whiteSpace: "nowrap",
    color: tokens.ink,
  },
  dot: (color: string) => ({
    width: 8,
    height: 8,
    borderRadius: 2,
    display: "inline-block",
    backgroundColor: color,
    flexShrink: 0,
  }),
});

/** A status word with its coloured square. The word always carries the meaning. */
export function Mark({ tone, children }: { tone: Tone; children?: ReactNode }) {
  return (
    <span {...stylex.props(mark.base)}>
      <i {...stylex.props(mark.dot(toneColor[tone]))} aria-hidden="true" />
      {children ?? tone}
    </span>
  );
}

export const toneOf = (status: string, flaky?: boolean | number): Tone => {
  if (flaky) return "flaky";
  switch (status) {
    case "passed":
    case "failed":
    case "skipped":
    case "pending":
      return status;
    default:
      return "other";
  }
};

const blocks = stylex.create({
  message: {
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.6,
    color: tokens.rose,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    marginTop: 6,
  },
  trace: {
    marginTop: 10,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 14,
    overflowX: "auto",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.hair,
    borderRadius: 6,
    backgroundColor: tokens.surface,
    fontFamily: fonts.mono,
    fontSize: text.micro,
    lineHeight: 1.6,
    color: tokens.mauve,
    whiteSpace: "pre-wrap",
  },
  summary: {
    cursor: "pointer",
    fontFamily: fonts.mono,
    fontSize: text.micro,
    letterSpacing: "0.08em",
    color: { default: tokens.mauve, ":hover": tokens.rosegold },
    listStyle: "none",
  },
  chevron: {
    display: "inline-block",
    marginRight: 8,
    transitionProperty: "transform",
    transitionDuration: "0.15s",
  },
  chevronOpen: { transform: "rotate(90deg)" },
  points: { listStyle: "none" },
  point: {
    position: "relative",
    paddingLeft: "1.1em",
    marginTop: { default: 0, ":not(:first-child)": "0.45em" },
    "::before": {
      content: '""',
      position: "absolute",
      left: 0,
      top: "calc(0.75em - 0.5px)",
      width: "0.5em",
      height: 1,
      backgroundColor: tokens.mauve,
    },
  },
  empty: {
    color: tokens.mauve,
    fontStyle: "italic",
    paddingTop: "1rem",
    paddingBottom: "1rem",
  },
  io: { display: "grid", gap: 10, marginTop: 10 },
  ioValue: {
    fontFamily: fonts.display,
    fontSize: text.body,
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: 14,
    paddingRight: 14,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: tokens.line,
    color: tokens.ink,
  },
});

export function Message({ children }: { children: ReactNode }) {
  return <p {...stylex.props(blocks.message)}>{children}</p>;
}

export function Trace({ children }: { children: ReactNode }) {
  return <pre {...stylex.props(blocks.trace)}>{children}</pre>;
}

export function Disclosure({
  summary,
  children,
  open,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open}>
      <summary {...stylex.props(blocks.summary)}>
        <span {...stylex.props(blocks.chevron)}>›</span>
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** Bullet points drawn with a short rule rather than a dot. */
export function Points({ items }: { items: ReadonlyArray<ReactNode> }) {
  return (
    <ul {...stylex.props(blocks.points)}>
      {items.map((it, i) => (
        <li key={i} {...stylex.props(blocks.point)}>
          {it}
        </li>
      ))}
    </ul>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p {...stylex.props(blocks.empty)}>{children}</p>;
}

/** Labelled prose values, as DeepEval's input, output and context. */
export function Fields({ items }: { items: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <div {...stylex.props(blocks.io)}>
      {items.map((f) => (
        <div key={f.label}>
          <p {...stylex.props(type.eyebrow)}>{f.label}</p>
          <p {...stylex.props(blocks.ioValue)}>{f.value}</p>
        </div>
      ))}
    </div>
  );
}

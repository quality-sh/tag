import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens, layout } from "./theme.stylex";
import { type } from "./text.tsx";

const lead = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) minmax(0, 2.3fr)",
      "@media (max-width: 1100px)": "minmax(0, 1fr) minmax(0, 2fr)",
      "@media (max-width: 900px)": "minmax(0, 1fr)",
    },
    gap: "2rem",
    alignItems: "start",
    paddingTop: "0.25rem",
  },
  aside: { minWidth: 0, display: "grid", gap: 16 },
  split: { marginTop: "1.75rem" },
});

/** The lead of a page: the big number and its stats at the left, cards at the right. */
export function Lead({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div {...stylex.props(lead.grid)}>
      <div>{children}</div>
      {aside && <div {...stylex.props(lead.aside)}>{aside}</div>}
    </div>
  );
}

export function Split({ children }: { children: ReactNode }) {
  return <div {...stylex.props(lead.split)}>{children}</div>;
}

const rows = stylex.create({
  list: {
    listStyle: "none",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.hair,
  },
  row: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.hair,
    paddingTop: 18,
    paddingBottom: 18,
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    rowGap: 6,
    columnGap: 18,
  },
  h3: {
    fontFamily: fonts.display,
    fontWeight: 400,
    fontSize: text.h2,
    lineHeight: 1.15,
    fontVariantNumeric: "lining-nums",
  },
  when: { marginLeft: "auto" },
  body: { marginTop: 12 },
  reports: { display: "grid", gap: 8, marginTop: 12 },
  report: {
    display: "grid",
    gridTemplateColumns: {
      default: "9rem minmax(0, 1fr) auto",
      "@media (max-width: 700px)": "1fr",
    },
    rowGap: { default: 8, "@media (max-width: 700px)": 4 },
    columnGap: 20,
    alignItems: "center",
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.6,
  },
  count: { color: tokens.mauve, whiteSpace: "nowrap" },
});

/** Hairline-separated rows: runs, failures, evaluation cases. */
export function Rows({ children }: { children: ReactNode }) {
  return <ul {...stylex.props(rows.list)}>{children}</ul>;
}

export function Row({
  title,
  facts,
  when,
  children,
}: {
  title: ReactNode;
  facts?: ReactNode;
  when?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li {...stylex.props(rows.row)}>
      <div {...stylex.props(rows.head)}>
        <h3 {...stylex.props(rows.h3)}>{title}</h3>
        {facts}
        {when && <span {...stylex.props(type.k, rows.when)}>{when}</span>}
      </div>
      {children && <div {...stylex.props(rows.body)}>{children}</div>}
    </li>
  );
}

/** One report under a run: the tool, its bar, its counts. */
export function ReportLine({
  tool,
  bar,
  count,
}: {
  tool: ReactNode;
  bar: ReactNode;
  count: ReactNode;
}) {
  return (
    <div {...stylex.props(rows.report)}>
      <span>{tool}</span>
      <div>{bar}</div>
      <span {...stylex.props(rows.count)}>{count}</span>
    </div>
  );
}

export function ReportLines({ children }: { children: ReactNode }) {
  return <div {...stylex.props(rows.reports)}>{children}</div>;
}

const stack = stylex.create({
  grid: (gap: number) => ({ display: "grid", gap }),
  inline: (gap: number) => ({ display: "flex", flexWrap: "wrap", gap, alignItems: "center" }),
  mt: (px: number) => ({ marginTop: px }),
});

export function Stack({ children, gap = 10 }: { children: ReactNode; gap?: number }) {
  return <div {...stylex.props(stack.grid(gap))}>{children}</div>;
}
export function Inline({ children, gap = 8 }: { children: ReactNode; gap?: number }) {
  return <div {...stylex.props(stack.inline(gap))}>{children}</div>;
}
export function Space({ children, top = 14 }: { children: ReactNode; top?: number }) {
  return <div {...stylex.props(stack.mt(top))}>{children}</div>;
}

const rise = stylex.keyframes({
  "0%": { opacity: 0.35, transform: "translateY(14px)" },
  "100%": { opacity: 1, transform: "none" },
});

const login = stylex.create({
  shell: {
    minHeight: "calc(100vh - 73px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingTop: "2rem",
    paddingBottom: "2rem",
    paddingLeft: layout.edge,
    paddingRight: layout.edge,
  },
  inner: { textAlign: "center", maxWidth: "36rem" },
  h1: {
    marginTop: 24,
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "clamp(40px, 6vw, 72px)",
    lineHeight: 1.05,
    letterSpacing: "0.01em",
  },
  p: { marginTop: 18, color: tokens.mauve },
  form: { marginTop: 36, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" },
  error: { color: tokens.rose, fontFamily: fonts.mono, fontSize: text.small, marginTop: 14 },
  rise: {
    animationName: rise,
    animationDuration: "0.8s",
    animationTimingFunction: "cubic-bezier(0.19, 0.6, 0.26, 1)",
    animationFillMode: "backwards",
  },
});

/** The centred sign-in page. */
export function LoginShell({
  eyebrow,
  title,
  lede,
  onSubmit,
  children,
  error,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  onSubmit: () => void;
  children: ReactNode;
  error?: ReactNode;
}) {
  return (
    <div {...stylex.props(login.shell)}>
      <div {...stylex.props(login.inner, login.rise)}>
        <p {...stylex.props(type.eyebrow)}>{eyebrow}</p>
        <h1 {...stylex.props(login.h1)}>{title}</h1>
        {lede && <p {...stylex.props(type.prose, login.p)}>{lede}</p>}
        <form
          {...stylex.props(login.form)}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
        </form>
        {error && <p {...stylex.props(login.error)}>{error}</p>}
      </div>
    </div>
  );
}

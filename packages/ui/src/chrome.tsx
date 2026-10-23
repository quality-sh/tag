import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, text, tokens, layout } from "./theme.stylex";
import { type } from "./text.tsx";

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

const bar = stylex.create({
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    paddingLeft: layout.edge,
    paddingRight: layout.edge,
    height: sizes.topbar,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.line,
    position: "sticky",
    top: 0,
    zIndex: 20,
    backgroundColor: tokens.bg,
  },
  wordmark: {
    display: "inline-flex",
    alignItems: "center",
    gap: 12,
    fontFamily: fonts.display,
    fontWeight: 500,
    fontSize: 21,
    lineHeight: 1.2,
    letterSpacing: "0.14em",
    color: tokens.ink,
    whiteSpace: "nowrap",
    textDecoration: "none",
  },
  wordmarkSmall: { fontSize: 17 },
  crumbs: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    display: "flex",
    gap: 8,
    fontFamily: fonts.mono,
    fontSize: text.micro,
    lineHeight: 1.5,
    letterSpacing: "0.06em",
    color: tokens.muted,
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  crumb: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: "3ch",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  up: { color: tokens.mauve, textDecoration: "none" },
  upLink: { color: { default: tokens.mauve, ":hover": tokens.rosegold } },
  here: { color: tokens.ink },
  arrow: { flexShrink: 0, color: tokens.muted },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    fontFamily: fonts.mono,
    fontSize: text.micro,
    lineHeight: 1,
    letterSpacing: "0.08em",
    color: tokens.mauve,
  },
  foot: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
    paddingTop: 24,
    paddingBottom: 24,
    paddingLeft: layout.edge,
    paddingRight: layout.edge,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.line,
    marginTop: 24,
  },
  footLinks: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    fontFamily: fonts.display,
    fontSize: text.lead,
  },
  footLink: { color: { default: tokens.mauve, ":hover": tokens.rosegold } },
});

/** The sticky bar: wordmark, breadcrumb trail in mono, actions at the right. */
export function Topbar({
  wordmark,
  href = "#/",
  crumbs = [],
  actions,
}: {
  wordmark: string;
  href?: string;
  crumbs?: ReadonlyArray<Crumb>;
  actions?: ReactNode;
}) {
  return (
    <header {...stylex.props(bar.topbar)}>
      <a href={href} {...stylex.props(bar.wordmark)}>
        {wordmark}
      </a>
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" {...stylex.props(bar.crumbs)}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <span key={i} style={{ display: "contents" }}>
                {i > 0 && (
                  <span aria-hidden="true" {...stylex.props(bar.arrow)}>
                    ›
                  </span>
                )}
                {last || !c.href ? (
                  <span
                    aria-current={last ? "page" : undefined}
                    {...stylex.props(bar.crumb, last ? bar.here : bar.up)}
                  >
                    {c.label}
                  </span>
                ) : (
                  <a href={c.href} {...stylex.props(bar.crumb, bar.up, bar.upLink)}>
                    {c.label}
                  </a>
                )}
              </span>
            );
          })}
        </nav>
      )}
      {actions && <div {...stylex.props(bar.actions)}>{actions}</div>}
    </header>
  );
}

const action = stylex.create({
  button: {
    color: { default: tokens.mauve, ":hover": tokens.rosegold },
    fontFamily: fonts.mono,
    fontSize: text.micro,
    letterSpacing: "0.08em",
  },
});

/** A quiet mono action in the topbar. */
export function TopbarAction({
  onClick,
  children,
  href,
}: {
  onClick?: () => void;
  children: ReactNode;
  href?: string;
}) {
  return href ? (
    <a href={href} {...stylex.props(action.button)}>
      {children}
    </a>
  ) : (
    <button type="button" onClick={onClick} {...stylex.props(action.button)}>
      {children}
    </button>
  );
}

export function Foot({ wordmark, links }: { wordmark: string; links?: ReadonlyArray<Crumb> }) {
  return (
    <footer {...stylex.props(bar.foot)}>
      <span {...stylex.props(bar.wordmark, bar.wordmarkSmall)}>{wordmark}</span>
      {links && (
        <nav {...stylex.props(bar.footLinks)}>
          {links.map((l) => (
            <a key={l.label} href={l.href} {...stylex.props(bar.footLink)}>
              {l.label}
            </a>
          ))}
        </nav>
      )}
    </footer>
  );
}

const page = stylex.create({
  main: { paddingLeft: layout.edge, paddingRight: layout.edge, paddingBottom: "4rem" },
  head: {
    paddingTop: "2.5rem",
    paddingBottom: "1.75rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    rowGap: "1rem",
    columnGap: "2rem",
  },
  headMain: { minWidth: 0, maxWidth: "48rem", flexGrow: 1, flexShrink: 1, flexBasis: "100%" },
  h1: {
    marginTop: "0.35rem",
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "clamp(2rem, 4.6vw, 3.4rem)",
    lineHeight: 1.05,
    letterSpacing: "0.01em",
    overflowWrap: "anywhere",
    textWrap: "pretty",
    fontVariantNumeric: "lining-nums",
  },
  q: { marginTop: "0.7rem" },
  facts: { marginTop: "0.7rem" },
  aside: { flexShrink: 0, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  section: { paddingTop: "2rem" },
  sectionRule: {
    marginTop: "1.5rem",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: tokens.line,
  },
  sectionEyebrow: { display: "flex", alignItems: "baseline", gap: "1.5ch" },
  count: { color: tokens.muted, letterSpacing: "0.08em" },
  h2: {
    fontFamily: fonts.display,
    fontWeight: 300,
    fontSize: "clamp(32px, 3.4vw, 44px)",
    lineHeight: 1.12,
    marginTop: 14,
    maxWidth: "22em",
    textWrap: "pretty",
  },
  lede: { color: tokens.mauve, maxWidth: "34em", marginTop: 10 },
  body: { marginTop: 14 },
  sep: { overflow: "hidden" },
  sepRow: { display: "flex", flexWrap: "wrap", marginLeft: "-3ch" },
  sepItem: {
    whiteSpace: "nowrap",
    "::before": {
      content: '"·"',
      display: "inline-block",
      width: "3ch",
      letterSpacing: 0,
      textAlign: "center",
      color: tokens.mauve,
    },
  },
});

export function Page({ children }: { children: ReactNode }) {
  return <main {...stylex.props(page.main)}>{children}</main>;
}

/** Facts separated by middle dots that wrap cleanly. */
export function Facts({
  children,
  tone = "k",
}: {
  children: ReadonlyArray<ReactNode>;
  tone?: "k" | "eyebrow";
}) {
  const items = children.filter((c) => c !== null && c !== undefined && c !== false && c !== "");
  return (
    <p {...stylex.props(type[tone], page.sep)}>
      <span {...stylex.props(page.sepRow)}>
        {items.map((c, i) => (
          <span key={i} {...stylex.props(page.sepItem)}>
            {c}
          </span>
        ))}
      </span>
    </p>
  );
}

/** The page head: eyebrow, large light title, an italic line, then key facts. */
export function Head({
  eyebrow,
  title,
  question,
  facts,
  aside,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  question?: ReactNode;
  facts?: ReadonlyArray<ReactNode>;
  aside?: ReactNode;
}) {
  return (
    <div {...stylex.props(page.head)}>
      <div {...stylex.props(page.headMain)}>
        <p {...stylex.props(type.eyebrow)}>{eyebrow}</p>
        <h1 {...stylex.props(page.h1)}>{title}</h1>
        {question && <p {...stylex.props(type.q, page.q)}>{question}</p>}
        {facts && facts.length > 0 && (
          <div {...stylex.props(page.facts)}>
            <Facts>{facts}</Facts>
          </div>
        )}
      </div>
      {aside && <div {...stylex.props(page.aside)}>{aside}</div>}
    </div>
  );
}

export function Section({
  eyebrow,
  count,
  title,
  lede,
  children,
  first,
}: {
  eyebrow: ReactNode;
  count?: ReactNode;
  title?: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  first?: boolean;
}) {
  return (
    <section {...stylex.props(page.section, !first && page.sectionRule)}>
      <p {...stylex.props(type.eyebrow, page.sectionEyebrow)}>
        <span>{eyebrow}</span>
        {count !== undefined && <span {...stylex.props(page.count)}>{count}</span>}
      </p>
      {title && <h2 {...stylex.props(page.h2)}>{title}</h2>}
      {lede && <p {...stylex.props(type.prose, page.lede)}>{lede}</p>}
      {children && <div {...stylex.props(page.body)}>{children}</div>}
    </section>
  );
}

const box = stylex.create({
  card: {
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.hair,
    borderRadius: sizes.cardRadius,
  },
  pad: { paddingTop: 16, paddingBottom: 16, paddingLeft: 18, paddingRight: 18 },
  cardHead: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "baseline",
    rowGap: 6,
    columnGap: 16,
    paddingTop: 16,
    paddingLeft: 18,
    paddingRight: 18,
  },
  frame: {
    position: "relative",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.line,
    borderRadius: sizes.cardRadius,
    overflow: "hidden",
    backgroundColor: tokens.bg,
    boxShadow: sizes.shadowFrame,
  },
  frameBar: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 18,
    paddingRight: 18,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.line,
  },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  iframe: {
    display: "block",
    width: "100%",
    height: { default: "74vh", "@media (max-width: 760px)": "60vh" },
    borderWidth: 0,
    backgroundColor: "#ffffff",
  },
});

export function Card({
  children,
  pad = true,
  head,
  meta,
}: {
  children: ReactNode;
  pad?: boolean;
  head?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div {...stylex.props(box.card, pad && box.pad)}>
      {head && (
        <div {...stylex.props(box.cardHead)}>
          <p {...stylex.props(type.eyebrow)}>{head}</p>
          {meta && <p {...stylex.props(type.k)}>{meta}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

/** An embedded page (a Playwright report, a trace viewer) in a framed, shadowed viewport. */
export function Frame({
  title,
  src,
  meta,
  sandbox = "allow-scripts allow-same-origin allow-popups allow-downloads allow-forms",
}: {
  title: string;
  src: string;
  meta?: ReactNode;
  sandbox?: string;
}) {
  return (
    <div {...stylex.props(box.frame)}>
      <div {...stylex.props(box.frameBar)}>
        <span {...stylex.props(type.small)}>{title}</span>
        <span {...stylex.props(type.k, box.grow)}>{meta}</span>
        <a href={src} target="_blank" rel="noreferrer" {...stylex.props(type.k, type.link)}>
          open in new tab ↗
        </a>
      </div>
      <iframe title={title} src={src} sandbox={sandbox} {...stylex.props(box.iframe)} />
    </div>
  );
}

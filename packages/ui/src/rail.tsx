// The rail and the shell: the group-by navigation at the left, the page at the
// right, and the narrow-viewport home for the controls the rail hides.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, sizes, text, tokens } from "./theme.stylex";
import { type } from "./text.tsx";

// ---------------------------------------------------------------------------
// Rail and shell

const rail = stylex.create({
  shell: { display: "flex", flexWrap: "wrap", flexGrow: 1 },
  nav: {
    width: 220,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 220,
    paddingTop: 40,
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
    paddingTop: 0,
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
  onClick,
  children,
}: {
  href: string;
  on?: boolean;
  count?: number | undefined;
  bad?: boolean;
  /** Gold: the item does something (new collection) rather than selects a view. */
  action?: boolean;
  /** An in-page jump: the handler scrolls, the href stays for the context menu. */
  onClick?: ((e: React.MouseEvent<HTMLAnchorElement>) => void) | undefined;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={onClick}
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

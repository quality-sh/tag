// The table: columns and rows (or headed sections of rows) in mono, with the
// responsive and alignment rules a full-table view needs.
import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { fonts, text, tokens } from "./theme.stylex";
import { type } from "./text.tsx";

export interface Column<T> {
  readonly key: string;
  readonly head: ReactNode;
  readonly cell: (row: T) => ReactNode;
  readonly right?: boolean;
  readonly dim?: boolean;
  /** The one column that may wrap; the rest stay on one line. */
  readonly wrap?: boolean;
  /** Leave the column out under this viewport width, so the table never scrolls sideways. */
  readonly hideUnder?: 1280 | 1100 | 900;
}

export interface TableSection<T> {
  readonly key: string;
  readonly head: ReactNode;
  readonly rows: ReadonlyArray<T>;
}

const table = stylex.create({
  wrap: { overflowX: "auto" },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: fonts.mono,
    fontSize: text.small,
    lineHeight: 1.6,
  },
  th: {
    textAlign: "left",
    fontFamily: fonts.mono,
    fontSize: text.micro,
    fontWeight: 400,
    letterSpacing: "0.22em",
    textTransform: "uppercase",
    color: tokens.mauve,
    paddingLeft: { default: 12, ":first-child": 0 },
    paddingRight: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.line,
    whiteSpace: "nowrap",
  },
  td: {
    paddingTop: 10,
    paddingBottom: 10,
    paddingLeft: { default: 12, ":first-child": 0 },
    paddingRight: 12,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.hair,
    verticalAlign: "top",
    // Long unbroken names (`crate::module::test`) may break anywhere, so a table never
    // grows past its column; `nowrap` cells are unaffected.
    overflowWrap: "anywhere",
  },
  right: {
    textAlign: "right",
    paddingLeft: 10,
    paddingRight: 0,
    fontVariantNumeric: "tabular-nums",
  },
  dim: { color: tokens.mauve },
  middle: { verticalAlign: "middle", whiteSpace: "nowrap" },
  wrapCell: { whiteSpace: "normal", minWidth: "16rem" },
  hover: { backgroundColor: { default: "transparent", ":hover": "rgba(224, 222, 244, 0.02)" } },
  hide1280: { display: { default: "table-cell", "@media (max-width: 1280px)": "none" } },
  hide1100: { display: { default: "table-cell", "@media (max-width: 1100px)": "none" } },
  hide900: { display: { default: "table-cell", "@media (max-width: 900px)": "none" } },
  groupHead: {
    paddingTop: 22,
    paddingBottom: 8,
    paddingRight: 0,
    borderBottomWidth: 0,
  },
  sub: { display: "block", color: tokens.muted, fontSize: text.micro },
});

const hideUnder = {
  1280: table.hide1280,
  1100: table.hide1100,
  900: table.hide900,
} as const;

/**
 * One table. Pass `rows`, or `sections` to head groups of rows with an eyebrow
 * line. `middle` centres cells vertically and keeps them on one line, for tables
 * of figures and sparklines.
 */
export function Table<T>({
  columns,
  rows,
  sections,
  rowKey,
  middle,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows?: ReadonlyArray<T>;
  sections?: ReadonlyArray<TableSection<T>>;
  rowKey: (row: T, i: number) => string;
  middle?: boolean;
}) {
  const body = (list: ReadonlyArray<T>) =>
    list.map((r, i) => (
      <tr key={rowKey(r, i)} {...stylex.props(middle && table.hover)}>
        {columns.map((c) => (
          <td
            key={c.key}
            {...stylex.props(
              table.td,
              c.right && table.right,
              c.dim && table.dim,
              c.hideUnder && hideUnder[c.hideUnder],
              middle && table.middle,
              middle && c.wrap && table.wrapCell,
            )}
          >
            {c.cell(r)}
          </td>
        ))}
      </tr>
    ));
  return (
    <div {...stylex.props(table.wrap)}>
      <table {...stylex.props(table.table)}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                {...stylex.props(
                  table.th,
                  c.right && table.right,
                  c.hideUnder && hideUnder[c.hideUnder],
                )}
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        {sections ? (
          sections.map((s) => (
            <tbody key={s.key}>
              <tr>
                <td colSpan={columns.length} {...stylex.props(table.td, table.groupHead)}>
                  {s.head}
                </td>
              </tr>
              {body(s.rows)}
            </tbody>
          ))
        ) : (
          <tbody>{body(rows ?? [])}</tbody>
        )}
      </table>
    </div>
  );
}

/** A second line under a table cell's value. */
export function Sub({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return <span {...stylex.props(table.sub, tone === "bad" && type.bad)}>{children}</span>;
}

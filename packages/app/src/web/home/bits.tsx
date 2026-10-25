// The numbers and the verdict mark that the group views share.
import type { ReactNode } from "react";
import { K, Mark } from "@quality-sh/tag-ui";

export const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

export const Good = ({ n }: { n: number | undefined }) =>
  n === undefined ? <Dim>—</Dim> : n > 0 ? <K tone="good">{n}</K> : <Dim>0</Dim>;
export const Dim = ({ children }: { children: ReactNode }) => <K tone="dim">{children}</K>;

export const Verdict = ({ failed, none }: { failed: boolean; none?: boolean }) =>
  none ? (
    <Mark tone="quiet">no runs</Mark>
  ) : (
    <Mark tone={failed ? "failed" : "passed"}>{failed ? "failed" : "passed"}</Mark>
  );

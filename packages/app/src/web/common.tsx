// Pieces every page shares: the async result switch, the sign-out action, the
// outcome segments of a report.
import type { ReactNode } from "react";
import { Cause } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet } from "@effect/atom-react/Hooks";
import { Empty, TopbarAction, type Segment } from "@quality-sh/tag-ui";
import { Unauthorized } from "./client.ts";
import { logoutFn, sessionAtom } from "./state.ts";

export function Loaded<A, E>({
  result,
  children,
}: {
  result: AsyncResult.AsyncResult<A, E>;
  children: (value: A) => ReactNode;
}) {
  const refreshSession = useAtomRefresh(sessionAtom);
  return AsyncResult.match(result, {
    onInitial: () => <Empty>Loading…</Empty>,
    onFailure: (f) => {
      const err = Cause.squash(f.cause);
      if (err instanceof Unauthorized)
        return (
          <Empty>
            Your session ended.{" "}
            <a href="#/" onClick={refreshSession}>
              Sign in again
            </a>
            .
          </Empty>
        );
      return <Empty>Could not load: {err instanceof Error ? err.message : String(err)}</Empty>;
    },
    onSuccess: (s) => (
      <div style={{ opacity: s.waiting ? 0.6 : 1, transition: "opacity .2s" }}>
        {children(s.value)}
      </div>
    ),
  });
}

export const segmentsOf = (r: {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  pending: number;
  other: number;
}): Segment[] => [
  { tone: "passed", value: r.passed - r.flaky, label: "passed" },
  { tone: "flaky", value: r.flaky, label: "flaky" },
  { tone: "failed", value: r.failed, label: "failed" },
  { tone: "other", value: r.other + r.pending, label: "other" },
  { tone: "skipped", value: r.skipped, label: "skipped" },
];

export function SignOut() {
  const logout = useAtomSet(logoutFn);
  return <TopbarAction onClick={() => logout()}>sign out</TopbarAction>;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

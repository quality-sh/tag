// A repository's ingest state on the pages: "backfilling, N of M" while its history lands.
import { useEffect } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import { K } from "@quality-sh/tag-ui";
import type { RepositoryState } from "./client.ts";
import { progressText } from "./onboarding-steps.ts";
import { refreshRunsFn, repositoriesAtom } from "./state.ts";

const POLL_MS = 2000;

/** The repositories still walking their history. Polls while there is one. */
export function useBackfilling(): ReadonlyArray<RepositoryState> {
  const result = useAtomValue(repositoriesAtom);
  const refresh = useAtomRefresh(repositoriesAtom);
  const refreshRuns = useAtomSet(refreshRunsFn);
  // "new" is a repository still listing its runs; it shows as backfilling with no total yet.
  const backfilling = AsyncResult.isSuccess(result)
    ? result.value.filter((r) => r.state !== "current")
    : [];
  const active = backfilling.length > 0;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      refresh();
      refreshRuns();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [active, refresh, refreshRuns]);
  return backfilling;
}

export const backfillOf = (
  states: ReadonlyArray<RepositoryState>,
  owner: string,
  repo: string,
): RepositoryState | undefined => states.find((s) => s.owner === owner && s.repo === repo);

export { progressText };

/** One line per repository still backfilling, for a toolbar. */
export function BackfillStatus({ states }: { states: ReadonlyArray<RepositoryState> }) {
  if (states.length === 0) return null;
  return (
    <span role="status">
      <K tone="dim">{states.map((s) => `${s.owner}/${s.repo}: ${progressText(s)}`).join(" · ")}</K>
    </span>
  );
}

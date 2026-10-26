// The onboarding page: install the App, see what each repository needs, and meet the first
// report. Every step is a link or a button; nothing here asks for typing.
import { useEffect } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Empty,
  Inline,
  K,
  Link,
  Prose,
  Section,
  Shell,
  Stack,
  Topbar,
  plural,
} from "@quality-sh/tag-ui";
import { useBackfilling } from "./backfill.tsx";
import type { RepoRow } from "./client.ts";
import { Loaded, SignOut } from "./common.tsx";
import { Rail } from "./home.tsx";
import {
  firstReportOf,
  firstReporting,
  stepsOf,
  stillWaiting,
  type RepositoryStep,
} from "./onboarding-steps.ts";
import { scanNote } from "./overview.tsx";
import { ProposalAction, PullRequestLine } from "./proposal.tsx";
import {
  href,
  overviewAtom,
  overviewKey,
  proposalAtom,
  refreshRunsFn,
  repoRunsAtom,
  repositoriesAtom,
  sessionAtom,
} from "./state.ts";

const POLL_MS = 2000;
const RANGE = "30d";

export function OnboardingPage() {
  const session = useAtomValue(sessionAtom);
  const installUrl = AsyncResult.isSuccess(session) ? session.value.installUrl : undefined;
  return (
    <>
      <Topbar
        wordmark="TAG"
        href={href.overview()}
        crumbs={[{ label: "Add repositories" }]}
        actions={<SignOut />}
      />
      <Shell rail={<Rail onboarding range={RANGE} />}>
        {installUrl ? <InstallStep url={installUrl} /> : <Repositories />}
      </Shell>
    </>
  );
}

function InstallStep({ url }: { url: string }) {
  return (
    <Section
      eyebrow="Install"
      title="Install the App on GitHub."
      lede="TAG reads the test reports your GitHub Actions runs already upload. Pick the repositories it may read, and GitHub sends you back here."
      first
    >
      <Link href={url}>Install on GitHub</Link>
    </Section>
  );
}

/** Ask again while history, scans or the first report are still on their way. */
function usePolling(on: boolean) {
  const refreshRuns = useAtomSet(refreshRunsFn);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => refreshRuns(), POLL_MS);
    return () => clearInterval(id);
  }, [on, refreshRuns]);
}

function Repositories() {
  const overview = useAtomValue(overviewAtom(overviewKey({ range: RANGE, q: "" })));
  const states = useAtomValue(repositoriesAtom);
  // It polls on its own while a repository backfills; the page polls the rest of the wait.
  const backfilling = useBackfilling();
  const steps =
    AsyncResult.isSuccess(overview) && AsyncResult.isSuccess(states)
      ? stepsOf({
          states: states.value,
          scans: overview.value.scans,
          repoList: overview.value.repoList,
        })
      : undefined;
  const repoList = AsyncResult.isSuccess(overview) ? overview.value.repoList : [];
  usePolling(steps !== undefined && backfilling.length === 0 && stillWaiting(steps, repoList));
  const first = firstReporting(repoList);
  return (
    <Loaded result={overview}>
      {() => (
        <>
          <Section
            eyebrow="Repositories"
            count={steps ? plural(steps.length, "repository", "repositories") : undefined}
            title="What each repository needs."
            lede="TAG walks each repository's recent runs, then checks its workflows for tests."
            first
          >
            {first ? <FirstReport row={first} /> : <K tone="dim">Waiting for the first report.</K>}
          </Section>
          {steps?.length === 0 && <Empty>TAG is listing the repositories the App can read.</Empty>}
          {steps?.map((s) => (
            <Repository key={`${s.owner}/${s.repo}`} step={s} />
          ))}
          <Section eyebrow="Retention">
            <Prose>
              TAG keeps cached artifact files for 90 days by default and reports for good; set
              ARTIFACT_RETENTION_DAYS to change the window.
            </Prose>
          </Section>
        </>
      )}
    </Loaded>
  );
}

const LABEL: Record<RepositoryStep["kind"], string> = {
  reporting: "reporting",
  "needs-change": "needs a CI change",
  unsupported: "unsupported",
  "no-tests": "no tests",
};

function Repository({ step }: { step: RepositoryStep }) {
  const scope = { kind: "repo", owner: step.owner, repo: step.repo } as const;
  return (
    <Section
      eyebrow={
        <Link ink href={href.scope(scope, { range: RANGE })}>
          {step.owner}/{step.repo} →
        </Link>
      }
      count={LABEL[step.kind]}
    >
      <StepBody step={step} />
    </Section>
  );
}

function StepBody({ step }: { step: RepositoryStep }) {
  switch (step.kind) {
    case "reporting":
      return (
        <span role="status">
          <K tone={step.note === "reporting" ? "good" : "dim"}>
            {step.owner}/{step.repo}: {step.note}
          </K>
        </span>
      );
    case "needs-change":
      return (
        <Stack gap={14}>
          <Prose>Its tests run in CI, but no report reaches TAG. It {scanNote(step.scan)}.</Prose>
          <NeedsChange owner={step.owner} repo={step.repo} />
        </Stack>
      );
    case "unsupported":
      return <Prose>It {scanNote(step.scan)}.</Prose>;
    case "no-tests":
      return <Prose>No tests were found in its workflows or uploads.</Prose>;
  }
}

/** The pull request's state once TAG opened one; until then, the action that proposes it. */
function NeedsChange({ owner, repo }: { owner: string; repo: string }) {
  const proposal = useAtomValue(proposalAtom(`${owner}/${repo}`));
  const pullRequest = AsyncResult.isSuccess(proposal) ? proposal.value.pullRequest : null;
  return pullRequest ? (
    <PullRequestLine pr={pullRequest} />
  ) : (
    <ProposalAction owner={owner} repo={repo} />
  );
}

function FirstReport({ row }: { row: RepoRow }) {
  const runs = useAtomValue(repoRunsAtom(`${row.owner}/${row.repo}`));
  const report = AsyncResult.isSuccess(runs) ? firstReportOf(runs.value) : undefined;
  if (!report) return <K tone="dim">The first report is landing.</K>;
  const scope = { kind: "repo", owner: row.owner, repo: row.repo } as const;
  return (
    <Stack gap={10}>
      <Prose>
        The first report is in: {plural(report.tests, "test")} from {report.tool} in {row.owner}/
        {row.repo}.
      </Prose>
      <Inline gap={18}>
        <Link href={href.scope(scope, { range: RANGE })}>Open {row.repo}</Link>
        <Link href={href.report(report.reportId)}>Open the report</Link>
      </Inline>
    </Stack>
  );
}

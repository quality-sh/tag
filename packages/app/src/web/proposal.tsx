// The CI change on a needs-change repository's page: the "Propose pull request" action, and
// the panel with the description, the diff, and the pull request TAG opens or the reason not.
import { useState } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import {
  Cmd,
  Eyebrow,
  Inline,
  K,
  Link,
  Points,
  Prose,
  Section,
  Space,
  Stack,
  Trace,
} from "@quality-sh/tag-ui";
import type { Proposal, ProposedPullRequest, RepoScan } from "./client.ts";
import { Loaded } from "./common.tsx";
import { scanNote } from "./overview.tsx";
import { openProposalFn, proposalAtom } from "./state.ts";

/** The action and, once asked for, the panel; nothing for a repository that needs no change. */
export function ProposalSection({ scan }: { scan: RepoScan | undefined }) {
  if (scan?.classification !== "needs-change") return null;
  return (
    <Section eyebrow="CI change" count={scanNote(scan)}>
      <ProposalAction owner={scan.owner} repo={scan.repo} />
    </Section>
  );
}

/** The "Propose pull request" button and the panel it opens. */
export function ProposalAction({ owner, repo }: { owner: string; repo: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Cmd small onClick={() => setOpen((o) => !o)}>
        {open ? "Hide the proposal" : "Propose pull request"}
      </Cmd>
      {open && <ProposalPanel owner={owner} repo={repo} />}
    </>
  );
}

function ProposalPanel({ owner, repo }: { owner: string; repo: string }) {
  const result = useAtomValue(proposalAtom(`${owner}/${repo}`));
  return (
    <Space top={18}>
      <Loaded result={result}>{(p) => <ProposalBody p={p} />}</Loaded>
    </Space>
  );
}

function ProposalBody({ p }: { p: Proposal }) {
  const [outcome, openPullRequest] = useAtom(openProposalFn);
  const opening = AsyncResult.isWaiting(outcome);
  const mine =
    AsyncResult.isSuccess(outcome) &&
    outcome.value.owner === p.owner &&
    outcome.value.repo === p.repo
      ? outcome.value
      : undefined;
  const pullRequest = mine?.pullRequest ?? p.pullRequest;
  return (
    <Stack gap={14}>
      <Description text={p.description} />
      {pullRequest ? (
        <PullRequestLine pr={pullRequest} />
      ) : (
        p.files.length > 0 && (
          <Inline>
            <Cmd
              primary
              small
              disabled={opening}
              onClick={() => openPullRequest({ owner: p.owner, repo: p.repo })}
            >
              {opening ? "opening…" : "Open the pull request"}
            </Cmd>
          </Inline>
        )
      )}
      {mine?.outcome === "denied" && (
        <Inline>
          <K tone="bad">{mine.reason}</K>
          <CopyDiff text={p.files.map((f) => f.diff).join("\n")} />
        </Inline>
      )}
      {!opening && AsyncResult.isFailure(outcome) && (
        <K tone="bad">Could not open the pull request. Try again, or copy the diff.</K>
      )}
      {p.files.map((f) => (
        <div key={f.path}>
          <Eyebrow>
            {f.path}
            {f.created ? " (new file)" : ""}
          </Eyebrow>
          <Trace>{f.diff}</Trace>
        </div>
      ))}
    </Stack>
  );
}

export function PullRequestLine({ pr }: { pr: ProposedPullRequest }) {
  return (
    <Inline>
      <Link href={pr.url} external>
        Pull request #{pr.number}
      </Link>
      <K tone={pr.state === "merged" ? "good" : pr.state === "closed" ? "dim" : "ink"}>
        {pr.state}
      </K>
      <K tone="dim">{pr.branch}</K>
    </Inline>
  );
}

/** Paragraphs as prose; runs of "- " lines as points. */
function Description({ text }: { text: string }) {
  return (
    <>
      {text.split("\n\n").map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim() !== "");
        return lines.every((l) => l.startsWith("- ")) ? (
          <Points key={i} items={lines.map((l) => l.slice(2))} />
        ) : (
          <Prose key={i}>{block}</Prose>
        );
      })}
    </>
  );
}

function CopyDiff({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Cmd
      small
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? "copied" : "Copy the diff"}
    </Cmd>
  );
}

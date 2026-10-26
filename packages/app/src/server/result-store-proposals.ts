// Proposal rows: the pull request TAG opened for a repository's CI change, one per repository.
import type { Database } from "bun:sqlite";
import { Option } from "effect";
import type { Interface, ProposalRow } from "./result-store-rows.ts";
import { trySync, type Params } from "./result-store-db.ts";

const COLS = `owner, repo, number, url, state, branch, opened_at AS openedAt`;

export const makeProposals = (db: Database): Pick<Interface, "proposalOf" | "saveProposal"> => {
  const proposalOf = (owner: string, repo: string) =>
    trySync("proposalOf", () =>
      Option.fromNullOr(
        db
          .query<ProposalRow, [string, string]>(
            `SELECT ${COLS} FROM repo_proposal WHERE owner = ? AND repo = ?`,
          )
          .get(owner, repo),
      ),
    );

  const saveProposal = (row: ProposalRow) =>
    trySync("saveProposal", () => {
      db.query<unknown, Params>(
        `INSERT INTO repo_proposal (owner, repo, number, url, state, branch, opened_at)
         VALUES ($owner, $repo, $number, $url, $state, $branch, $openedAt)
         ON CONFLICT(owner, repo) DO UPDATE SET number = excluded.number, url = excluded.url,
           state = excluded.state, branch = excluded.branch, opened_at = excluded.opened_at`,
      ).run({
        $owner: row.owner,
        $repo: row.repo,
        $number: row.number,
        $url: row.url,
        $state: row.state,
        $branch: row.branch,
        $openedAt: row.openedAt,
      });
    });

  return { proposalOf, saveProposal };
};

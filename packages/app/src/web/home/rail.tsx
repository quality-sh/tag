// The rail every page shares: the overview, onboarding, every org and repository, the collections.
import type { ReactNode } from "react";
import { RailGroup, RailItem } from "@quality-sh/tag-ui";
import type { Collection, Range } from "../../grouping.ts";
import type { RepoRow } from "../client.ts";
import { href, scopePath, type Scope } from "../state.ts";

/** Where a page can go: the overview, onboarding, every org and repository, the collections. */
export function Rail({
  scope,
  range,
  collections,
  repos,
  overview,
  onboarding,
  children,
}: {
  scope?: Scope | undefined;
  range: Range;
  collections?: ReadonlyArray<Collection> | undefined;
  repos?: ReadonlyArray<RepoRow> | undefined;
  overview?: boolean;
  onboarding?: boolean;
  /** Extra groups, such as a page's own sections. */
  children?: ReactNode;
}) {
  const orgs = new Map<string, RepoRow[]>();
  for (const r of repos ?? []) orgs.set(r.owner, [...(orgs.get(r.owner) ?? []), r]);
  const is = (s: Scope) => scope !== undefined && scopePath(s) === scopePath(scope);
  return (
    <>
      <RailGroup title="Home">
        <RailItem href={href.overview(range)} on={overview === true}>
          overview
        </RailItem>
        <RailItem href={href.onboarding()} on={onboarding === true}>
          add repositories
        </RailItem>
      </RailGroup>
      {children}
      {[...orgs.entries()].map(([owner, list]) => (
        <RailGroup key={owner} title={owner}>
          <RailItem
            href={href.scope({ kind: "org", owner }, { range })}
            on={is({ kind: "org", owner })}
            count={list.reduce((a, r) => a + r.reports, 0)}
          >
            everything
          </RailItem>
          {list.map((r) => (
            <RailItem
              key={r.repo}
              href={href.scope({ kind: "repo", owner, repo: r.repo }, { range })}
              on={is({ kind: "repo", owner, repo: r.repo })}
              count={r.reports}
            >
              {r.repo}
            </RailItem>
          ))}
        </RailGroup>
      ))}
      <RailGroup title="Collections">
        {(collections ?? []).map((c) => (
          <RailItem
            key={c.id}
            href={href.scope({ kind: "collection", id: c.id }, { range })}
            on={is({ kind: "collection", id: c.id })}
          >
            {c.name}
          </RailItem>
        ))}
        <RailItem href={href.collections()} action>
          + new collection
        </RailItem>
      </RailGroup>
    </>
  );
}

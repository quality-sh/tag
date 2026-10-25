// Refs listing: releases, tags, pull requests and deployments as the grouping refs.
import { Effect, Schema } from "effect";
import type { Ref } from "../grouping.ts";
import type { RepoRef } from "./artifact-source.ts";
import type { Client } from "./github-client.ts";
import { Deployment, PAGE, PullRequest, Release, SHA, Tag } from "./github-schemas.ts";

export const makeRefs = (client: Client) => {
  const { pages, repoPath } = client;
  const listRefs = Effect.fn("GitHubSource.listRefs")(function* (repo: RepoRef) {
    const detail = `${repo.owner}/${repo.repo}`;
    const [releases, tags, pulls, deployments] = yield* Effect.all(
      [
        pages(
          (p) => `${repoPath(repo)}/releases?per_page=${PAGE}&page=${p}`,
          Schema.Array(Release),
          (x) => x,
          200,
          "listRefs",
          `${detail} releases`,
        ),
        pages(
          (p) => `${repoPath(repo)}/tags?per_page=${PAGE}&page=${p}`,
          Schema.Array(Tag),
          (x) => x,
          300,
          "listRefs",
          `${detail} tags`,
        ),
        pages(
          (p) =>
            `${repoPath(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=${PAGE}&page=${p}`,
          Schema.Array(PullRequest),
          (x) => x,
          200,
          "listRefs",
          `${detail} pull requests`,
        ),
        pages(
          (p) => `${repoPath(repo)}/deployments?per_page=${PAGE}&page=${p}`,
          Schema.Array(Deployment),
          (x) => x,
          100,
          "listRefs",
          `${detail} deployments`,
        ),
      ],
      { concurrency: 4 },
    );
    const shaOfTag = new Map(tags.map((t) => [t.name, t.commit.sha]));
    const out: Ref[] = [];
    for (const r of releases) {
      if (r.draft) continue;
      const onBranch = r.target_commitish && !SHA.test(r.target_commitish);
      out.push({
        kind: "release",
        key: r.tag_name,
        ...repo,
        commit:
          shaOfTag.get(r.tag_name) ??
          (r.target_commitish && SHA.test(r.target_commitish) ? r.target_commitish : null),
        branch: onBranch ? r.target_commitish : null,
        timestamp: r.published_at ?? r.created_at,
        title: r.name ?? null,
        url: r.html_url,
        meta: { prerelease: r.prerelease },
      });
    }
    const released = new Set(out.map((r) => r.key));
    for (const t of tags) {
      if (released.has(t.name)) continue;
      // The tags endpoint has no dates; a tag is placed by its commit alone.
      out.push({
        kind: "tag",
        key: t.name,
        ...repo,
        commit: t.commit.sha,
        branch: null,
        timestamp: "",
        title: null,
        url: `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(t.name)}`,
        meta: {},
      });
    }
    for (const p of pulls)
      out.push({
        kind: "pull_request",
        key: `#${p.number}`,
        ...repo,
        commit: p.head.sha,
        branch: p.head.ref,
        timestamp: p.created_at,
        title: p.title,
        url: p.html_url,
        meta: {
          base: p.base.ref,
          ...(p.user ? { author: p.user.login } : {}),
          ...(p.closed_at ? { closedAt: p.closed_at } : {}),
          ...(p.merged_at ? { mergedAt: p.merged_at } : {}),
          ...(p.draft ? { draft: true } : {}),
        },
      });
    // One deployment per environment: the newest.
    const newest = new Map<string, (typeof deployments)[number]>();
    for (const d of deployments) {
      const have = newest.get(d.environment);
      if (!have || have.created_at < d.created_at) newest.set(d.environment, d);
    }
    for (const d of newest.values())
      out.push({
        kind: "deployment",
        key: d.environment,
        ...repo,
        commit: d.sha,
        branch: SHA.test(d.ref) ? null : d.ref,
        timestamp: d.created_at,
        title: null,
        url: null,
        meta: { environment: d.environment, deploymentId: d.id },
      });
    return out;
  });
  return { listRefs };
};

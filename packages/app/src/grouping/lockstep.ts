// Suggestions for an org: release groups of repositories that tag in lockstep, and
// collections worth saving. Pure detection; TAG suggests and the person decides.
import { Schema } from "effect";
import { CollectionInput, type Collection } from "./collections.ts";
import { defaultBranchOf } from "./compute.ts";
import { formatQuery, type Filter } from "./query.ts";
import type { Ref } from "./refs.ts";
import type { ReportLite } from "./report.ts";
import { runsOf } from "./runs.ts";
import { ReleaseGroupInput, SAME_TAG_NAME, type ReleaseGroup } from "./release-groups.ts";

/**
 * "Recent": the last six tags of each repository. Long enough that one coincidence
 * cannot pass for a habit, short enough that a repository that joined or left a lockstep
 * cadence is judged by what it does now rather than what it did a year ago.
 */
export const RECENT_RELEASES = 6;
/**
 * "Most": two thirds of a repository's recent tags must have a same-name partner. A clear
 * majority, which still forgives one solo hotfix tag in every three releases.
 */
export const LOCKSTEP_SHARE = 2 / 3;
/** A single shared tag (two repositories both cutting v1.0.0 at launch) proves nothing. */
export const MIN_SHARED_TAGS = 2;
/** Same-name tags further apart than this are separate releases that happen to share a name. */
export const LOCKSTEP_WINDOW_MS = 86_400_000;

/** Environment names that mean production: prod, production, prod-eu, production_2. */
const PRODUCTION = /(^|[-_./\s])prod(uction)?($|[-_./\s\d])/i;
/** Semantic versions, with or without the leading v: v1.4.0, 2.0.0-rc.1, 1.2.3+build.5. */
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
/** The tag the GitHub source sets on runs a cron schedule started. */
const SCHEDULED_TAG = "event:schedule";

export const SuggestionKind = Schema.Literals([
  "release-group",
  "production",
  "semver",
  "scheduled",
  "failing-default",
]);
export type SuggestionKind = typeof SuggestionKind.Type;

/** What accepting a suggestion saves: a collection's query, or a release group's record. */
export const SuggestionSave = Schema.Union([
  Schema.TaggedStruct("collection", CollectionInput.fields),
  Schema.TaggedStruct("release-group", ReleaseGroupInput.fields),
]);
export type SuggestionSave = typeof SuggestionSave.Type;

export const OrgSuggestion = Schema.Struct({
  /** A hash of the kind and the members, so it changes when the data behind it does. */
  id: Schema.NonEmptyString,
  kind: SuggestionKind,
  sentence: Schema.String,
  save: SuggestionSave,
});
export interface OrgSuggestion extends Schema.Schema.Type<typeof OrgSuggestion> {}

export interface LockstepInput {
  readonly org: string;
  readonly refs: ReadonlyArray<Ref>;
  readonly reports: ReadonlyArray<ReportLite>;
  /** owner/repo → the repository's own default branch, when a scan knew it. */
  readonly defaultBranches?: Readonly<Record<string, string>> | undefined;
  /** What is saved already; a suggestion that would repeat it is left out. */
  readonly collections?: ReadonlyArray<Collection> | undefined;
  readonly releaseGroups?: ReadonlyArray<ReleaseGroup> | undefined;
}

/** cyrb53: a 53-bit string hash, stable across runs and engines, in base 36. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const suggestionId = (kind: SuggestionKind, members: ReadonlyArray<string>) =>
  `${kind}-${hash([kind, ...[...members].sort()].join("\n"))}`;

interface Tag {
  readonly name: string;
  readonly at: number;
}

/** Each repository's tags, oldest first; a release and its tag count once, at the earlier time. */
function tagsByRepo(org: string, refs: ReadonlyArray<Ref>): Map<string, Tag[]> {
  const byRepo = new Map<string, Map<string, number>>();
  for (const r of refs) {
    if (r.owner !== org || (r.kind !== "release" && r.kind !== "tag")) continue;
    const at = Date.parse(r.timestamp);
    if (Number.isNaN(at)) continue;
    const names = byRepo.get(r.repo) ?? new Map<string, number>();
    names.set(r.key, Math.min(names.get(r.key) ?? at, at));
    byRepo.set(r.repo, names);
  }
  const out = new Map<string, Tag[]>();
  for (const [repo, names] of byRepo)
    out.set(
      repo,
      [...names.entries()].map(([name, at]) => ({ name, at })).sort((a, b) => a.at - b.at),
    );
  return out;
}

/** How many of `mine` have a same-name tag in `theirs` within the window. */
const partnered = (mine: ReadonlyArray<Tag>, theirs: ReadonlyArray<Tag>) =>
  mine.filter((t) =>
    theirs.some((u) => u.name === t.name && Math.abs(u.at - t.at) <= LOCKSTEP_WINDOW_MS),
  ).length;

/**
 * Two repositories are in lockstep when most of each one's recent tags have a same-name
 * partner in the other within a day. Both sides must pass, so a repository that tags often
 * on its own is not pulled in by a partner that rarely tags.
 */
export function inLockstep(a: ReadonlyArray<Tag>, b: ReadonlyArray<Tag>): boolean {
  const recentA = a.slice(-RECENT_RELEASES);
  const recentB = b.slice(-RECENT_RELEASES);
  const sharedA = partnered(recentA, b);
  const sharedB = partnered(recentB, a);
  return (
    Math.min(sharedA, sharedB) >= MIN_SHARED_TAGS &&
    sharedA / recentA.length >= LOCKSTEP_SHARE &&
    sharedB / recentB.length >= LOCKSTEP_SHARE
  );
}

/** Repositories joined when they are in lockstep with every other member, largest first. */
function lockstepGroups(tags: ReadonlyMap<string, ReadonlyArray<Tag>>): string[][] {
  const repos = [...tags.keys()].sort();
  const pairs = new Set<string>();
  for (const [i, a] of repos.entries())
    for (const b of repos.slice(i + 1))
      if (inLockstep(tags.get(a) ?? [], tags.get(b) ?? [])) pairs.add(`${a}\n${b}`);
  const linked = (a: string, b: string) => pairs.has(a < b ? `${a}\n${b}` : `${b}\n${a}`);
  const groups: string[][] = [];
  const placed = new Set<string>();
  for (const seed of repos) {
    if (placed.has(seed)) continue;
    const group = [seed];
    for (const other of repos)
      if (!placed.has(other) && other !== seed && group.every((m) => linked(m, other)))
        group.push(other);
    if (group.length < 2) continue;
    for (const m of group) placed.add(m);
    groups.push(group);
  }
  return groups;
}

const collection = (
  org: string,
  kind: SuggestionKind,
  members: ReadonlyArray<string>,
  sentence: string,
  name: string,
  filters: ReadonlyArray<Filter>,
): OrgSuggestion => ({
  id: suggestionId(kind, [org, ...members]),
  kind,
  sentence,
  save: {
    _tag: "collection",
    name,
    description: sentence,
    query: formatQuery([{ field: "org", op: "is", value: org }, ...filters]),
  },
});

/** `field:a,b` for several values, `field:a` for one. */
const oneOf = (field: Filter["field"], values: ReadonlyArray<string>): Filter =>
  values.length === 1
    ? { field, op: "is", value: values[0] ?? "" }
    : { field, op: "in", value: values.join(","), values };

const list = (xs: ReadonlyArray<string>) =>
  xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1) ?? ""}`;

function releaseGroupSuggestions(input: LockstepInput): OrgSuggestion[] {
  const saved = new Set(
    (input.releaseGroups ?? [])
      .filter((g) => g.org === input.org)
      .map((g) => [...g.repositories].sort().join("\n")),
  );
  return lockstepGroups(tagsByRepo(input.org, input.refs))
    .filter((repos) => !saved.has(repos.join("\n")))
    .map((repos) => ({
      id: suggestionId(
        "release-group",
        repos.map((r) => `${input.org}/${r}`),
      ),
      kind: "release-group",
      sentence: `${list(repos)} tag the same versions within a day of each other. Show their releases as one row per version?`,
      save: { _tag: "release-group", org: input.org, repositories: repos, rule: SAME_TAG_NAME },
    }));
}

function collectionSuggestions(input: LockstepInput): OrgSuggestion[] {
  const { org } = input;
  const reports = input.reports.filter((r) => r.owner === org);
  const distinct = (xs: ReadonlyArray<string | null>) =>
    [...new Set(xs.filter((x): x is string => x !== null))].sort();
  const out: OrgSuggestion[] = [];

  const production = distinct(reports.map((r) => r.environment)).filter((e) => PRODUCTION.test(e));
  if (production.length)
    out.push(
      collection(
        org,
        "production",
        production,
        `Runs against ${list(production)} across ${org}. Save them as a collection?`,
        `${org} production`,
        [oneOf("environment", production)],
      ),
    );

  const semver = distinct(
    input.refs
      .filter((r) => r.owner === org && (r.kind === "release" || r.kind === "tag"))
      .map((r) => r.key),
  ).filter((k) => SEMVER.test(k));
  if (semver.length >= MIN_SHARED_TAGS)
    out.push(
      collection(
        org,
        "semver",
        semver,
        `${semver.length} tags in ${org} are semantic versions. Save the runs of those releases as a collection?`,
        `${org} versioned releases`,
        [oneOf("release", semver)],
      ),
    );

  const scheduled = reports.filter((r) => r.tags.includes(SCHEDULED_TAG));
  if (scheduled.length) {
    const workflows = distinct(scheduled.map((r) => r.workflow));
    out.push(
      collection(
        org,
        "scheduled",
        workflows,
        `${org} runs ${workflows.length ? list(workflows) : "workflows"} on a schedule. Save the scheduled runs as a collection?`,
        `${org} scheduled`,
        [{ field: "tag", op: "is", value: SCHEDULED_TAG }],
      ),
    );
  }

  const runs = runsOf(reports);
  const repos = distinct(runs.map((r) => r.repo));
  const defaults = distinct(
    repos.map(
      (repo) =>
        input.defaultBranches?.[`${org}/${repo}`] ??
        defaultBranchOf(
          runs.filter((r) => r.repo === repo),
          input.refs,
          { owner: org, repo },
        ),
    ),
  );
  // Across the org only means something with two repositories or more.
  if (repos.length >= 2 && defaults.length)
    out.push(
      collection(
        org,
        "failing-default",
        defaults,
        `Failing runs on ${list(defaults)} across the ${repos.length} repositories of ${org}. Save them as a collection?`,
        `${org} failing on ${defaults.join(", ")}`,
        [oneOf("branch", defaults), { field: "failed", op: "gt", value: "0" }],
      ),
    );

  const savedQueries = new Set((input.collections ?? []).map((c) => c.query.trim()));
  return out.filter((s) => s.save._tag !== "collection" || !savedQueries.has(s.save.query));
}

/** Every suggestion for an org, release groups first; saved ones are left out. */
export const suggestFor = (input: LockstepInput): OrgSuggestion[] => [
  ...releaseGroupSuggestions(input),
  ...collectionSuggestions(input),
];

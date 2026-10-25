// What GitHub sends back: the response schemas for the fields TAG reads, and the listing caps.
import { Schema } from "effect";

const Nullable = <S extends Schema.Top>(s: S) => Schema.optionalKey(Schema.NullOr(s));

const Repository = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});
export const InstallationRepos = Schema.Struct({ repositories: Schema.Array(Repository) });

export const WorkflowRun = Schema.Struct({
  id: Schema.Number,
  run_number: Schema.Number,
  name: Nullable(Schema.String),
  head_branch: Nullable(Schema.String),
  head_sha: Schema.String,
  html_url: Schema.String,
  status: Nullable(Schema.String),
  conclusion: Nullable(Schema.String),
  run_started_at: Nullable(Schema.String),
  created_at: Schema.String,
  event: Nullable(Schema.String),
});
export const WorkflowRuns = Schema.Struct({ workflow_runs: Schema.Array(WorkflowRun) });

const Artifact = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  size_in_bytes: Schema.Number,
  expired: Schema.Boolean,
  expires_at: Nullable(Schema.String),
});
export const Artifacts = Schema.Struct({ artifacts: Schema.Array(Artifact) });
export const RepoArtifacts = Schema.Struct({
  artifacts: Schema.Array(
    Schema.Struct({
      ...Artifact.fields,
      workflow_run: Schema.Struct({
        id: Schema.Number,
        head_branch: Nullable(Schema.String),
        head_sha: Schema.String,
      }),
    }),
  ),
});

export const Release = Schema.Struct({
  tag_name: Schema.String,
  name: Nullable(Schema.String),
  html_url: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  target_commitish: Nullable(Schema.String),
  published_at: Nullable(Schema.String),
  created_at: Schema.String,
});
export const Tag = Schema.Struct({
  name: Schema.String,
  commit: Schema.Struct({ sha: Schema.String }),
});
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  draft: Nullable(Schema.Boolean),
  created_at: Schema.String,
  closed_at: Nullable(Schema.String),
  merged_at: Nullable(Schema.String),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  user: Nullable(Schema.Struct({ login: Schema.String })),
});
export const Deployment = Schema.Struct({
  id: Schema.Number,
  sha: Schema.String,
  ref: Schema.String,
  environment: Schema.String,
  created_at: Schema.String,
});
export const InstallationToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

export const RepoDetail = Schema.Struct({ default_branch: Nullable(Schema.String) });
export const Environments = Schema.Struct({
  environments: Schema.Array(Schema.Struct({ name: Schema.String })),
});
export const GitTree = Schema.Struct({
  tree: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String })),
  truncated: Schema.optionalKey(Schema.Boolean),
});
export const ContentFile = Schema.Struct({
  content: Nullable(Schema.String),
  encoding: Nullable(Schema.String),
});

export const PAGE = 100;
/** GitHub stops paging a run listing here; a longer walk narrows its date window. */
export const RUN_CAP = 1000;
export const SHA = /^[0-9a-f]{40}$/;

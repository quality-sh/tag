# TAG: instructions for agents

TAG (test aggregator GUI) aggregates the test reports CI already produces (Playwright, DeepEval,
JUnit, anything CTRF) into one dashboard with history. TypeScript on Bun, Effect v4
end to end, React with Effect atoms in the browser. `docs/proposal.md` holds the
design and the plan.

## Pace

Assume work completes at 100x the rate of the average software engineer. We get
things done exceptionally and fast.

## Commands

```sh
bun install
bun test                 # unit and pipeline tests on the fixtures; the S3 test needs RustFS (bun run s3)
bun run typecheck
bun run check            # typecheck, effect diagnostics, lint, format, knip, tests: what CI runs
bun run build:web        # the dashboard bundle, packages/app/dist
bun run start            # build the web, then serve on PORT (dashboard) and ARTIFACT_PORT (artifacts)
```

Do not commit or push unless the person asks. Report changed files and what was
verified instead.

## Layout

```
packages/schema     CTRF 0.2.0 in Effect Schema, the TAG extra conventions, deterministic ids
packages/adapters   report files -> CTRF: ctrf, playwright, deepeval, junit
packages/app        server (Effect http): config, stores, sources (fixtures, GitHub), ingest,
                    retention, auth, two origins; web: atoms, the overview, scope pages (org,
                    repository, collection) with lazily loaded view sections, the full-table
                    views, group and report pages, the JSON Render spec renderer
                    src/grouping.ts is the pure grouping model (filters, group-bys, refs, collections)
                    shared by the server routes and the web app; keep it free of I/O
packages/ui         the design language as StyleX components and tokens (quality-sh look)
fixtures/           recorded run artifacts the tests and the fixtures source read
docs/               the proposal and decisions
eslint-rules/       the effect and architecture lint rules, shared with hyperstition
scripts/            CI helpers: effect diagnostics, changed-line coverage
```

## Effect

- Compose with `Effect.gen`. Services are `Context.Service` classes with a same-name
  `Interface`, built with `Layer.effect` and `Service.of`.
- Typed failures are `Schema.TaggedError`. Never `throw` inside `Effect.gen`
  (`effect/no-direct-throw-in-gen`); fail with a typed error.
- No `unknown` in an Effect's error or requirement channel
  (`architecture/no-unknown-effect-channels`). Map every caught error to a typed one at
  the boundary where it happens.
- `Effect.sync` holds only code that cannot throw (`effect/no-throwing-operation-in-sync`);
  anything that can throw goes in `Effect.try` with a typed `catch`.
- Decode untrusted input with `Schema.decodeUnknownEffect` or `decodeUnknownResult`, not the
  throwing decoders, inside `Effect.gen` (`effect/no-sync-schema-decode-in-gen`).
- `Effect.promise` is for promises whose rejection is a defect. A rejection that
  callers should handle goes through `Effect.tryPromise` with a typed `catch`
  (`effect/require-promise-rejection-handler`).
- Read config through `Config`, never `process.env` in application code.
- Never `x as unknown as Y` (`architecture/no-double-assertion-through-unknown`). Narrow
  with a Schema or a type guard.
- The Effect language service runs as a tsc plugin and in CI (`bun run effect:check`):
  an Effect in a void success, an Effect in a failure channel, a lazy promise in
  `Effect.sync`, `Layer.mergeAll` with dependencies, a scope in `Layer.effect`, an unsafe
  Effect type assertion, `unknown` in a catch, a returned Effect inside `gen`, and a catch
  on an unfailable Effect are all errors.

## Tests

- `bun test`, Bun's runner, under `packages/*/test`. Tests run against the fixtures and
  local fakes; nothing needs the network. The S3 contract test skips when RustFS is not
  reachable on :9000.
- A test exercises the production contract. It never defines its own `FooPort` or
  `FooDependencies` replacement for a production interface
  (`architecture/no-test-contract-replacements`); it builds the real layer with a fake
  underneath.
- Prefer deterministic synchronization (`Deferred`, `Latch`, `TestClock`) to sleeps.
- A pull request needs 80% coverage of its changed executable lines
  (`bun run coverage:changed <base> <head>`, from `bun run test:coverage`'s lcov).
- Fixtures are real artifacts: the Playwright reports under `fixtures/` were produced by
  Playwright, not written by hand. Regenerate them, do not edit them.

## Formatting and lint

- Prettier with `printWidth: 100`; `bun run format` before you finish, `format:check` in CI.
- ESLint: `@eslint/js` recommended, `typescript-eslint` recommended type-checked, plus
  the local `effect` and `architecture` plugins. `--max-warnings=0`.
- Knip keeps exports, files and dependencies used; a config hint is an error.
- `bun audit --audit-level=high` must pass.

## Writing

Follow Orwell's six rules. Short words, active voice, cut what can be cut. Comments say
why, not what. Names are nouns for things and verbs for actions, spelled out.

## Design language

The web UI uses `packages/ui`: the quality-sh look shared with hyp.dev and provenance.sh.
Black canvas, Cormorant Garamond light serif for display and prose, Fragment Mono for
tracked labels, ids and numbers, hairlines rather than filled cards. Hue means one thing:
ink is content, mauve is metadata, gold is a link, rosegold is interaction, rose is
failure, sage is pass, amber is flaky, iris is the metric colour. New UI composes the
components in `packages/ui`; it does not add one-off styles in pages.

Styles are StyleX, as in provenance-web. Tokens live in `packages/ui/src/theme.stylex.ts`
(`defineVars` for colours, fonts and the type scale; `defineConsts` for layout constants).
Each component holds its own `stylex.create` and applies it with `stylex.props`. Only
`global.css` is plain CSS: the font imports, the reset, body, selection and focus. StyleX
has no child selectors and no globals, so a style that needs one becomes a component prop.
Numerals are lining and tabular (`fontVariantNumeric`) wherever a figure is shown.

The home page is one grouped table: a rail of group-bys, collections and repositories at
the left; a search bar whose words become filter chips (typed text at the left, chips at
the right, a flat menu of suggestions under it); four figures with mini bars; then the
table, sectioned by repository. A group page keeps the same figures and adds failing
tests, common errors, runs and flaky tests. New views should reuse `SearchBar`, `Shell`,
`RailGroup`, `Strip`, `Spark`, `Delta` and `Table` with `sections` from `packages/ui`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->

## Tickets

Work is tracked in Beads (`bd`). The tickets are committed in `.beads/issues.jsonl`, so a
fresh clone has them after `bd init --prefix tag && bd import`, run once. Every write
re-exports that file and stages it, so commit it with the work it describes.

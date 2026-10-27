// The pure grouping model behind the home page: a query string of filters, a field to
// group runs by, and the rows that come out. Shared by the server (which runs it over
// the index) and the web app (which parses and formats the query for the search bar).
// No I/O here; each concern lives in the module in grouping/ beside this entry.
export { chipOf, formatQuery, parseQuery } from "./grouping/query.ts";
export { GroupBy, GROUP_BY_INFO, isGroupBy, isRange, Range, RANGES, sinceOf } from "./grouping/groupby.ts";
export { Collection, CollectionInput } from "./grouping/collections.ts";
export { ReportLite } from "./grouping/report.ts";
export { assign, Ref } from "./grouping/refs.ts";
export { RunSummary, runsOf, TrendPoint } from "./grouping/runs.ts";
export { computeGroups, defaultBranchOf, GroupRow, matching } from "./grouping/compute.ts";
export { indexValues, suggest, Suggestion } from "./grouping/suggest.ts";
export { computeOverview, RecentRun, RepoOverview } from "./grouping/overview.ts";
export { ReleaseGroup } from "./grouping/release-groups.ts";
export { OrgSuggestion, suggestFor } from "./grouping/lockstep.ts";
export type { LockstepInput } from "./grouping/lockstep.ts";

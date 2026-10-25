// The pure grouping model behind the home page: a query string of filters, a field to
// group runs by, and the rows that come out. Shared by the server (which runs it over
// the index) and the web app (which parses and formats the query for the search bar).
// No I/O here; each concern lives in the module in grouping/ beside this entry.
export { chipOf, formatQuery, parseQuery } from "./grouping/query.ts";
export { GROUP_BY_INFO, isGroupBy, isRange, RANGES, sinceOf } from "./grouping/groupby.ts";
export type { GroupBy, Range } from "./grouping/groupby.ts";
export { Collection, CollectionInput } from "./grouping/collections.ts";
export type { ReportLite } from "./grouping/report.ts";
export { assign, Ref } from "./grouping/refs.ts";
export { runsOf } from "./grouping/runs.ts";
export type { RunSummary } from "./grouping/runs.ts";
export { computeGroups, defaultBranchOf, matching } from "./grouping/compute.ts";
export type { GroupRow } from "./grouping/compute.ts";
export { indexValues, suggest } from "./grouping/suggest.ts";
export type { Suggestion } from "./grouping/suggest.ts";
export { computeOverview } from "./grouping/overview.ts";
export type { RecentRun, RepoOverview } from "./grouping/overview.ts";

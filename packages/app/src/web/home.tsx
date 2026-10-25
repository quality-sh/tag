// The views: the rail every page shares, the full table of one view, one group's page,
// and the collections page where a query gets a name. Each concern lives in the module
// in home/ beside this entry.
export { Rail } from "./home/rail.tsx";
export { Search } from "./home/search.tsx";
export { ViewPage, scopeCrumbs } from "./home/view.tsx";
export { GroupsTable } from "./home/groups-table.tsx";
export { GroupPage } from "./home/group.tsx";
export { CollectionsPage, CollectionsTable } from "./home/collections.tsx";

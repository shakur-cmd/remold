// The workspace's time zone for the days shown in the app (Calendar, record pages, Today). Set once by
// OrgLayout. Unset, as in a bare component test, the browser's zone is used.
let current: string | undefined;
export const setWorkspaceZone = (zone: string | undefined) => { current = zone; };
export const workspaceZone = () => current;

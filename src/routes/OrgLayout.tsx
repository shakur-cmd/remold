import { Navigate, Outlet, useParams } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { AppShell } from "@/components/AppShell";
import { Loading } from "@/components/Loading";

export type OrgContext = { org: Doc<"orgs">; role: string; objects: Doc<"objects">[] };

export function OrgLayout() {
  const orgId = useParams().orgId as Id<"orgs">;
  const orgs = useQuery(api.orgs.mine);
  const objects = useQuery(api.objects.list, { orgId });
  if (orgs === undefined || objects === undefined) return <Loading />;
  const mine = orgs.find(({ org }) => org._id === orgId);
  if (!mine) return <Navigate to="/" replace />;
  const context: OrgContext = { org: mine.org, role: mine.role, objects };
  return (
    <AppShell org={mine.org} orgs={orgs} objects={objects}>
      <Outlet context={context} />
    </AppShell>
  );
}

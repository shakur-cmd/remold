import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useOutletContext } from "react-router";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Toaster } from "@/components/ui/sonner";
import { Loading } from "@/components/Loading";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SignInPage } from "@/routes/SignInPage";
import { Home } from "@/routes/Home";
import { OrgLayout, type OrgContext } from "@/routes/OrgLayout";
import { ObjectList } from "@/routes/ObjectList";
import { RecordPage } from "@/routes/RecordPage";
import { Settings } from "@/routes/Settings";
import { InvitePage } from "@/routes/InvitePage";

export default function App() {
  return (
    <>
      <Toaster position="top-center" />
      <AuthLoading>
        <Loading />
      </AuthLoading>
      <Unauthenticated>
        <SignInPage />
      </Unauthenticated>
      <Authenticated>
        <Stored>
          <Guarded>
          <Routes>
            <Route index element={<Home />} />
            <Route path="invite/:token" element={<InvitePage />} />
            <Route path="o/:orgId" element={<OrgLayout />}>
              <Route index element={<FirstObject />} />
              <Route path="settings" element={<Settings />} />
              <Route path=":objectKey" element={<ObjectList />} />
              <Route path=":objectKey/:recordId" element={<RecordPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Guarded>
        </Stored>
      </Authenticated>
    </>
  );
}

// Convex only knows a signed-in person after users.store has run once.
function Stored({ children }: { children: ReactNode }) {
  const store = useMutation(api.users.store);
  const me = useQuery(api.users.me);
  useEffect(() => {
    store().catch(console.error);
  }, [store]);
  if (!me) return <Loading />;
  return children;
}

function Guarded({ children }: { children: ReactNode }) {
  return <ErrorBoundary resetKey={useLocation().pathname}>{children}</ErrorBoundary>;
}

function FirstObject() {
  const { org, objects } = useOutletContext<OrgContext>();
  const first = objects[0];
  return first ? <Navigate to={`/o/${org._id}/${first.key}`} replace /> : <Navigate to={`/o/${org._id}/settings`} replace />;
}

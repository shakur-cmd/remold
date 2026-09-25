import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { useIdentity } from "@/lib/identity";
import { api } from "../convex/_generated/api";
import { Toaster } from "@/components/ui/sonner";
import { Loading } from "@/components/Loading";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { SignInPage } from "@/routes/SignInPage";
import { Home } from "@/routes/Home";
import { OrgLayout } from "@/routes/OrgLayout";
import { ObjectList } from "@/routes/ObjectList";
import { RecordPage } from "@/routes/RecordPage";
import { Settings } from "@/routes/Settings";
import { Today } from "@/routes/Today";
import { InvitePage } from "@/routes/InvitePage";
import { CapturePage } from "@/routes/CapturePage";
import { Suggestions } from "@/routes/Suggestions";

export default function App() {
  return (
    <>
      <Toaster position="top-center" />
      <AuthLoading>
        <Loading page />
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
            <Route path="capture" element={<CapturePage />} />
            <Route path="o/:orgId" element={<OrgLayout />}>
              <Route index element={<Navigate to="today" replace />} />
              <Route path="today" element={<Today />} />
              <Route path="settings" element={<Settings />} />
              <Route path="suggestions" element={<Suggestions />} />
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

// Convex only knows a signed-in person after users.store has run once. The
// provider profile supplies display information; membership stays in Convex.
function Stored({ children }: { children: ReactNode }) {
  const store = useMutation(api.users.store);
  const me = useQuery(api.users.me);
  const { user } = useIdentity();
  const name = user?.name, email = user?.email, imageUrl = user?.imageUrl;
  useEffect(() => {
    store({ profile: { name, email, imageUrl } }).catch(console.error);
  }, [store, name, email, imageUrl]);
  if (!me) return <Loading page />;
  return children;
}

function Guarded({ children }: { children: ReactNode }) {
  return <ErrorBoundary resetKey={useLocation().pathname}>{children}</ErrorBoundary>;
}

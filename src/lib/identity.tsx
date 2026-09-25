import type { ReactNode } from "react";
import { AuthKitProvider, useAuth } from "@workos-inc/authkit-react";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import type { ConvexReactClient } from "convex/react";
import { useLocation, useNavigate } from "react-router";
import { authReturnTarget } from "./identity-route";
import { authSessionOptions } from "./identity-session";

export function IdentityProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) {
  const navigate = useNavigate();
  const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string | undefined;
  if (!clientId) return <p className="p-6">Sign-in is not configured for this site.</p>;
  return (
    <AuthKitProvider
      clientId={clientId}
      {...authSessionOptions({ hostname: window.location.hostname, clientId, mode: import.meta.env.VITE_AUTH_SESSION_MODE, apiHostname: import.meta.env.VITE_WORKOS_API_HOSTNAME })}
      redirectUri={import.meta.env.VITE_WORKOS_REDIRECT_URI as string}
      onRedirectCallback={({ state }) => navigate(authReturnTarget(state?.returnTo, window.location.origin), { replace: true })}
    >
      <ConvexProviderWithAuthKit client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuthKit>
    </AuthKitProvider>
  );
}

export function useIdentity() {
  const auth = useAuth();
  const location = useLocation();
  const returnTo = authReturnTarget(location.pathname + location.search + location.hash, window.location.origin);
  return {
    isLoading: auth.isLoading,
    user: auth.user ? {
      name: [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ") || auth.user.email,
      email: auth.user.email,
      imageUrl: auth.user.profilePictureUrl ?? undefined,
    } : null,
    signIn: () => auth.signIn({ state: { returnTo } }),
    signUp: () => auth.signUp({ state: { returnTo } }),
    signOut: () => auth.signOut({ returnTo: window.location.origin }),
  };
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useIdentity } from "@/lib/identity";

export function SignInPage() {
  const identity = useIdentity();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const start = async (signUp: boolean) => {
    setPending(true);
    setError(false);
    try {
      await (signUp ? identity.signUp() : identity.signIn());
    } catch {
      setError(true);
      setPending(false);
    }
  };
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Remold</h1>
        <p className="text-sm text-muted-foreground">A CRM you reshape as you go.</p>
      </div>
      <Button disabled={pending || identity.isLoading} onClick={() => void start(false)}>{pending ? "Opening sign-in…" : "Sign in"}</Button>
      <p className="text-sm text-muted-foreground">New here?{" "}
        <Button variant="link" className="h-auto p-0" disabled={pending || identity.isLoading} onClick={() => void start(true)}>Create an account</Button>
      </p>
      {error && <p role="alert" className="text-sm text-destructive">Sign-in could not start. Try again.</p>}
    </div>
  );
}

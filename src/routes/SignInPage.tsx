import { SignIn } from "@clerk/clerk-react";

export function SignInPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Remold</h1>
        <p className="text-sm text-muted-foreground">A CRM you reshape as you go.</p>
      </div>
      <SignIn routing="virtual" />
    </div>
  );
}

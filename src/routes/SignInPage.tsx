import { useState } from "react";
import { SignIn, SignUp } from "@clerk/clerk-react";
import { Button } from "@/components/ui/button";

// Both forms render in place; Clerk's own footer links would bounce to its hosted portal.
const appearance = { elements: { footerAction: { display: "none" } } };

export function SignInPage() {
  const [mode, setMode] = useState<"in" | "up">("in");
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Remold</h1>
        <p className="text-sm text-muted-foreground">A CRM you reshape as you go.</p>
      </div>
      {mode === "in" ? <SignIn routing="virtual" appearance={appearance} /> : <SignUp routing="virtual" appearance={appearance} />}
      <p className="text-sm text-muted-foreground">
        {mode === "in" ? "New here?" : "Already have an account?"}{" "}
        <Button variant="link" className="h-auto p-0" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "Create an account" : "Sign in"}
        </Button>
      </p>
    </div>
  );
}

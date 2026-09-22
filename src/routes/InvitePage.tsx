import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/Loading";
import { errorMessage } from "@/lib/errors";

export function InvitePage() {
  const token = useParams().token!;
  const invite = useQuery(api.invites.get, { token });
  const accept = useMutation(api.invites.accept);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  if (invite === undefined) return <Loading />;
  const message = invite === null ? "This invite link is not valid." : invite.expired ? "This invite has expired. Ask for a new link." : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 text-center">
      {message ? (
        <p className="text-muted-foreground">{message}</p>
      ) : (
        <>
          <h1 className="text-xl font-semibold">Join {invite!.orgName}</h1>
          <p className="text-sm text-muted-foreground">You will join as {invite!.role}.</p>
          <Button
            className="justify-self-center"
            onClick={async () => {
              try {
                const orgId = await accept({ token });
                navigate(`/o/${orgId}`);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Accept
          </Button>
        </>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button variant="link" onClick={() => navigate("/")}>
        Go to my organisations
      </Button>
    </div>
  );
}

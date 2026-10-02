import type { ReactNode } from "react";
import { Link } from "react-router";

// Plain and short on purpose. Both stay marked as drafts until Shakur approves the wording.
function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto grid max-w-2xl gap-4 px-5 py-10 text-sm leading-6">
      <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 font-medium text-amber-900">Draft, not yet reviewed. This text may change before Remold takes paying customers.</p>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
      <p className="text-muted-foreground">Questions: <a className="underline" href="mailto:shakur@codemyvibe.com">shakur@codemyvibe.com</a>. <Link className="underline" to="/">Back to Remold</Link></p>
    </main>
  );
}

export function Terms() {
  return (
    <Page title="Terms of use">
      <p>Remold is a small CRM made and run by CodeMyVibe. By using it you agree to these terms.</p>
      <p><strong>Your data is yours.</strong> An owner can export the whole workspace as one file at any time, up to 64 MB per file; larger workspaces are exported by request. An owner can delete the workspace at any time, with or without an export. We do not sell your data or use it for anything except running Remold for you.</p>
      <p><strong>Use it fairly.</strong> Do not use Remold to break the law, send spam, or get into other people's workspaces. We may suspend a workspace that does, and we will tell you why.</p>
      <p><strong>Paying.</strong> If you subscribe, the price is shown before you pay and billing runs through Stripe. You can cancel any time by emailing us.</p>
      <p><strong>No promises beyond care.</strong> We work to keep Remold running and your data safe, but it is provided as is. Keep your own export if the data matters to you. Our liability is limited to what you paid us in the last twelve months.</p>
      <p><strong>Changes.</strong> If these terms change in a way that matters, we will tell workspace owners by email first.</p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <p>This page says what Remold keeps, where it lives, and who helps us run it.</p>
      <p><strong>What we keep.</strong> Your name and email from sign-in, and whatever you and your team put into your workspace: records, fields, notes and their change history.</p>
      <p><strong>Where it lives.</strong> Workspace data is stored with Convex in the United States. Sign-in is handled by WorkOS. Emails Remold sends, such as reminders, go through Resend. If you subscribe, payments are handled by Stripe; we never see your card number. The app itself is served by Cloudflare.</p>
      <p><strong>Who sees it.</strong> Only the people and agents your workspace lets in. We look at workspace data only to fix a problem you report or when the law requires it.</p>
      <p><strong>Your choices.</strong> An owner can export the whole workspace from Settings at any time, up to 64 MB per file; larger workspaces are exported by request. An export file can be imported into a new workspace, up to 32 MB and 25,000 records, history entries and links; larger imports by request. An owner can delete the workspace at any time, with or without an export. Deletion removes the workspace's data from Remold; any backup copies are removed as they expire. Your sign-in identity (name and email) is kept, because it may belong to other workspaces; ask us and we will remove it.</p>
      <p><strong>Cookies.</strong> Only what sign-in needs. No advertising or tracking cookies.</p>
    </Page>
  );
}

export function LegalLinks() {
  return (
    <footer className="flex gap-4 text-xs text-muted-foreground">
      <Link className="hover:underline" to="/terms">Terms</Link>
      <Link className="hover:underline" to="/privacy">Privacy</Link>
    </footer>
  );
}

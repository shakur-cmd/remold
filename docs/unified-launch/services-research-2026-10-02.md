# Remold production services research (2026-10-02)

Method note: pages were read through a fetch tool that summarizes with a small model, so quoted lines are as returned by that tool, not byte-verified against the raw page. The LinkedIn and Resend create-key pages came back raw/near-raw. Items marked AMBIGUOUS or UNAVAILABLE need a human look before anyone relies on them.

## 1. WorkOS

| Fact | URL | Quoted line |
|---|---|---|
| Production needs a billing method on file | https://workos.com/docs/authkit/environments | "Unlock production by adding billing information in the WorkOS Dashboard." / "Production requires adding billing information in the WorkOS Dashboard." |
| Activation steps (verify in staging, unlock with billing, generate prod API key, new Client ID, https redirect URIs) | https://workos.com/docs/authkit/environments (via search-result summary; the checklist page itself returned nothing) | "Verify your integration works end-to-end in staging." / "Generate your production API key and store it securely. Production API keys can only be viewed once." / "Configure production redirect URIs ... must use https://." |
| No review or approval step found | same | None found. Only billing info is named. Absence is not proof. |
| AuthKit free at small scale | https://workos.com/pricing | "First 1M MAUs" are "Free"; additional "Each additional 1M MAUs" "$2,500/mo" |
| Only production is billed | https://workos.com/pricing | "Only production environments are billed" |
| Custom auth domain is paid | https://workos.com/pricing ; https://workos.com/docs/custom-domains | "Custom domain" "$99/mo" ; "This is a paid service, for which you can find additional details on our pricing page." |
| Custom domains are production-only | https://workos.com/docs/authkit/environments ; custom-domains page | "Custom domains for AuthKit, Admin Portal, and the Authentication API are only available in production environments." / "In the staging environment these will always use a WorkOS domain, however in production you have the option to provide your own custom domain." |
| Without custom domain, WorkOS domain is used | custom-domains page | Implied by the staging line above for staging. For production without the add-on: NOT explicitly stated on any page I could read. AMBIGUOUS. |
| Production cannot use WorkOS default Google credentials | https://workos.com/docs/integrations/google-oauth | "The default credentials are only intended for testing and therefore only available in the Staging environment." / "For your production environment, please follow the steps below to create and specify your own Google Client ID and Client Secret." |
| Google consent screen must be configured; scopes must match | same | "additional scopes that you plan to request must also be configured on your OAuth consent screen in the Google Cloud Platform Console." |
| Verification only for sensitive/restricted scopes | same | "If requesting any of these sensitive or restricted scopes, your application will need to be verified by Google." |

Google Cloud steps for own client (assembled from the above, not a WorkOS-quoted list): create project, configure consent screen/audience, create OAuth client (Web), paste Client ID/Secret into WorkOS prod, add WorkOS's redirect URI to the Google client. The exact redirect URI and click path were not captured; read the Google OAuth page in the WorkOS dashboard at that time.

Internal vs External consent screen:

| Fact | URL | Quoted line |
|---|---|---|
| Internal limits sign-in to the org | https://support.google.com/cloud/answer/15549945 | "Internal users to limit authorization requests to members of the organization" |
| Internal exempt from unverified screen and 100-user cap | https://support.google.com/cloud/answer/13463073 | "Your app will not be subject to the unverified app screen or the 100-user cap if it's designated as internal-only." |
| External + basic name/email/profile only: no verification burden for those scopes | https://support.google.com/cloud/answer/15549945 (search summary) | "if your app requests only name, email address, and user profile ... your users do not need to be in the trusted user list and their authorizations will not expire after 7 days." AMBIGUOUS: the page-level read tied this exception to Testing status. |
| Personal-use apps under 100 users | https://support.google.com/cloud/answer/13463073 | "If the app is for your personal use (fewer than 100 users), you and your limited number of users can continue using the app without going through verification" |

Reading for Remold: Sign-in only needs openid/email/profile (non-sensitive), so no Google verification review is expected either as Internal (Workspace users only) or External. Internal is simplest if every user is on Shakur's Workspace domain. UNCONFIRMED: Google's exact wording for External-in-production with basic scopes.

## 2. Convex

| Fact | URL | Quoted line |
|---|---|---|
| Starter price | https://www.convex.dev/pricing | "Free or $0/month and pay as you go" |
| Professional price | https://www.convex.dev/pricing | "$25 per developer/month" |
| Pro adds daily backups | https://www.convex.dev/pricing | "Daily backups" (Professional); "Fast backup/restore" (Business & Enterprise); "Streaming data exports" (Professional and up) |
| Manual backups on Free/Starter, limited | https://docs.convex.dev/database/backup-restore | "Free/Starter: Limited to two backups per deployment simultaneously"; "Manual backups are retained for 7 days and can be downloaded or deleted via the dashboard." |
| Automatic backups need Pro | same | "Schedule a periodic daily or weekly backup by checking the 'Backup automatically' box." / "Periodic backups require a Convex Pro plan." Daily kept 7 days, weekly 14 days. |
| Pro: many backups, usage-priced | same | "Deployments on Convex Professional plan can have many backups with standard usage based pricing" |
| CLI export exists | https://docs.convex.dev/cli (export section) | "Export data from your deployment to a ZIP file"; `npx convex export --path <filePath>.zip`; `--include-file-storage` option |
| CLI export plan restriction | same, and https://docs.convex.dev/database/import-export/export | NONE STATED. The docs say export "accomplishes the same task" as taking a backup and downloading it. Whether the CLI export is allowed on Starter is NOT confirmed by any page. The pricing page summary said "The Starter plan does not include backup functionality," which is an inference by the fetch tool, not a quoted line. AMBIGUOUS. Test with one `convex export` run on the real deployment before relying on it. |
| What a backup excludes | backup-restore page | Excludes code, configuration, pending scheduled functions, env variables; includes table documents and optional file storage. |
| Starter limits relevant to one user | https://www.convex.dev/pricing | "0.5 GB included ($0.22 per additional GB)" storage; function calls "1M included ($2.20 per additional 1M)" |

## 3. Resend

| Fact | URL | Quoted line |
|---|---|---|
| Free monthly limit | https://resend.com/pricing | "3,000" emails per month |
| Free daily limit | https://resend.com/pricing | "limited to 100 emails per day" |
| Free domains | https://resend.com/pricing | "3 domains" |
| Next paid tier | https://resend.com/pricing | "Pro" at "$20/mo" |
| Key permission types | https://resend.com/docs/api-reference/api-keys/create-api-key | `full_access`: "Can create, delete, get, and update any resource." `sending_access`: "Can only send emails." |
| Domain-scoped keys | same | "Restrict an API key to send emails only from a specific domain. This is only used when the `permission` is set to `sending_access`." |

## 4. Gmail API read-only, one user's own mailbox

| Fact | URL | Quoted line |
|---|---|---|
| gmail.metadata is narrowest; headers not body | https://developers.google.com/workspace/gmail/api/auth/scopes | "View your email message metadata such as labels and headers, but not the email body." |
| Both metadata and readonly are RESTRICTED scopes | same | Both listed as restricted, needing "restricted scope OAuth App Verification." |
| metadata scope cannot use search `q` | https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list | "Parameter cannot be used when accessing the api using the gmail.metadata scope." (design impact: you must list by label/date window and filter yourself) |
| Restricted scope + third-party server => security assessment | https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification | "Every app that requests access to Google users' restricted data and has the ability to access data from or through a third-party server must go through a security assessment from Google-empanelled security assessors." Repeats "at least every 12 months". |
| Internal app exemption, and a caveat | same page | Fetch tool summary: internal apps "exempt from brand verification", but it also returned a line "if your app utilizes restricted or sensitive scopes, app verification is required" for domain-wide installs. AMBIGUOUS: I could not get a clean quote saying an Internal app skips CASA. |
| Internal-only skips unverified screen / 100 cap | https://support.google.com/cloud/answer/13463073 | "Your app will not be subject to the unverified app screen or the 100-user cap if it's designated as internal-only." |
| Personal use under 100 users | same | "you and your limited number of users can continue using the app without going through verification" |
| Cost of CASA | restricted-scope page | "The document does not specify any fees" (page silent). Cost: UNAVAILABLE from primary source. |

Reading: scope = gmail.metadata. Internal app in the same Workspace very likely avoids the verification/assessment path (two pages say internal-only is exempt from unverified screen/cap), but I could not confirm CASA is waived in the exact words. Alternative that avoids the question entirely: a Workspace service account with domain-wide delegation, or the unverified-app path for under 100 personal users; neither was researched here.

## 5. Posting later, to the owner's own account

| Platform | Approval / review needed for own account | URL | Quoted line | API cost |
|---|---|---|---|---|
| TikTok | App approval for `video.publish`; until a compliance audit passes, all posts are private-only | https://developers.tiktok.com/doc/content-posting-api-get-started ; https://developers.tiktok.com/doc/content-sharing-guidelines | "All content posted by unaudited clients will be restricted to private viewing mode." / "Unaudited API Clients can only post contents in `SELF_ONLY` viewership." / "up to 5 users" | No fee mentioned |
| Instagram (Business/Creator) | Professional account only. Standard Access is enough for your own account, no App Review | https://developers.facebook.com/docs/instagram-platform/content-publishing ; https://developers.facebook.com/docs/graph-api/overview/access-levels | "Instagram professional accounts"; perms `instagram_business_content_publish` or `instagram_content_publish`; "Permissions with Standard Access can only be requested from app users who have a role on the requesting app." Search summary: "If your app only serves your Instagram professional account or an account you manage, Standard Access is all your app needs." (secondary summary of a Meta page, not seen verbatim) | No fee mentioned; limit "100 API-published posts limit per 24-hour period" |
| Facebook Pages | `pages_manage_posts` (+ related page perms); if you own/manage the Page, Standard access suffices | https://developers.facebook.com/docs/pages-api/posts | "If your app users own or manage the Page directly, standard access suffices." | No fee mentioned |
| X | No review; sign up in console and buy credits | https://docs.x.com/x-api/getting-started/pricing ; https://docs.x.com/x-api/getting-started/about-x-api | "The X API uses pay-per-usage pricing. No subscriptions—pay only for what you use." Standard post create "$0.015 per request"; "Post: Create (with URL)" "$0.200 per request." The old Free/Basic/Pro tiers are NOT on the current pages; no free tier mentioned. developer.x.com page returned HTTP 402. | Pay per request, credits bought upfront. A link in a post costs 13x a plain post per the page. |
| LinkedIn personal profile | Self-serve: add "Share on LinkedIn" product, get `w_member_social`; no vetting described | https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin | "add the Share on LinkedIn product which will grant you `w_member_social`." Limit "Member 150 Requests" per day. (page dated 2021/2023 metadata, uses older ugcPosts API; Posts API page lists `w_member_social` as post permission) | No fee mentioned |
| LinkedIn company page | `w_organization_social` via Community Management API, a vetted product | https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review | "our Community Management APIs are only available to registered legal organizations for commercial use cases only." Requires verified business email, verified organization/site, Page super-admin verification of the app, Development tier then Standard tier with screencast. | No fee mentioned. Whether Remold/CodeMyVibe qualifies as a "registered legal organization" is Shakur's fact, not mine. |

## What this means for the $50 cap

No invented numbers; only figures quoted above.

- WorkOS production itself: needs a card on file, but AuthKit is free under 1M MAUs, so $0 for a single-user CRM. Hard blocker to confirm in the dashboard: a billing card is required (a gate, not a charge).
- WorkOS custom auth domain (auth.remoldcrm.com): $99/mo on the pricing page. That alone is about double the whole $50 cap. Not affordable. Skip it; the cost is a WorkOS-hosted auth/email domain, which is unconfirmed (no page I could read says what the default production domain looks like). Decision for Shakur: accept it, or leave this out.
- Google sign-in in production: must bring own Google OAuth client. No quoted cost; Google Cloud OAuth client creation has no price on the pages read. Internal consent screen is the simplest if all users are in his Workspace.
- Convex: Starter is $0. Professional is $25 per developer/month, which fits under the cap only if nothing else costs much; it is the only way to get automatic daily backups. Cheaper path: scheduled `npx convex export` run from outside Convex (a cron on his machine), if a test shows export works on Starter (unconfirmed). Manual dashboard backups on Starter are capped at two at a time, 7-day retention.
- Resend: free covers 3,000/month, 100/day, 3 domains; use a domain-scoped `sending_access` key. $0 unless limits are exceeded (next tier $20/mo).
- Gmail metadata sync: no cost found on any page, but CASA cost is UNAVAILABLE from the sources read. Do not plan on the verification route; rely on the internal-app route and verify before building.
- Social posting (later): Meta, TikTok (private-only until audited), and LinkedIn personal show no fees; LinkedIn company page needs vetted API access; X is pay-per-request, so only a small posting volume is safe and a post with a link costs much more than plain text.
- Known fixed costs at present: Convex $0 + Resend $0 + WorkOS $0 = $0 recurring. Adding Convex Pro ($25) leaves the rest of the cap; adding the WorkOS custom domain ($99) breaks it.
- Not covered here: domain registration, Vercel/hosting, and Clerk (not researched; the request did not ask).

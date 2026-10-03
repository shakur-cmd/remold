# Job C: agents can remold the workspace
Branch: `remold/agent-schema`. Job id: C. Base: 371a62c. Read COMMON.md first.

## Why
Remold's whole point: an AI agent can quickly reshape the CRM to fit whoever uses it. Today agents can read the shape (`GET /api/v1/objects`) and change records, but cannot change the shape. Only an admin in the app can add objects (convex/objects.ts create) and fields (convex/fields.ts create/update). Close that gap the Remold way: agents propose shape changes, a person applies them with one tap, and everything is attributed and audited.

## Read first
convex/objects.ts, convex/fields.ts, convex/lib/slots.ts, convex/suggestions.ts, convex/authority/* (reads, pending, inbox), convex/agentApi.ts, convex/http.ts, packages/mcp/src/*, src/routes/Suggestions.tsx, src/components/SuggestionCard.tsx, src/routes/Settings.tsx.

## Build
1. Shape proposals. An agent can propose:
   - a new object (key, label, plural, optional icon) with up to 12 initial fields;
   - a new field on an existing object (key, label, type, options for select, target object for lookup/links, withTime for dates, required);
   - new options added to a select field (never removing or renaming existing options);
   - a label change on an object or field.
   Each proposal carries a reason. Store them in a new table (e.g. `shapeSuggestions`: orgId, agentId, authorityEpoch, kind, payload, reason, status pending/applied/dismissed/failed, resolvedBy, resolvedAt, result ids, error). Validate at proposal time with exactly the rules the human mutations use (valid key, unique key, select needs unique options, only dates keep time, relation needs readable target, slot availability) so a proposal a person cannot apply is refused up front. Refactor objects.create/fields.create/fields.update into shared helpers used by both paths, so the rules live in one place.
   Agents need a role/permission to propose shape changes: allowed for agents whose role is admin; member-role agents get FORBIDDEN. Agents never apply shape changes directly in this job.
2. Applying. Admins (with the same unrestricted-access requirement objects.create has) see shape proposals in the Suggestions page, rendered plainly ("Add field Budget (number) to Opportunity", with the reason and the agent's name), and Apply or Dismiss. Applying re-validates against the current shape (the world may have changed), runs the shared helper, records the result ids, and writes an audit row (authorityAudit or the existing pattern; your call, explain it). A proposal that no longer applies is marked failed with the reason, not half-applied.
3. Agents read results: `GET /api/v1/shape/proposals?status=` lists the agent's own proposals; `POST /api/v1/shape/proposals` creates one. MCP tools `remold_propose_shape` and `remold_shape_proposals`. Update the MCP server instructions: Remold is meant to be reshaped; when the user's work needs a field or object that does not exist, propose it, then use it once applied.
4. Also improve `remold_list_records` in MCP to pass through the multi-field `filters` and `range` that REST already supports (see listQuery in convex/http.ts), so agents can actually segment lists (e.g. people where company=X).
5. Pending counts: `GET /api/v1/me` pendingSuggestions or a sibling count includes shape proposals; the app's suggestion badge (if any) counts them too.

## Done when
Tests prove: member-role agent cannot propose; invalid proposals are refused with the same messages the human path gives (one test per rule: bad key, duplicate key, select without options, withTime on non-date, unreadable target, option removal); applying creates exactly the object/field/options and is attributed; a proposal made stale by a later human change fails cleanly with nothing half-applied; dismiss works; a member-role human cannot apply; restricted-read humans cannot apply object proposals; agents only list their own proposals; MCP filters reach REST as filter[field]=value. Full suites + build pass. Screenshot of a shape proposal on the Suggestions page if you get a local backend.

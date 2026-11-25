# Recipients and Staging Implementation Plan

> **For agentic workers:** Use Superpowers test-driven development and verification before completion. Check off each verified step.

**Goal** — Review personalized invitations and stage the selected tickets once for a later manual send.

**Architecture** — Express renders the recipient and queue views from the current Files import and MySQL invitation metadata. Browser selection stays scoped to the current recipient identities. Server-side staging validates the reviewed snapshot and uses a unique active ticket per draft in MySQL.

**Spec** — [Dinner Dance invitations](../specs/2026-11-25-dinner-dance-invitations-design.md), Split 2.

## Global constraints

- Reuse Files matching, authenticated image access, and operator sign-in. Keep visible navigation, labels, and slate-and-indigo styling from the approved mockups.
- Stage only eligible rows. Preserve the exact rendered message, phone number, and reviewed image version in each staged row.
- Prepare the schema migration without executing database changes. Use synthetic fixtures and in-memory repositories for tests.
- Sending, retry, delivery updates, provider credentials, and webhook registration belong to Split 3.

## Review focus

- An old review page can submit after a template edit, image replacement, or removal. Reject stale requests before staging.
- Double submissions and overlapping selections cannot create two active rows for a ticket. Removing a queued invitation keeps the historical snapshot and permits a new stage.
- An image can be valid while its recipient phone or ticket is invalid. Such rows may be previewed but cannot be staged.
- Header selection should apply to the filtered results. Search and pagination retain individual deselections and the global count.

## Tasks

- [x] Write failing service tests for message validation, idempotent staging, immutable image versions, and removal and restaging. Implement `src/invitations/service.ts`, `src/invitations/mysql-repository.ts`, and `db/migrations/002_invitation_staging.sql`. Run the service tests.
- [x] Write failing route tests for authenticated review, message edits, CSRF protection, selected staging, and removal. Implement the Recipients and Queue routes and templates and make both tabs available from Files. Run the HTTP tests without a live database.
- [x] Test filtered selection, mixed state, and pagination. Implement the inline preview and selection controls in `public/recipients.js` and share the Files navigation and styles. Verify the rendered page in a browser with synthetic recipients.
- [x] Run the full test suite, build, and Compose configuration validation. Record the prepared migration and the remaining live database verification in the README.

Verification used 15 passing tests, a TypeScript build, Compose configuration validation with example settings, and a Chromium run using fictional recipients. Applying the migration and exercising MySQL persistence require a separately approved database target.

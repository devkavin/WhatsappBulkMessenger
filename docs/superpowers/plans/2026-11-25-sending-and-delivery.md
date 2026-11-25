# Sending and Delivery Implementation Plan

**Goal** — Manually start a staged batch, track delivery, and verify the same sender through a separate Test sends page.

**Architecture** — The web app manages batch controls and receipts. A separate worker uses a durable MySQL lease and shared submission schedule. It sends through a local simulator or an explicitly configured Wassenger adapter. Production and simulation records carry their mode. Signed media links expose one image for a limited time.

**Spec** — [Dinner Dance invitations](../specs/2026-11-25-dinner-dance-invitations-design.md), Split 3.

- [x] Test timing, provider outcome handling, receipt matching and signed media. Build the sending policy, adapters and worker in `src/delivery`.
- [x] Prepare the MySQL migration and implement leases, batch snapshots, status transitions and separate test history. Keep sending and migrations out of web startup.
- [x] Implement Queue controls, authenticated Test sends and the secret-protected callback. Exercise the routes and worker with in-memory state and synthetic recipients.
- [x] Add the Coolify worker service and settings, run the suite and build, and document the production verification still needed. Applying the SQL and sending real messages require separate authorization.

Verification used 25 tests with synthetic data, a TypeScript build, and Compose configuration validation. The live account's connector, template, media retrieval, delivery receipts, and hosted MySQL execution remain to be verified after authorization.

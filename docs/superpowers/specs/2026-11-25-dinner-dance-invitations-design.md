# Dinner Dance WhatsApp invitations

An event organizer uploads a guest list and ticket images, reviews the personalized invitations, stages the selected tickets, and starts sending from the Queue tab. Each recipient receives a short invitation with their ticket number and its matching image. The organizer can see whether each invitation is queued, submitted, delivered, or failed.

## Approved screen references

- [Files mockup](C:/Users/kavin/.codex/generated_images/01a20703-9958-7843-a7e8-6056b4736abd/exec-474c1094-253f-4165-a62f-7b3c76a16c94.png)
- [Recipients mockup](C:/Users/kavin/.codex/generated_images/01a20703-9958-7843-a7e8-6056b4736abd/exec-8847eb47-52bb-49e2-b666-1ba8f4c9b42b.png)
- [Queue mockup](C:/Users/kavin/.codex/generated_images/01a20703-9958-7843-a7e8-6056b4736abd/exec-c54decdf-1f31-4f78-8b41-db6939ff16e3.png)

Use the approved slate-and-indigo visual treatment, consistent navigation, labelled status icons, and compact tables. Show a mixed-state header checkbox when some eligible recipients are selected. The sample rows in the mockups illustrate the screens.

## Approaches

- **Selected approach — one app on the existing Coolify host.** Use Node.js, TypeScript, Express, server-rendered pages, the organizer's existing Coolify-hosted MySQL instance, and a sending worker. The application containers use Docker Compose. The always-on host and HTTPS domain let the worker and delivery webhook operate with the organizer's browser closed.
- **Local Docker with an HTTPS tunnel.** This supports the same browser workflow, with the PC and tunnel kept up for both sending and receipt collection. Use it for local integration testing if needed.
- **Wassenger Campaigns.** The built-in interface supports CSV personalization and media. Support for joining a distinct image filename to every ticket row was unverified. The custom app owns that pairing, its validation, and the recipient preview.

## Split 1 — Files and import

Build the shared navigation and protect operator screens with a login. Give the Files page a CSV upload and replacement control plus a multi-file picker and drop area for images. Store uploads in a private persistent volume shared with the worker and scope them to the draft campaign. Preserve display filenames. Validate image content and accept PNG and JPEG initially.

Require `Ticket No`, `Name`, and `Contact`. Accept `Rank` when present and ignore other columns. Parse ticket numbers and phone numbers as text. Normalize phone numbers for sending, using an explicit campaign country setting for local numbers. Show row-level issues for missing or invalid contact values and duplicate ticket numbers. One phone number can legitimately belong to more than one ticket.

Match the filename stem to the ticket number, preserving leading zeros. Flag multiple candidates for one ticket rather than choosing silently. Reflect missing images and conflicts in **Needs attention**, and list extra files in **Unmatched uploads**. Allow a single image to be added directly from its missing row. Replacing the CSV refreshes the draft recipient list and matches it against existing uploads. Replacing a file for a draft creates a new version so queued invitations retain their reviewed image.

**Acceptance.** The Files screen imports the sample CSV and displays 431 rows with blank contact values. Synthetic fixtures with populated contacts exercise valid rows, missing and conflicting attachments, extra files, and leading-zero ticket numbers. Files survive a container restart.

## Split 2 — Recipients and message review

Show ticket number, optional rank, name, contact, and image match. Search by name, phone number, or ticket. Select all eligible recipients on initial review and retain selection across search, filters, and pagination. An upload change rechecks eligibility and preserves deliberate deselections for unchanged tickets.

Keep **Edit message** at the top. The operator edits the shared draft and can insert `{{ticket_number}}`. Use “You’re invited to the Dinner Dance! Ticket {{ticket_number}}.” as the starting text. The message preview pairs the rendered draft with the actual matched ticket image. Flag unresolved placeholders and rows that are ineligible for queueing.

**Add to queue** stages the selected invitations in MySQL with their recipient details, rendered text, and a reference to the reviewed image version. Use the campaign and ticket number to guard against accidental duplicate queue entries. The operator can remove an invitation before its first submission and stage a corrected version from Recipients. Keep the removed snapshot in the work history. A newly staged batch waits for a separate start action. Show the staged rows in the Queue tab at the end of this split.

**Acceptance.** An operator can inspect eligible rows, deselect one across a filter change, preview the correct message and ticket, and stage the intended set exactly once. Staging makes zero provider send requests.

## Split 3 — Sending, delivery tracking, and deployment

Implement **Start sending**, **Pause sending**, and **Resume**. A durable MySQL queue tracks the batch and each attempt. Allow one started or paused batch per sender. Rows staged after a batch starts wait for their own start action. One worker handles the sender number, observes a configurable ceiling of eight submissions per minute with variable gaps, and respects the provider's rate limits and retry delays. Pause stops new submissions and allows submitted messages to receive their delivery updates. The operator confirms the audience is eligible for WhatsApp outreach before starting a live batch.

Keep a simulated provider available to exercise the complete queue without external messages. The live adapter submits through the Wassenger API and stores the provider message ID. Use the Wassenger callback method available on the account to authenticate incoming updates. Deduplicate callbacks, handle out-of-order updates, and associate each update with its invitation or test send. Distinguish Wassenger acceptance from delivery. Display record-level timestamps and failure reasons. An uncertain submission stays pending for reconciliation or review. Retry is available only when the previous send is known to have failed and a repeat is permitted.

### Test sends page

Add a dedicated, sign-in-protected **Test sends** page. The operator can add and manage one or more test recipients directly by name and phone number, select the intended recipients, and preview the current invitation using a sample ticket number and a test image. An explicit **Send test** action sends to the selected test numbers using the same sender, messaging adapter, media handling, and rate limiter as the event invitations. A live test uses opted-in recipients and the template rules of the configured connector.

Show individual send results and timestamps in the test history. Test recipients and test messages stay separate from the CSV, event queue, and campaign totals. Sending a test leaves the staged campaign waiting for **Start sending**.

### Shared Wassenger account and deployment

Confirm the Wassenger connector, plan, sending limits, supported media submission, and receipt events before enabling live sending. For the official WhatsApp Business API, business-initiated outreach uses an approved template where required, with the ticket number as a body variable and the ticket as the image header. An edited draft that changes the fixed wording needs an approved template before it can be used for that send. Deliver each image through the supported media upload or a scoped signed URL. Keep contacts, tickets, and credentials private. [Wassenger API examples](https://app.wassenger.com/help/api-examples) · [WhatsApp Business Messaging Policy](https://business.whatsapp.com/policy)

Reuse the Wassenger account used by Orbit (SENTRA). Add a separate delivery webhook for this app, scoped to the sender and the outbound status events needed for delivery tracking. Keep Orbit's webhook registered. When both apps use the same sender, match incoming updates against known message IDs or app-generated references so only this app's invitations and test history are updated. Account for traffic from both apps when checking shared provider limits. [Wassenger webhook registration](https://wassenger.com/developers) · [Wassenger device scoping](https://console.wassenger.com/help/category/faq)

Deploy the app and worker from the same codebase with a persistent upload volume. Connect both services to the existing MySQL resource on its private Coolify destination network using `DATABASE_URL`, with a dedicated schema and runtime account for this app. The organizer adds the project to Coolify and supplies runtime settings there. Publish the app on a Coolify-managed HTTPS subdomain and use its HTTPS callback URL for the new webhook. [Coolify MySQL](https://coolify.io/docs/databases/mysql) · [Coolify Compose deployment](https://coolify.io/docs/docs/applications/builds/docker-compose) · [Coolify domains](https://coolify.io/docs/core/networking/domains)

**Acceptance.** The simulated provider verifies start, pause, resume, throttling, receipt updates, and safe retry. An operator can add two test recipients from the app, select one, preview and send a test, and find its status in test history while the event queue and totals stay intact. After the target and exact database commands are approved, verify persistence against the named test database. A separately authorized test to an opted-in number verifies the live template, ticket image, and delivery receipt before any event batch is enabled. Verify that Orbit still receives its expected webhook events after the new webhook is registered.

## Inputs and boundaries

The approved layouts and example CSV are sufficient for the first two splits. A populated event CSV is needed for the live event. Verify the existing Wassenger account's connector and plan before live integration. The Coolify subdomain is needed for deployment and callback registration. The operator adds opted-in test recipients through the app when ready. Use synthetic data for development. The initial scope is one operator workflow and one sender number per batch.

Prepare schema changes and fixtures for review. Before running database changes or database-backed tests that write state, show the exact commands, the target database or environment, and the expected changes, then obtain explicit confirmation. Prepare production configuration separately from deploying it or sending live invitations.

Provisioning proposes a UTF-8 `dinnerdance` schema and a `dinner_dance_app` account limited to selecting, inserting, updating, and deleting application rows in that schema. Apply schema changes separately with an authorized administrative connection. Confirm the existing Coolify MySQL resource and environment before executing provisioning, and verify the server version and that the proposed schema and account names are available. Use in-memory test repositories to verify application logic before a database target is authorized.

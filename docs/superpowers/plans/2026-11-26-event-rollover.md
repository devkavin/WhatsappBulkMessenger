# Event rollover implementation plan

The approved design creates an empty event, archives the previous event and cancels unsent event work. Test sends and sender configuration remain shared across events.

- [x] Add authenticated confirmation and archive pages. Verify that the pending count is shown, confirmation is required, stale confirmations fail, and archived tickets and delivery results have read-only views.
- [x] Add migration 005 and scope imported contacts, uploaded images and staged invitations to an event. Backfill existing records to the initial event. Include the event ID in active forms so a late upload or send action cannot affect a replacement event.
- [x] Switch events in one transaction, taking the draft lock followed by the delivery control lock. Recheck the preview under both locks, reject an unresolved dispatch lease, cancel pending work, then archive and switch the event pointer. Keep attempts and image files available to the delivery worker and history.
- [x] Verify with the in-memory and HTTP test suite, TypeScript build and diff check. Review the migration without applying it to MySQL.

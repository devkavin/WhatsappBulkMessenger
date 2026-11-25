# Files and Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task by task. Steps use checkboxes for tracking.

**Goal** — Deliver the approved Files page for importing an event CSV and matching private ticket image uploads.

**Architecture** — An authenticated Express app renders the Files state from an upload service and a repository. The production repository uses the dedicated MySQL schema on Coolify. Uploaded image bytes live on a private volume and metadata points to immutable file versions. Tests use an in-memory repository and temporary files.

**Tech stack** — Node.js, TypeScript, Express, MySQL, server-rendered HTML, and Node's test runner.

**Spec** — [Dinner Dance WhatsApp invitations design](../specs/2026-11-25-dinner-dance-invitations-design.md)

## Global constraints

- Keep the slate-and-indigo layout and the Files, Recipients, and Queue navigation from the approved mockups.
- Hold database provisioning, migrations, and tests against a real database until their exact commands and target have been expressly approved. Keep migration execution separate from application startup.
- Run development checks with synthetic data and keep production contacts and uploaded tickets out of the source tree.
- Split 1 has no queueing or Wassenger calls.
- Use a single `DATABASE_URL` setting for MySQL. The organizer configures production environment variables in Coolify.

## Review focus

- Format differences in CSVs. Test a UTF-8 BOM, quoted names, optional ranks, and reordered headers.
- Ticket identity. Test leading zeros, duplicate tickets, and different tickets using the same number.
- CSV replacement. Test that a malformed replacement leaves the existing import visible and that a valid replacement rematches the existing images.
- Upload contents. Test filenames that could escape the upload directory, unsupported bytes, and duplicate ticket-image candidates.
- Operator access. Test that upload routes and private files are inaccessible without an authenticated session.

## Task 1 — CSV parsing and ticket matching

**Files** — `src/config.ts`, `src/imports/contacts.ts`, `src/imports/matches.ts`, `tests/imports.test.ts`, `package.json`, `tsconfig.json`.

**Interfaces** — `parseContacts(csv: string, defaultCountry: CountryCode): ContactImport` returns the normalized source rows and row issues. `matchImages(rows: ContactRow[], images: TicketImage[]): ImageMatches` returns the match status per ticket and unmatched uploads. Each image exposes its immutable ID and original filename.

- [ ] Add a parser test that imports `Ticket No,Contact,Name` from a UTF-8 BOM CSV, preserves `0042`, and handles a quoted name with a comma. A missing required header fails import. Blank `Contact` is a row issue. The same phone on tickets `0042` and `0043` is allowed, and two rows for `0042` are flagged as duplicates.
- [ ] Add a matching test proving `0042.png` matches `0042`, `042.jpg` is unmatched, and adding `0042.jpg` produces a conflict. A separate imported ticket remains missing until its image arrives.
- [ ] Run `npm test` and observe that the tests fail before the parsing and matching modules are implemented.
- [ ] Implement the two modules and the project bootstrap needed to run them. Keep invalid data visible for review. Run `npm test` and expect both sets of tests to pass.

## Task 2 — Private upload storage and MySQL metadata

**Files** — `src/files/service.ts`, `src/files/mysql-repository.ts`, `db/migrations/001_files.sql`, `tests/files.test.ts`.

**Interfaces** — `FilesService.read()` returns the CSV, images, and matches. `FilesService.replaceCsv(name: string, bytes: Buffer)` replaces the import atomically. `FilesService.uploadImages(files: IncomingImage[])` returns the uploaded filenames and any per-file errors. The repository stores each original filename and immutable file ID, and commits image metadata and the draft version pointer together.

- [ ] Add tests that replace a valid CSV with an invalid one and retain the previous import, rematch existing images on a valid replacement, reject path-like filenames and unsupported payloads, and report upload errors without dropping valid images from the same selection. Verify image reads use known IDs within the private upload root.
- [ ] Run `npm test` and observe the new failures before implementing storage.
- [ ] Implement the Files service, image validation and storage, a MySQL repository using prepared statements, and the migration file. Store image bytes under generated IDs. Roll back each new file if saving its metadata fails. Stage a new CSV import as one transaction. Run the suite against test doubles and confirm no hosted database is used.
- [ ] Verify the migration with the approved disposable database once the exact database operation is authorized. Check transaction rollback and persistent image retrieval across a process restart.

## Task 3 — Files page and access

**Files** — `src/app.ts`, `src/server.ts`, `src/auth/session.ts`, `views/files.ejs`, `public/app.css`, `public/uploads.js`, `tests/files-http.test.ts`, `Dockerfile`, `compose.yaml`, `.env.example`.

**Interfaces** — `createApp({filesService, config}): Express` accepts an injectable Files service. Authenticated routes serve `/files`, accept the CSV and the image batches, and serve previews by immutable ID. Operator sessions use secure cookies in HTTPS environments.

- [ ] Add HTTP tests proving an anonymous operator cannot read or upload files, an authenticated operator can replace the CSV, and image match counts and errors render after a multipart upload. Verify forms reject invalid session or request tokens.
- [ ] Run `npm test` and observe the new failures before creating the app routes and page.
- [ ] Build the Files page from the approved mockup. Include the CSV summary, multipart batch picker and drop target, match counts, issue filters, and per-row **Add image**. Limit individual uploads and send large selections in bounded groups. Preserve useful feedback on partial success.
- [ ] Configure the app container and persistent upload volume. Read connection settings from the environment and connect to the existing Coolify MySQL service. Keep the private volume outside the static web directory. Leave production secrets and database initialization outside Compose.
- [ ] Run `npm test` and `npm run build`. Verify the Files screen against the mockup at desktop and narrow widths. Verify that unavailable later tabs are communicated without suggesting those workflows are ready.

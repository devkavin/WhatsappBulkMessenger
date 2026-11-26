# Dinner Dance Invitations

Import contacts and ticket images in **Files**, review the message and select recipients in **Recipients**, then stage invitations in **Queue**. A separate worker processes a batch after **Start sending**. Use **Test sends** to preview and submit an isolated test and view its delivery history.

Open **Events → Start new event** to archive the current event and begin with an empty contact list, ticket list, and sending queue. Review the pending invitation count and confirm the switch. If a submission is in progress, pause the queue and wait for it to finish. The archived event keeps its tickets and updates delivery statuses as receipts arrive. The new event starts with the default invitation message. Test recipients and sending settings are shared across events.

## Coolify configuration

Add the project as a Docker Compose application using `compose.yaml`. Run the app and worker on the same Coolify server and destination network as MySQL and connect them to that predefined network. In Coolify's **Domains** settings, route the HTTPS domain to the `app` service on internal port `3100`. The worker uses the same private database and reads from the shared image volume. [Coolify Compose applications](https://coolify.io/docs/applications/builds/docker-compose#configure-public-services) · [Coolify MySQL](https://coolify.io/docs/databases/mysql)

Set these runtime environment variables in Coolify. Use the hostname from the database's internal URL and the credentials for the Dinner Dance application account. Enter the password as issued. In Coolify, select **Literal** for `DB_PASSWORD` if it contains `$`. [Coolify environment variables](https://coolify.io/docs/applications/configuration/environment-variables#multiline-and-literal-values)

| Variable | Value |
| --- | --- |
| `DB_HOST` | The internal MySQL hostname, such as `mysql-host`. |
| `DB_NAME` | The MySQL database name, such as `dinnerdance`. |
| `DB_PASSWORD` | The application account's MySQL password. |
| `DB_PORT` | The internal MySQL port. Defaults to `3306`. |
| `DB_USER` | The MySQL application username, such as `dinner_dance_app`. |
| `DB_SSL` | Set `true` when MySQL requires TLS or when replacing a URL that used `?ssl=true`. Defaults to `false`. |
| `DB_SSL_CA` | Optional PEM CA certificate for a MySQL server that uses a private CA. Set the Coolify value type to **Multiline**. |
| `APP_ORIGIN` | The app's HTTPS origin, such as `https://tickets.example.com` |
| `APP_PASSWORD` | The operator's sign-in password, at least 12 characters |
| `SESSION_SECRET` | A separate randomly generated secret, at least 32 characters |
| `DEFAULT_COUNTRY` | Country used to validate local phone numbers. Defaults to `LK`. |
| `DELIVERY_MODE` | `simulate` by default. Set `live` only for a deployment connected to Wassenger. |
| `SEND_PER_MINUTE` | Maximum submissions per minute, from 1 to 8. Defaults to 8. Use a lower value when the sender's capacity is shared with Orbit. |

The `ticket_uploads` volume keeps private image files across redeployments. The Docker image checks `/health` on the app's internal port. The worker's Compose health check uses a read-only query to verify MySQL access and the delivery control row. Coolify reports an overall health status for the two containers.

If Coolify shows **Restarting**, open **Runtime Logs** and select the restarting service to find its startup error. For an unhealthy container, inspect the Docker health log with `docker inspect --format '{{json .State.Health}}' <container>`. If opening **Files** or running the worker logs `ECONNREFUSED`, check that MySQL is running, the app shares its Coolify destination network, and `DB_HOST` and `DB_PORT` match the MySQL resource's internal connection details. [Coolify health checks](https://coolify.io/docs/applications/configuration/health-checks)

If the logs show `ER_SECURE_TRANSPORT_REQUIRED`, enable `DB_SSL` and redeploy. If MySQL uses a Coolify-generated certificate, use the CA certificate from the database server's `/data/coolify/ssl/coolify-ca.crt` as `DB_SSL_CA`. For a database managed elsewhere, use the CA supplied by that provider. The app and worker both verify the certificate chain. [Coolify database SSL](https://coolify.io/docs/databases/ssl#trust-the-coolify-ca-certificate)

## Database setup

Provision the dedicated database and account as an approved administrative operation. Apply [001 Files](db/migrations/001_files.sql), [002 invitation staging](db/migrations/002_invitation_staging.sql), [003 delivery](db/migrations/003_delivery.sql), [004 Wassenger status](db/migrations/004_wassenger_status.sql), and [005 Events](db/migrations/005_events.sql) in order on a new database. For an existing deployment, review and approve the pending SQL for the target database, back up the schema, and stop the old app and worker before applying the missing migrations through the administrative connection. Migration 005 assigns the existing CSV, ticket images, and staged invitations to the initial Dinner Dance event and preserves their delivery records. Deploy the updated app and worker after it succeeds. The runtime account uses `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the app's schema.

## Simulation and live verification

Leave `DELIVERY_MODE=simulate` for a rehearsal. Add a fictional test recipient, enter a sample ticket number and attach a test image on **Test sends**. The worker records the simulated result in separate history. A simulated event run uses separate job records, so it leaves the staged invitations eligible for a future live run. Finish any active batch before switching modes.

For live operation, use the Wassenger device already connected to the intended WhatsApp number. Verify the connector, available delivery events and sender limits in that account. Set the same delivery settings on the app and worker. The provider token and webhook secret are runtime secrets in Coolify. [Wassenger API](https://wassenger.com/developers) · [Wassenger webhook events](https://wassenger.com/blog/en/how-to-use-webhooks-for-whatsapp-messages)

| Live setting | Value |
| --- | --- |
| `DELIVERY_MODE` | `live` |
| `WASSENGER_API_TOKEN` | The workspace API token |
| `WASSENGER_DEVICE_ID` | The ID of the sender connected in Wassenger |
| `WASSENGER_CONNECTOR` | `business` for Business API or `qr` for a QR-linked sender |
| `WASSENGER_WEBHOOK_SECRET` | A separate random secret of at least 32 characters |
| `WASSENGER_TEMPLATE_NAME` and `WASSENGER_TEMPLATE_LANGUAGE` | The approved Business API template with an image header and one body variable. Required for `business`. |
| `WASSENGER_TEMPLATE_BODY` | The exact approved wording, with its one ticket-number variable written as `{{ticket_number}}`. The draft and staged wording must match for Business API sends. |

Register a **new** Wassenger webhook scoped to the sending device. In the URL-only form, use `https://YOUR_APP_HOST/webhooks/wassenger?secret=URL_ENCODED_WEBHOOK_SECRET`, replacing the placeholder with the URL-encoded `WASSENGER_WEBHOOK_SECRET`. Treat the full URL as a secret. Existing header-based webhooks can use `https://YOUR_APP_HOST/webhooks/wassenger` with `X-Dinner-Dance-Webhook-Secret` set to the same value. Subscribe to `message:out:new` and `message:out:failed`, plus `message:out:ack` if available. Keep the Orbit webhook registered. The app matches updates using its own provider IDs or attempt references. Wassenger receives a signed HTTPS link for each ticket image that expires after 24 hours. [Wassenger webhook guide](https://wassenger.com/blog/en/how-to-use-webhooks-for-whatsapp-messages) · [Wassenger image template example](https://app.wassenger.com/help/api-tester?example=send-template-image)

**Queue** and **Test sends** show app processing and Wassenger status in separate columns. **Submitted** in the app means the send was handed off. The Wassenger column shows the provider status, its source, and the last matched webhook event and time. Both pages check for updates every five seconds while the tab is visible. Older attempts may show a known outcome with no recorded source. Wassenger counts cover the invitations sent by this app.

Before an event send, use **Test sends** with an opted-in number and confirm that the correct text and image arrived. A delivered live test for the configured sender and template unlocks event sending. Starting a batch requires confirming recipient opt-in. **Pause** holds further event submissions. **Submitted** means Wassenger accepted the request. **Delivered** requires a receipt or a confirmed provider status. A confirmed rate-limit rejection can be retried. For **Needs review**, the worker looks up the exact attempt reference and recipient in Wassenger. The row retains its reference for manual review if the lookup remains inconclusive. [Wassenger outbound lookup](https://github.com/wassengerhq/n8n-wassenger/blob/master/src/actions/outboundMessages.ts#L505-L551)

## Local development

Use Node.js 24 or later. Run `npm ci`, `npm test`, and `npm run build`. The tests use synthetic data, in-memory repositories, temporary files and a local loopback server. To run the local app and worker with an approved database, configure the variables in [.env.example](.env.example), then use `npm run dev` for the app and `npm run worker` for the built worker.

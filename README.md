# Dinner Dance Invitations

Import contacts and ticket images in **Files**, review the message and select recipients in **Recipients**, then stage invitations in **Queue**. A separate worker processes a batch after **Start sending**. Use **Test sends** to preview and submit an isolated test and view its delivery history.

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
| `DB_SSL` | Optional. Set `true` to use MySQL TLS with certificate verification, including when replacing a URL that used `?ssl=true`. Defaults to `false`. |
| `APP_ORIGIN` | The app's HTTPS origin, such as `https://tickets.example.com` |
| `APP_PASSWORD` | The operator's sign-in password, at least 12 characters |
| `SESSION_SECRET` | A separate randomly generated secret, at least 32 characters |
| `DEFAULT_COUNTRY` | Country used to validate local phone numbers. Defaults to `LK`. |
| `DELIVERY_MODE` | `simulate` by default. Set `live` only for a deployment connected to Wassenger. |
| `SEND_PER_MINUTE` | Maximum submissions per minute, from 1 to 8. Defaults to 8. Use a lower value when the sender's capacity is shared with Orbit. |

The `ticket_uploads` volume keeps private image files across redeployments. The Docker image checks `/health` on the app's internal port and records probe errors in Docker's health log. The background worker has no HTTP listener, so its Compose service disables that probe.

If Coolify shows **Restarting**, open **Runtime Logs** and select the restarting service to find its startup error. For a running but unhealthy `app` container, inspect the Docker health log with `docker inspect --format '{{json .State.Health}}' <app-container>`. [Coolify health checks](https://coolify.io/docs/applications/configuration/health-checks)

## Database setup

Provision the dedicated database and account as an approved administrative operation. A new instance needs [001 Files](db/migrations/001_files.sql), [002 invitation staging](db/migrations/002_invitation_staging.sql), and [003 delivery](db/migrations/003_delivery.sql), in that order. For a database running Split 2, `003_delivery.sql` creates the outbound control, test recipient, job and attempt tables and inserts the initial control row. Review and approve migration execution for the target instance before upgrading. The runtime account uses `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the app's schema. Apply migrations through the administrative connection.

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

Register a **new** Wassenger webhook, scoped to the sending device, with the destination `https://YOUR_APP_HOST/webhooks/wassenger` and custom header `X-Dinner-Dance-Webhook-Secret` set to `WASSENGER_WEBHOOK_SECRET`. Subscribe to `message:out:ack`, `message:out:failed`, and `message:out:new` where available. Keep the Orbit webhook registered. This app matches status updates to its own provider IDs or attempt references. Wassenger receives a signed HTTPS link for the individual image that expires after 24 hours. [Wassenger custom headers](https://wassenger.com/developers) · [Wassenger image template example](https://app.wassenger.com/help/api-tester?example=send-template-image)

Before an event send, use **Test sends** with an opted-in number and confirm that the correct text and image arrived. A delivered live test for the configured sender and template unlocks event sending. Starting a batch requires confirming recipient opt-in. **Pause** holds further event submissions. **Submitted** means Wassenger accepted the request. **Delivered** requires a receipt or a confirmed provider status. A confirmed rate-limit rejection can be retried. For **Needs review**, the worker looks up the exact attempt reference and recipient in Wassenger. The row retains its reference for manual review if the lookup remains inconclusive. [Wassenger outbound lookup](https://github.com/wassengerhq/n8n-wassenger/blob/master/src/actions/outboundMessages.ts#L505-L551)

## Local development

Use Node.js 24 or later. Run `npm ci`, `npm test`, and `npm run build`. The tests use synthetic data, in-memory repositories, temporary files and a local loopback server. To run the local app and worker with an approved database, configure the variables in [.env.example](.env.example), then use `npm run dev` for the app and `npm run worker` for the built worker.

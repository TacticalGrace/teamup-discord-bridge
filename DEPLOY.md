# Deployment

Written for whoever is taking over operation of this service. No prior context assumed.

## Summary

A Node service that reads a public Teamup calendar on a timer and posts to one
Discord channel through a webhook. It is read-only against Teamup and write-only against a
single Discord channel. It cannot modify the calendar, read Discord messages, or act anywhere
else on the server.

Three message types: a weekly digest, countdown reminders before each event, and alerts when an
event is added, rescheduled, moved, or removed.

## Prerequisites

- A Render account, or any host that runs a Node 20+ process. The included
  [render.yaml](render.yaml) targets Render.
- A Discord webhook on the target channel: Channel Settings, Integrations, Webhooks, New
  Webhook, Copy Webhook URL. Requires the Manage Webhooks permission on that channel.
- The Teamup calendar key: the last path segment of the public calendar link. See
  [Chapter values](#chapter-values).

No Teamup account or API key is required in the current configuration. See
[Teamup access](#teamup-access).

## Decisions before deploying

1. **Target channel.** Starting in a lower-traffic channel for a week and then swapping the
   webhook URL is a low-risk way to evaluate message volume.
2. **Render plan.** The free tier works with one caveat, described in [State and the free
   tier](#state-and-the-free-tier).
3. **Role ping.** Off by default. `DISCORD_MENTION_ROLE_ID` pings a role on reminders and the
   digest.
4. **Account ownership.** The Render account and the webhook should be chapter-controlled rather
   than personal.

## Steps

### 1. Repository

Render deploys from Git. Push this directory to the chapter's GitHub organization. `.env` is
gitignored and holds the webhook URL; secrets belong in Render's environment variable UI, which
is how [render.yaml](render.yaml) is configured.

### 2. Create the service

In Render: New, then Blueprint, pointed at the repository. It reads `render.yaml` and prompts
for the values marked `sync: false`:

| Prompt | Value |
| --- | --- |
| `TEAMUP_CALENDAR_KEY` | see [Chapter values](#chapter-values) |
| `TEAMUP_API_KEY` | leave blank |
| `DISCORD_WEBHOOK_URL` | the webhook created above |

`ADMIN_TOKEN` is generated automatically. All other variables have defaults in the blueprint.

### 3. First deploy

Set `DRY_RUN=true` before the first deploy. The service runs normally but logs payloads instead
of sending them. Confirm the events in the logs look correct, then set `DRY_RUN=false` and
redeploy.

### 4. Uptime pinger (free tier only)

Free Render web services sleep after 15 minutes without inbound traffic, and a sleeping service
runs no timers. Point a pinger at `https://<service>.onrender.com/healthz` at a 10 minute
interval. [cron-job.org](https://cron-job.org) and [UptimeRobot](https://uptimerobot.com) are
sufficient.

## First-run behavior

The first run posts nothing. With no saved state, the run is treated as priming: it records the
calendar as it stands and marks anything already due as handled. Without this, pointing the
service at a calendar holding 45 events would post all of them at once.

After the first deploy, expect silence until the next reminder window opens, the next calendar
change, or the scheduled digest.

## Verification

Health and last-run status:

```
GET https://<service>.onrender.com/healthz
{ "service": "nadsa-teamup-discord", "ok": true, "lastRunAt": "...", "runs": 12 }
```

Force an immediate check instead of waiting for the timer:

```
POST https://<service>.onrender.com/run?token=<ADMIN_TOKEN>
```

From a local checkout with `.env` configured:

```bash
npm run preview        # print what Teamup returns; posts nothing
npm run digest         # post a digest for the next 7 days
npm run digest 14      # wider window
npm run reminder       # post a reminder for the next event
npm run demo:clean     # delete messages posted by the commands above
npm test               # 166 tests; no network required
```

`demo:clean` records the IDs of messages it posts and deletes them through the webhook. It only
knows about messages this tool created.

## Teamup access

Three sources, selected in this order:

1. `TEAMUP_API_KEY` set: the documented REST API at `api.teamup.com`. Keys are free from
   <https://teamup.com/api-keys/request> and require a Teamup account.
2. `TEAMUP_ICS_URL` set: the public iCal feed, confirmed working at
   `https://ics.teamup.com/feed/<calendar key>/0.ics`. Recurrence expansion is local and
   approximate.
3. Neither: `teamup.com/{key}/events`, the endpoint the Teamup web application uses. It returns
   the same JSON as the documented API for a public calendar, without credentials and with
   server-side recurrence expansion. This is the current configuration.

Option 3 is undocumented and could change without notice. If fetches begin failing, setting
`TEAMUP_API_KEY` restores service without a code change. This is the primary known operational
risk.

## State and the free tier

Free Render instances have an ephemeral filesystem, so the dedup state file is cleared on every
deploy. The following run re-primes: it records the calendar and suppresses anything already
due rather than re-announcing it.

Consequence: a redeploy at 5:00 PM, where a 7:00 PM event's 2-hour reminder was already due,
skips that reminder. The failure mode is a missed post rather than duplicates, which is the
intended tradeoff for an announcements channel.

To remove the caveat, move to a paid instance, uncomment the `disk:` block in `render.yaml`, and
set `STATE_FILE=/var/data/state.json`.

## Configuration

Full list with inline notes in [.env.example](.env.example). Commonly adjusted:

| Variable | Current | Effect |
| --- | --- | --- |
| `ORG_NAME` | your organization | Shown in post footers and the iCalendar `PRODID` |
| `DIGEST_INTRO` | a greeting | Opening line of the digest post |
| `DIGEST_DAY` / `DIGEST_HOUR` | `friday` / `9` | Digest schedule |
| `DIGEST_LAYOUT` | `grouped` | `grouped`, `compact`, `cards`, `flat` |
| `REMINDER_OFFSETS_MINUTES` | `1440,120` | Minutes before an event to post |
| `DISCORD_MENTION_ROLE_ID` | blank | Role to ping; blank disables pings |
| `TEAMUP_SUBCALENDAR_IDS` | all | Restrict to specific sub-calendars |
| `ADD_TO_CALENDAR_ENABLED` | `false` | See [Disabled features](#disabled-features) |
| `CHANGE_ALERTS_ENABLED` | `true` | |
| `DIGEST_ENABLED` | `true` | |
| `DRY_RUN` | `false` | Log payloads instead of posting |

Changing any of these is an environment edit and restart, not a code change. Invalid values fail
at startup with a message naming the variable.

## Stopping it

- `DRY_RUN=true` and restart: continues running and logging, posts nothing.
- Suspend the Render service: stops it entirely.
- Delete the webhook in Discord channel settings: revokes its ability to post regardless of
  service state.

## Disabled features

**Add-to-calendar links** (`ADD_TO_CALENDAR_ENABLED=false`). Implemented and tested: signed
`.ics` files served at `/event.ics` for Apple Calendar, Outlook desktop, and Thunderbird, plus
prefilled Google Calendar and Outlook Web links. Disabled pending a decision on a flow that
works for every calendar application without per-event friction. A one-time `webcal://`
subscribe link to the Teamup feed, pinned in the channel, is the likely alternative and is not
implemented.

**Native Discord scheduled events.** Not used. Populating Discord's built-in event calendar
requires a bot application with the Manage Events permission, rather than a webhook. A webhook
requires no application, no OAuth, and no permissions beyond the one channel. This is a
well-defined extension if the chapter later wants it.

## Security

- The webhook URL is a bearer credential. Anyone holding it can post to the channel as this
  application. It is stored only in the host environment.
- `ADMIN_TOKEN` guards `POST /run`. When unset, that route returns 404 rather than being open.
- `/event.ics` links are HMAC-signed so the endpoint cannot be used to serve arbitrary calendar
  files from the chapter's host. Altered links return 403. Relevant only when add-to-calendar is
  enabled.
- The service holds no inbound Discord permissions. It cannot read messages or enumerate members.
- Teamup access is read-only against a public calendar, so no Teamup credential exists to leak
  in the current configuration.

## Cost

Free on Render's free web service tier plus a free uptime pinger. A paid instance, around $7 per
month, adds a persistent disk and removes the missed-reminder caveat.

## Code layout

```
src/
  config.ts          environment parsing and validation
  teamup/            calendar sources and the normalized event model
  bridge.ts          announcement logic
  embeds.ts          message construction
  discord.ts         webhook client
  calendar-links.ts  .ics generation, signing, provider URLs
  state.ts           dedup state
  server.ts          HTTP endpoints
  index.ts           scheduler and process lifecycle
test/                unit and scenario tests, one file per module
```

`npm test` covers priming silence, duplicate suppression, outage catch-up, restart persistence,
digest cadence and formatting, RFC 5545 escaping and line folding, and signature rejection. It
requires no network access and no Discord credentials.

## Chapter values

North Alabama DSA specifics, for the deployment described above:

| Setting | Value |
| --- | --- |
| `TEAMUP_CALENDAR_KEY` | `ksnzpyhp4t3mx2c7t2` |
| Public calendar | <https://teamup.com/ksnzpyhp4t3mx2c7t2> |
| iCal feed | `https://ics.teamup.com/feed/ksnzpyhp4t3mx2c7t2/0.ics` |
| `ORG_NAME` | `North Alabama DSA` |
| `TIMEZONE` | `America/Chicago` |

Nothing else in this repository is chapter-specific; another organization needs only its own
values for the table above plus its own Discord webhook.

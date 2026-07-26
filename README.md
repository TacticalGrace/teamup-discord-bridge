# teamup-discord-bridge

Reads a public [Teamup](https://teamup.com) calendar and posts to a Discord channel through a
webhook. Teamup remains the source of truth; the Discord channel is a mirror
that requires no manual upkeep.

Deployment instructions are in [DEPLOY.md](DEPLOY.md).

## Messages

| Kind | Trigger |
| --- | --- |
| Weekly digest | Configurable day and hour (default Friday 9:00 AM Central), listing the next 7 days |
| Countdown reminder | Configurable offsets before each event (default 24 hours, then 2 hours) |
| Change alert | An event is added, rescheduled, moved, or removed on Teamup |

Event titles link to their Teamup entries. Times use Discord dynamic timestamps, so each reader
sees them in their own time zone.

## Requirements

- Node 20 or later
- A Discord webhook URL for the target channel
- A Teamup calendar key (the last path segment of the public calendar link)

## Local use

```bash
npm install
cp .env.example .env     # set DISCORD_WEBHOOK_URL and TEAMUP_CALENDAR_KEY
npm run preview          # print what Teamup returns; posts nothing
npm test                 # unit and scenario tests; no network required
```

Commands that post to Discord:

```bash
npm run digest [days]    # post a digest for the next N days (default 7)
npm run reminder [count] # post reminders for the next N events (default 1)
npm run once             # one full check, then exit
npm run demo             # scripted walkthrough of every message type
npm run demo:clean       # delete messages posted by the commands above
```

`DRY_RUN=true` makes every path log its payload instead of sending it.

`npm run demo` requires only a webhook; it uses scripted events and a separate state file, so it
cannot disturb a running deployment.

## Reading Teamup

Three sources, selected in this order:

1. `TEAMUP_API_KEY` set: the documented REST API at `api.teamup.com`.
2. `TEAMUP_ICS_URL` set: the public iCal feed. Recurrence expansion is local and approximate.
3. Neither: `teamup.com/{key}/events`, the endpoint the Teamup web app uses. It returns the same
   JSON as the API for a public calendar without credentials, including server-side recurrence
   expansion. This is undocumented and could change; setting `TEAMUP_API_KEY` is the fallback.

## Behavior

- **Change detection is fingerprint-based.** Events hash on title, start, end, all-day flag, and
  location. Editing an event's notes does not trigger an alert; moving it does.
- **One reminder per offset per event.** After downtime, at most one catch-up reminder is posted,
  headlined with the time actually remaining rather than the configured offset.
- **An empty calendar response is not treated as a mass cancellation.** If Teamup returns zero
  events, the bridge assumes a bad response and stays silent.
- **The first run is silent.** With no state file, the run records the calendar and marks
  anything already due as handled, so pointing the bridge at an existing calendar does not
  backfill the channel.
- **State is written before posting.** A crash mid-post loses one announcement rather than
  replaying a batch on the next tick.

## Add-to-calendar links

Disabled by default (`ADD_TO_CALENDAR_ENABLED=false`). When enabled, event posts carry links to
Google Calendar, Outlook Web, and a signed `.ics` file served by this service at `/event.ics`
for Apple Calendar, Outlook desktop, and Thunderbird.

The event is encoded into the `.ics` link rather than looked up from state, so links remain
valid after a redeploy clears the state file. Links are signed with an HMAC keyed on
`LINK_SECRET` (derived from the webhook URL when unset); unsigned or altered links return 403.

With no `PUBLIC_BASE_URL` and no Render-provided external URL, the `.ics` link is omitted and the
provider links are used alone.

## Configuration

Every setting is an environment variable, documented inline in [.env.example](.env.example).

| Variable | Default | Notes |
| --- | --- | --- |
| `TEAMUP_CALENDAR_KEY` | required | Last path segment of the public calendar link |
| `TEAMUP_API_KEY` | none | Enables the documented REST API |
| `TEAMUP_ICS_URL` | none | Enables the iCal feed source |
| `TEAMUP_SUBCALENDAR_IDS` | all | Comma-separated sub-calendar IDs to restrict to |
| `DISCORD_WEBHOOK_URL` | required | Target channel webhook |
| `DISCORD_MENTION_ROLE_ID` | none | Role ID to ping; `everyone` and `here` also accepted |
| `ORG_NAME` | `Community Calendar` | Shown in post footers and the iCalendar `PRODID` |
| `TIMEZONE` | `America/Chicago` | IANA zone used for formatting and scheduling |
| `REMINDER_OFFSETS_MINUTES` | `1440,120` | Minutes before an event to post |
| `DIGEST_ENABLED` | `true` | |
| `DIGEST_DAY` / `DIGEST_HOUR` / `DIGEST_MINUTE` | `friday` / `9` / `0` | |
| `DIGEST_INTRO` | a greeting | Opening line of the digest post |
| `DIGEST_LAYOUT` | `grouped` | `grouped`, `compact`, `cards`, or `flat` |
| `CHANGE_ALERTS_ENABLED` | `true` | |
| `ADD_TO_CALENDAR_ENABLED` | `false` | |
| `PUBLIC_BASE_URL` | Render's external URL | Host serving `.ics` downloads |
| `LINK_SECRET` | derived | Signing key for `.ics` links |
| `POLL_INTERVAL_MINUTES` | `10` | |
| `HORIZON_DAYS` | `60` | How far ahead to read |
| `STATE_FILE` | `./data/state.json` | |
| `DRY_RUN` | `false` | |
| `PORT` | `10000` | |
| `ADMIN_TOKEN` | none | Enables `POST /run` |

Invalid values fail at startup with a message naming the variable.

## HTTP endpoints

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Health check and last-run status |
| `GET /event.ics?d=&s=` | Signed single-event calendar file |
| `POST /run?token=` | Force an immediate check; requires `ADMIN_TOKEN` |

## Layout

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
  demo.ts            scripted walkthrough
test/                unit and scenario tests, one file per module
```

## License

CC0 1.0 Universal. See [LICENSE](LICENSE). Released into the public domain: copy it,
adapt it, run it for your own organization.

Contributions are accepted on the same terms — see [CONTRIBUTING.md](CONTRIBUTING.md).

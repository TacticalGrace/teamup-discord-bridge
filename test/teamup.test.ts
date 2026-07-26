import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { TeamupIcsSource } from '../src/teamup/ics.js';
import { dedupeIds, fingerprint, htmlToText } from '../src/teamup/types.js';
import { TZ, at, makeEvent } from './helpers.js';

describe('fingerprint', () => {
  const base = makeEvent({ id: 'a', start: at('2026-08-06T18:30') });

  it('is stable for identical events', () => {
    assert.equal(fingerprint(base), fingerprint({ ...base }));
  });

  it('ignores the fields an announcement does not report', () => {
    assert.equal(fingerprint(base), fingerprint({ ...base, description: 'Childcare provided.' }));
    assert.equal(fingerprint(base), fingerprint({ ...base, id: 'different' }));
    assert.equal(fingerprint(base), fingerprint({ ...base, subcalendarIds: [7] }));
  });

  it('changes when a reported field changes', () => {
    assert.notEqual(fingerprint(base), fingerprint({ ...base, title: 'Renamed' }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, start: at('2026-08-06T19:30') }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, end: at('2026-08-06T21:00') }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, location: 'Union Hall' }));
    assert.notEqual(fingerprint(base), fingerprint({ ...base, allDay: true }));
  });
});

describe('htmlToText', () => {
  it('returns null for empty input', () => {
    assert.equal(htmlToText(null), null);
    assert.equal(htmlToText(''), null);
    assert.equal(htmlToText('<p></p>'), null);
  });

  it('converts block tags to line breaks', () => {
    assert.equal(htmlToText('<p>One</p><p>Two</p>'), 'One\nTwo');
    assert.equal(htmlToText('One<br>Two'), 'One\nTwo');
  });

  it('bullets list items', () => {
    assert.equal(htmlToText('<ul><li>First</li><li>Second</li></ul>'), '• First\n• Second');
  });

  it('decodes the common entities', () => {
    assert.equal(htmlToText('Bread &amp; Roses'), 'Bread & Roses');
    assert.equal(htmlToText('&lt;tag&gt;'), '<tag>');
    assert.equal(htmlToText('It&#39;s here'), "It's here");
    assert.equal(htmlToText('a&nbsp;b'), 'a b');
  });

  it('collapses runs of blank lines to a single blank line', () => {
    assert.equal(htmlToText('<p>One</p><p></p><p></p><p>Two</p>'), 'One\n\nTwo');
  });

  it('preserves non-ASCII content', () => {
    assert.equal(htmlToText('<p>\u{1F339} DSA 101</p>'), '\u{1F339} DSA 101');
  });
});

describe('dedupeIds', () => {
  it('leaves unique ids untouched', () => {
    const events = [
      makeEvent({ id: 'a', start: at('2026-08-06T18:30') }),
      makeEvent({ id: 'b', start: at('2026-08-07T18:30') }),
    ];
    assert.deepEqual(
      dedupeIds(events).map((e) => e.id),
      ['a', 'b'],
    );
  });

  it('suffixes only the ids that collide', () => {
    const events = [
      makeEvent({ id: 'dup', start: at('2026-08-06T18:30') }),
      makeEvent({ id: 'dup', start: at('2026-08-13T18:30') }),
      makeEvent({ id: 'unique', start: at('2026-08-14T18:30') }),
    ];
    const ids = dedupeIds(events).map((e) => e.id);
    assert.equal(ids[2], 'unique');
    assert.notEqual(ids[0], ids[1]);
    assert.ok(ids[0]?.startsWith('dup@'));
  });
});

describe('TeamupIcsSource', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Teamup//EN',
    'BEGIN:VEVENT',
    'UID:one-off@teamup',
    'DTSTART;TZID=America/Chicago:20260806T183000',
    'DTEND;TZID=America/Chicago:20260806T200000',
    'SUMMARY:General Meeting',
    'LOCATION:Downtown Library',
    'DESCRIPTION:<p>Childcare <b>provided</b>.</p>',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@teamup',
    'DTSTART;TZID=America/Chicago:20260805T190000',
    'DTEND;TZID=America/Chicago:20260805T203000',
    'RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=6',
    'SUMMARY:Reading Group',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday@teamup',
    'DTSTART;VALUE=DATE:20260815',
    'DTEND;VALUE=DATE:20260816',
    'SUMMARY:Chapter Retreat',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:cancelled@teamup',
    'DTSTART;TZID=America/Chicago:20260810T190000',
    'STATUS:CANCELLED',
    'SUMMARY:Called Off',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  let server: Server;
  let url: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/calendar' });
      res.end(ics);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    url = `http://127.0.0.1:${port}/feed.ics`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('parses a one-off event and preserves its local start time', async () => {
    const events = await new TeamupIcsSource({ icsUrl: url }).fetchEvents(
      at('2026-08-01T00:00'),
      at('2026-09-01T00:00'),
    );
    const meeting = events.find((e) => e.title === 'General Meeting');
    assert.ok(meeting);
    assert.equal(
      DateTime.fromJSDate(meeting.start, { zone: TZ }).toFormat('yyyy-LL-dd HH:mm'),
      '2026-08-06 18:30',
    );
    assert.equal(meeting.location, 'Downtown Library');
    assert.equal(meeting.description, 'Childcare provided.');
  });

  it('expands recurrences and clips them to the window', async () => {
    const events = await new TeamupIcsSource({ icsUrl: url }).fetchEvents(
      at('2026-08-01T00:00'),
      at('2026-09-01T00:00'),
    );
    const weekly = events.filter((e) => e.title === 'Reading Group');
    // COUNT=6 from August 5, but only four Wednesdays fall inside the window.
    assert.equal(weekly.length, 4);
    for (const occurrence of weekly) {
      assert.equal(DateTime.fromJSDate(occurrence.start, { zone: TZ }).toFormat('ccc HH:mm'), 'Wed 19:00');
    }
    assert.equal(new Set(weekly.map((e) => e.id)).size, weekly.length);
  });

  it('flags all-day events', async () => {
    const events = await new TeamupIcsSource({ icsUrl: url }).fetchEvents(
      at('2026-08-01T00:00'),
      at('2026-09-01T00:00'),
    );
    assert.equal(events.find((e) => e.title === 'Chapter Retreat')?.allDay, true);
  });

  it('skips cancelled events', async () => {
    const events = await new TeamupIcsSource({ icsUrl: url }).fetchEvents(
      at('2026-08-01T00:00'),
      at('2026-09-01T00:00'),
    );
    assert.equal(
      events.find((e) => e.title === 'Called Off'),
      undefined,
    );
  });
});

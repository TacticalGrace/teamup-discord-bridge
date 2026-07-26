import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildIcsDocument,
  decodeLinkEvent,
  googleCalendarUrl,
  icsDownloadUrl,
  icsFilename,
  outlookWebUrl,
  toLinkEvent,
} from '../src/calendar-links.js';
import { TZ, at, makeConfig, makeEvent } from './helpers.js';

const config = makeConfig();

const meeting = makeEvent({
  id: 'x',
  title: 'Canvass; Ward 3, north side',
  start: at('2026-08-06T18:30'),
  end: at('2026-08-06T20:00'),
  location: 'Riverside Park, Springfield',
});

function signedParams(): { d: string; s: string } {
  const url = icsDownloadUrl(toLinkEvent(meeting), config);
  assert.ok(url, 'expected a signed .ics url');
  const parsed = new URL(url);
  return {
    d: parsed.searchParams.get('d') as string,
    s: parsed.searchParams.get('s') as string,
  };
}

describe('provider URLs', () => {
  it('builds a Google Calendar template URL with UTC times', () => {
    const url = googleCalendarUrl(toLinkEvent(meeting), TZ);
    assert.ok(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE'));
    // 18:30 CDT is 23:30 UTC; 20:00 CDT is 01:00 UTC the next day.
    assert.match(url, /dates=20260806T233000Z%2F20260807T010000Z/);
  });

  it('uses date-only values for all-day events', () => {
    const allDay = makeEvent({
      id: 'ad',
      start: at('2026-08-15T00:00'),
      end: at('2026-08-16T00:00'),
      allDay: true,
    });
    assert.match(googleCalendarUrl(toLinkEvent(allDay), TZ), /dates=20260815%2F20260816/);
  });

  it('builds an Outlook compose deeplink', () => {
    const url = outlookWebUrl(toLinkEvent(meeting), TZ);
    assert.ok(url.startsWith('https://outlook.live.com/calendar/0/deeplink/compose?'));
    assert.match(url, /rru=addevent/);
    assert.match(url, /subject=Canvass/);
  });

  it('omits the .ics link when no public base URL is configured', () => {
    assert.equal(icsDownloadUrl(toLinkEvent(meeting), makeConfig({ publicBaseUrl: null })), null);
  });
});

describe('link signing', () => {
  it('round-trips a valid payload', () => {
    const { d, s } = signedParams();
    const decoded = decodeLinkEvent(d, s, config.linkSecret);
    assert.ok(decoded);
    assert.equal(decoded.t, 'Canvass; Ward 3, north side');
    assert.equal(decoded.l, 'Riverside Park, Springfield');
    assert.equal(decoded.a, 0);
  });

  it('rejects an altered payload', () => {
    const { d, s } = signedParams();
    assert.equal(decodeLinkEvent(`${d}x`, s, config.linkSecret), null);
  });

  it('rejects a wrong secret', () => {
    const { d, s } = signedParams();
    assert.equal(decodeLinkEvent(d, s, 'not-the-secret'), null);
  });

  it('rejects an empty signature', () => {
    const { d } = signedParams();
    assert.equal(decodeLinkEvent(d, '', config.linkSecret), null);
  });

  it('rejects a payload missing required fields', () => {
    const bogus = Buffer.from(JSON.stringify({ t: 'no times' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // Signed correctly, but structurally invalid.
    const url = icsDownloadUrl(toLinkEvent(meeting), config) as string;
    const realSig = new URL(url).searchParams.get('s') as string;
    assert.equal(decodeLinkEvent(bogus, realSig, config.linkSecret), null);
  });
});

describe('buildIcsDocument', () => {
  const doc = buildIcsDocument(toLinkEvent(meeting), {
    timezone: TZ,
    uid: 'test@example',
    orgName: 'Test Org',
    now: at('2026-08-01T12:00'),
  });

  it('emits a single VEVENT in a VCALENDAR', () => {
    assert.ok(doc.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(doc.endsWith('END:VCALENDAR\r\n'));
    assert.equal(doc.match(/BEGIN:VEVENT/g)?.length, 1);
  });

  it('writes timed events as UTC stamps', () => {
    assert.match(doc, /DTSTART:20260806T233000Z/);
    assert.match(doc, /DTEND:20260807T010000Z/);
  });

  it('escapes semicolons and commas per RFC 5545', () => {
    assert.match(doc, /SUMMARY:Canvass\\; Ward 3\\, north side/);
  });

  it('keeps every line within the 75-octet limit', () => {
    const tooLong = doc.split('\r\n').filter((line) => Buffer.byteLength(line, 'utf8') > 75);
    assert.deepEqual(tooLong, []);
  });

  it('folds long values onto continuation lines', () => {
    const long = buildIcsDocument(
      toLinkEvent(
        makeEvent({
          id: 'long',
          title:
            'Joint General Membership Meeting and Political Education Session on Tenant Organizing',
          start: at('2026-08-06T18:30'),
        }),
      ),
      { timezone: TZ, uid: 'long@example', orgName: 'Test Org', now: at('2026-08-01T12:00') },
    );
    assert.ok(long.includes('\r\n '), 'expected a folded continuation line');
    const tooLong = long.split('\r\n').filter((line) => Buffer.byteLength(line, 'utf8') > 75);
    assert.deepEqual(tooLong, []);
  });

  it('does not split multi-byte characters across a fold', () => {
    const long = buildIcsDocument(
      toLinkEvent(
        makeEvent({
          id: 'emoji',
          title: `${'\u{1F339}'.repeat(40)} Rose Bread`,
          start: at('2026-08-06T18:30'),
        }),
      ),
      { timezone: TZ, uid: 'emoji@example', orgName: 'Test Org', now: at('2026-08-01T12:00') },
    );
    assert.ok(!long.includes('�'), 'found a replacement character, so a fold split a code point');
  });

  it('writes all-day events as DATE values', () => {
    const allDay = buildIcsDocument(
      toLinkEvent(
        makeEvent({
          id: 'ad',
          start: at('2026-08-15T00:00'),
          end: at('2026-08-16T00:00'),
          allDay: true,
        }),
      ),
      { timezone: TZ, uid: 'ad@example', orgName: 'Test Org', now: at('2026-08-01T12:00') },
    );
    assert.match(allDay, /DTSTART;VALUE=DATE:20260815/);
    assert.match(allDay, /DTEND;VALUE=DATE:20260816/);
  });
});

describe('icsFilename', () => {
  it('slugifies a title', () => {
    assert.equal(icsFilename('Canvass; Ward 3!'), 'canvass-ward-3.ics');
  });

  it('falls back when a title has no usable characters', () => {
    assert.equal(icsFilename('!!!'), 'event.ics');
  });
});

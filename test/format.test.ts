import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatDayHeading,
  formatDigestWhen,
  formatShortDay,
  formatTimeOnly,
  formatWhen,
  humanizeRemaining,
  oneLine,
  truncate,
} from '../src/format.js';
import { TZ, at, makeEvent } from './helpers.js';

describe('formatWhen', () => {
  it('renders a same-day event as a time range', () => {
    const event = makeEvent({ id: 'a', start: at('2026-08-06T18:30'), end: at('2026-08-06T20:00') });
    assert.equal(formatWhen(event, TZ), 'Thursday, August 6 · 6:30 PM–8:00 PM CDT');
  });

  it('renders a single-day all-day event without times', () => {
    const event = makeEvent({
      id: 'a',
      start: at('2026-08-15T00:00'),
      end: at('2026-08-16T00:00'),
      allDay: true,
    });
    assert.equal(formatWhen(event, TZ), 'Saturday, August 15 (all day)');
  });

  it('renders a multi-day all-day event as a date range', () => {
    const event = makeEvent({
      id: 'a',
      start: at('2026-08-15T00:00'),
      end: at('2026-08-18T00:00'),
      allDay: true,
    });
    assert.equal(formatWhen(event, TZ), 'Saturday, August 15 – Monday, August 17 (all day)');
  });

  it('spells out the end date when an event crosses midnight', () => {
    const event = makeEvent({ id: 'a', start: at('2026-08-06T22:00'), end: at('2026-08-07T01:00') });
    assert.match(formatWhen(event, TZ), /Thursday, August 6 10:00 PM – Friday, August 7 1:00 AM/);
  });
});

describe('humanizeRemaining', () => {
  const cases: Array<[string, string, string]> = [
    ['2026-08-06T18:30', '2026-08-06T18:30', 'starting now'],
    ['2026-08-06T18:00', '2026-08-06T18:40', 'in 40 minutes'],
    ['2026-08-06T18:00', '2026-08-06T18:01', 'starting now'],
    ['2026-08-06T18:00', '2026-08-06T19:00', 'in about 1 hour'],
    ['2026-08-06T18:00', '2026-08-06T20:00', 'in about 2 hours'],
    ['2026-08-05T18:00', '2026-08-06T18:00', 'in 1 day'],
    ['2026-08-01T18:00', '2026-08-06T18:00', 'in 5 days'],
    ['2026-07-01T18:00', '2026-08-06T18:00', 'in about 5 weeks'],
  ];

  for (const [from, until, expected] of cases) {
    it(`describes ${from} to ${until} as "${expected}"`, () => {
      assert.equal(humanizeRemaining(at(from), at(until)), expected);
    });
  }
});

describe('ordinal dates', () => {
  const cases: Array<[string, string]> = [
    ['2026-08-01T09:00', 'Saturday, the 1st'],
    ['2026-08-02T09:00', 'Sunday, the 2nd'],
    ['2026-08-03T09:00', 'Monday, the 3rd'],
    ['2026-08-04T09:00', 'Tuesday, the 4th'],
    ['2026-08-11T09:00', 'Tuesday, the 11th'],
    ['2026-08-12T09:00', 'Wednesday, the 12th'],
    ['2026-08-13T09:00', 'Thursday, the 13th'],
    ['2026-08-21T09:00', 'Friday, the 21st'],
    ['2026-08-22T09:00', 'Saturday, the 22nd'],
    ['2026-08-23T09:00', 'Sunday, the 23rd'],
    ['2026-08-31T09:00', 'Monday, the 31st'],
  ];

  for (const [iso, expected] of cases) {
    it(`renders ${iso.slice(0, 10)} as "${expected}"`, () => {
      assert.equal(formatDayHeading(at(iso), TZ), expected);
    });
  }

  it('abbreviates for tight layouts', () => {
    assert.equal(formatShortDay(at('2026-08-31T09:00'), TZ), 'Mon 31st');
  });
});

describe('formatTimeOnly', () => {
  it('omits the minutes on the hour', () => {
    assert.equal(formatTimeOnly(makeEvent({ id: 'a', start: at('2026-08-06T19:00') }), TZ), '7 PM');
  });

  it('includes the minutes otherwise', () => {
    assert.equal(
      formatTimeOnly(makeEvent({ id: 'a', start: at('2026-08-06T18:30') }), TZ),
      '6:30 PM',
    );
  });

  it('reports all-day events instead of a time', () => {
    const event = makeEvent({ id: 'a', start: at('2026-08-06T00:00'), allDay: true });
    assert.equal(formatTimeOnly(event, TZ), 'all day');
  });
});

describe('formatDigestWhen', () => {
  it('combines the day and the time', () => {
    const event = makeEvent({ id: 'a', start: at('2026-07-31T18:30') });
    assert.equal(formatDigestWhen(event, TZ), 'Friday, the 31st, 6:30 PM');
  });

  it('marks all-day events', () => {
    const event = makeEvent({ id: 'a', start: at('2026-07-31T00:00'), allDay: true });
    assert.equal(formatDigestWhen(event, TZ), 'Friday, the 31st (all day)');
  });
});

describe('oneLine', () => {
  it('collapses newlines and repeated spaces', () => {
    assert.equal(oneLine('Agenda in the drive.\n\nChildcare   provided.'), 'Agenda in the drive. Childcare provided.');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(oneLine('  padded  '), 'padded');
  });
});

describe('truncate', () => {
  it('leaves short strings alone', () => {
    assert.equal(truncate('short', 10), 'short');
  });

  it('never exceeds the limit', () => {
    const out = truncate('a'.repeat(50), 10);
    assert.ok(out.length <= 10, `got length ${out.length}`);
    assert.ok(out.endsWith('…'));
  });
});

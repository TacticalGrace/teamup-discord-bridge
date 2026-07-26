import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DigestLayout } from '../src/config.js';
import { digestEmbed, digestLine, reminderEmbed } from '../src/embeds.js';
import { at, embedText, makeConfig, makeEvent } from './helpers.js';

const LAYOUTS: DigestLayout[] = ['grouped', 'compact', 'cards', 'flat'];

const meeting = makeEvent({
  id: 'm',
  title: 'Meeting with blah blah',
  start: at('2026-07-31T18:30'),
  location: 'Union Hall',
  description: 'Agenda in the shared drive.\n\nChildcare provided.',
});

describe('digestLine', () => {
  const config = makeConfig();
  const line = digestLine(meeting, config);

  it('leads with the weekday and ordinal date', () => {
    assert.ok(line.startsWith('**Friday, the 31st, 6:30 PM**'), line);
  });

  it('links the title to its Teamup entry', () => {
    assert.ok(line.includes('[Meeting with blah blah](https://teamup.com/kstest/events/1)'), line);
  });

  it('appends the location and the notes on one line', () => {
    assert.ok(line.includes('Union Hall'), line);
    assert.ok(line.includes('Agenda in the shared drive. Childcare provided.'), line);
    assert.ok(!line.includes('\n'), 'expected a single line');
  });

  it('renders events without a URL as plain text', () => {
    const rendered = digestLine({ ...meeting, url: null }, config);
    assert.ok(rendered.includes('Meeting with blah blah'));
    // The title itself must not be wrapped; other links may still appear.
    assert.ok(!rendered.includes('[Meeting with blah blah]('), rendered);
  });

  it('leaves no dangling separator when there are no details', () => {
    const bare = { ...meeting, location: null, description: null };
    assert.ok(!digestLine(bare, config).trimEnd().endsWith('—'));
  });
});

describe('digestEmbed', () => {
  for (const layout of LAYOUTS) {
    describe(`${layout} layout`, () => {
      const config = makeConfig({ digestLayout: layout });

      it('links the event title', () => {
        const rendered = embedText(digestEmbed([meeting], config, 'July 27 – August 2'));
        assert.ok(
          rendered.includes('[Meeting with blah blah](https://teamup.com/kstest/events/1)'),
          rendered,
        );
      });

      it('stays inside the description limit', () => {
        const embed = digestEmbed([meeting], config, 'July 27 – August 2');
        assert.ok((embed.description?.length ?? 0) <= 4096);
      });

      it('stays inside the field limit', () => {
        const embed = digestEmbed([meeting], config, 'July 27 – August 2');
        for (const field of embed.fields ?? []) {
          assert.ok(field.value.length <= 1024, `field ${field.name} was ${field.value.length}`);
        }
      });

      it('reports what it could not fit', () => {
        const many = Array.from({ length: 40 }, (_, i) =>
          makeEvent({
            id: `bulk-${i}`,
            title: `Committee Meeting Number ${i}`,
            start: at('2026-08-05T17:00'),
            description: 'x'.repeat(400),
          }),
        );
        const embed = digestEmbed(many, config, 'August 3 – August 9');
        assert.ok((embed.description?.length ?? 0) <= 4096);
        assert.match(embedText(embed), /…and \d+ more/);
      });
    });
  }

  it('groups events under a single day heading', () => {
    const config = makeConfig({ digestLayout: 'grouped' });
    const sameDay = [
      makeEvent({ id: 'a', title: 'Canvass', start: at('2026-08-01T10:00') }),
      makeEvent({ id: 'b', title: 'Brake Light Clinic', start: at('2026-08-01T13:30') }),
    ];
    const body = digestEmbed(sameDay, config, 'July 27 – August 2').description ?? '';
    assert.equal(body.match(/Saturday, the 1st/g)?.length, 1, body);
    assert.ok(body.includes('Canvass') && body.includes('Brake Light Clinic'));
  });

  it('handles an empty week without listing anything', () => {
    const embed = digestEmbed([], makeConfig(), 'July 27 – August 2');
    assert.match(embed.description ?? '', /Nothing on the chapter calendar/);
    assert.deepEqual(embed.fields, []);
  });
});

describe('add-to-calendar links', () => {
  const CALENDAR_URL = /calendar\.google\.com|outlook\.live\.com|\/event\.ics/;

  it('appear on event posts when enabled', () => {
    const embed = reminderEmbed(meeting, makeConfig({ addToCalendarEnabled: true }));
    assert.match(embed.description ?? '', CALENDAR_URL);
  });

  it('disappear everywhere when disabled', () => {
    const off = makeConfig({ addToCalendarEnabled: false });
    const surfaces = [
      embedText(reminderEmbed(meeting, off)),
      ...LAYOUTS.map((layout) =>
        embedText(digestEmbed([meeting], makeConfig({ ...off, digestLayout: layout }), 'range')),
      ),
    ];
    for (const rendered of surfaces) {
      assert.doesNotMatch(rendered, CALENDAR_URL, rendered);
      assert.ok(rendered.includes('Meeting with blah blah'));
    }
  });

  it('fall back to provider links when nothing can host the .ics', () => {
    const noHost = makeConfig({ publicBaseUrl: null });
    const description = reminderEmbed(meeting, noHost).description ?? '';
    assert.ok(!description.includes('/event.ics'), description);
    assert.match(description, /calendar\.google\.com/);
  });
});

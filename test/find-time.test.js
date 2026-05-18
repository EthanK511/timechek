const test = require('node:test');
const assert = require('node:assert/strict');
const {
  localToUTC,
  formatInTimezone,
  computeOverlap,
  buildResultMessage,
  buildModal,
  buildAnnouncementMessage,
  COMMON_TIMEZONES,
} = require('../src/find-time');

// ---------------------------------------------------------------------------
// localToUTC
// ---------------------------------------------------------------------------

test('localToUTC converts Eastern time to UTC', () => {
  // America/New_York in May = EDT = UTC-4
  const utc = localToUTC('2026-05-18', '14:00', 'America/New_York');
  assert.equal(utc, '2026-05-18T18:00:00.000Z');
});

test('localToUTC converts Central time to UTC', () => {
  // America/Chicago in May = CDT = UTC-5
  const utc = localToUTC('2026-05-18', '14:00', 'America/Chicago');
  assert.equal(utc, '2026-05-18T19:00:00.000Z');
});

test('localToUTC converts Pacific time to UTC', () => {
  // America/Los_Angeles in May = PDT = UTC-7
  const utc = localToUTC('2026-05-18', '14:00', 'America/Los_Angeles');
  assert.equal(utc, '2026-05-18T21:00:00.000Z');
});

test('localToUTC handles UTC timezone (no offset)', () => {
  const utc = localToUTC('2026-05-18', '10:00', 'UTC');
  assert.equal(utc, '2026-05-18T10:00:00.000Z');
});

test('localToUTC throws on invalid date', () => {
  assert.throws(() => localToUTC('not-a-date', '10:00', 'UTC'), /Invalid/);
});

// ---------------------------------------------------------------------------
// formatInTimezone
// ---------------------------------------------------------------------------

test('formatInTimezone renders UTC time in Eastern timezone', () => {
  const formatted = formatInTimezone('2026-05-18T18:00:00.000Z', 'America/New_York');
  // 18:00 UTC = 14:00 EDT
  assert.match(formatted, /2:00 PM/);
  assert.match(formatted, /EDT/);
});

test('formatInTimezone renders UTC time in Pacific timezone', () => {
  const formatted = formatInTimezone('2026-05-18T21:00:00.000Z', 'America/Los_Angeles');
  // 21:00 UTC = 14:00 PDT
  assert.match(formatted, /2:00 PM/);
  assert.match(formatted, /PDT/);
});

// ---------------------------------------------------------------------------
// computeOverlap
// ---------------------------------------------------------------------------

test('computeOverlap returns empty array for no submissions', () => {
  assert.deepEqual(computeOverlap([]), []);
});

test('computeOverlap returns full range for a single submission', () => {
  const subs = [{ start_time_utc: '2026-05-18T14:00:00.000Z', end_time_utc: '2026-05-18T17:00:00.000Z' }];
  const result = computeOverlap(subs);
  assert.equal(result.length, 1);
  assert.equal(result[0].start, '2026-05-18T14:00:00.000Z');
  assert.equal(result[0].end, '2026-05-18T17:00:00.000Z');
});

test('computeOverlap finds overlap between two ranges', () => {
  // Alice: 14:00–17:00 UTC
  // Bob:   15:00–19:00 UTC
  // Overlap: 15:00–17:00 UTC
  const subs = [
    { start_time_utc: '2026-05-18T14:00:00.000Z', end_time_utc: '2026-05-18T17:00:00.000Z' },
    { start_time_utc: '2026-05-18T15:00:00.000Z', end_time_utc: '2026-05-18T19:00:00.000Z' },
  ];
  const result = computeOverlap(subs);
  assert.equal(result.length, 1);
  assert.equal(result[0].start, '2026-05-18T15:00:00.000Z');
  assert.equal(result[0].end, '2026-05-18T17:00:00.000Z');
});

test('computeOverlap finds overlap across three timezones', () => {
  // EST person available 14:00–18:00 EDT = 18:00–22:00 UTC
  // CST person available 13:00–17:00 CDT = 18:00–22:00 UTC
  // PST person available 11:00–16:00 PDT = 18:00–23:00 UTC
  // Overlap: 18:00–22:00 UTC
  const subs = [
    { start_time_utc: '2026-05-18T18:00:00.000Z', end_time_utc: '2026-05-18T22:00:00.000Z' },
    { start_time_utc: '2026-05-18T18:00:00.000Z', end_time_utc: '2026-05-18T22:00:00.000Z' },
    { start_time_utc: '2026-05-18T18:00:00.000Z', end_time_utc: '2026-05-18T23:00:00.000Z' },
  ];
  const result = computeOverlap(subs);
  assert.equal(result.length, 1);
  assert.equal(result[0].start, '2026-05-18T18:00:00.000Z');
  assert.equal(result[0].end, '2026-05-18T22:00:00.000Z');
});

test('computeOverlap returns empty array when no common window exists', () => {
  // Alice: 09:00–11:00 UTC, Bob: 13:00–15:00 UTC
  const subs = [
    { start_time_utc: '2026-05-18T09:00:00.000Z', end_time_utc: '2026-05-18T11:00:00.000Z' },
    { start_time_utc: '2026-05-18T13:00:00.000Z', end_time_utc: '2026-05-18T15:00:00.000Z' },
  ];
  assert.deepEqual(computeOverlap(subs), []);
});

test('computeOverlap returns empty array when ranges are adjacent but not overlapping', () => {
  const subs = [
    { start_time_utc: '2026-05-18T09:00:00.000Z', end_time_utc: '2026-05-18T11:00:00.000Z' },
    { start_time_utc: '2026-05-18T11:00:00.000Z', end_time_utc: '2026-05-18T13:00:00.000Z' },
  ];
  assert.deepEqual(computeOverlap(subs), []);
});

// ---------------------------------------------------------------------------
// buildResultMessage
// ---------------------------------------------------------------------------

test('buildResultMessage announces overlap in each user timezone', () => {
  const subs = [
    {
      user_id: 'U1',
      user_name: 'alice',
      timezone: 'America/New_York',
      timezone_label: 'Eastern Time (ET)',
      start_time_utc: '2026-05-18T18:00:00.000Z',
      end_time_utc: '2026-05-18T20:00:00.000Z',
    },
    {
      user_id: 'U2',
      user_name: 'bob',
      timezone: 'America/Chicago',
      timezone_label: 'Central Time (CT)',
      start_time_utc: '2026-05-18T18:00:00.000Z',
      end_time_utc: '2026-05-18T21:00:00.000Z',
    },
  ];
  const msg = buildResultMessage(subs, {});
  assert.match(msg, /Everyone is available/);
  // Alice should see EDT times, Bob should see CDT times
  assert.match(msg, /<@U1>/);
  assert.match(msg, /EDT/);
  assert.match(msg, /<@U2>/);
  assert.match(msg, /CDT/);
});

test('buildResultMessage reports no overlap', () => {
  const subs = [
    {
      user_id: 'U1',
      user_name: 'alice',
      timezone: 'America/New_York',
      timezone_label: 'Eastern Time (ET)',
      start_time_utc: '2026-05-18T13:00:00.000Z',
      end_time_utc: '2026-05-18T15:00:00.000Z',
    },
    {
      user_id: 'U2',
      user_name: 'bob',
      timezone: 'America/Los_Angeles',
      timezone_label: 'Pacific Time (PT)',
      start_time_utc: '2026-05-18T20:00:00.000Z',
      end_time_utc: '2026-05-18T22:00:00.000Z',
    },
  ];
  const msg = buildResultMessage(subs, {});
  assert.match(msg, /No common/);
});

test('buildResultMessage includes presence info', () => {
  const subs = [
    {
      user_id: 'U1',
      user_name: 'alice',
      timezone: 'UTC',
      timezone_label: 'UTC',
      start_time_utc: '2026-05-18T10:00:00.000Z',
      end_time_utc: '2026-05-18T12:00:00.000Z',
    },
  ];
  const msg = buildResultMessage(subs, { U1: 'active' });
  assert.match(msg, /Online now/);
});

test('buildResultMessage announces everyone online when all are active', () => {
  const subs = [
    {
      user_id: 'U1',
      user_name: 'alice',
      timezone: 'UTC',
      timezone_label: 'UTC',
      start_time_utc: '2026-05-18T10:00:00.000Z',
      end_time_utc: '2026-05-18T12:00:00.000Z',
    },
    {
      user_id: 'U2',
      user_name: 'bob',
      timezone: 'UTC',
      timezone_label: 'UTC',
      start_time_utc: '2026-05-18T10:00:00.000Z',
      end_time_utc: '2026-05-18T13:00:00.000Z',
    },
  ];
  const msg = buildResultMessage(subs, { U1: 'active', U2: 'active' });
  assert.match(msg, /Everyone is online right now/);
});

// ---------------------------------------------------------------------------
// buildModal
// ---------------------------------------------------------------------------

test('buildModal returns a valid Slack view object', () => {
  const view = buildModal(42, 'C123');
  assert.equal(view.type, 'modal');
  assert.equal(view.callback_id, 'find_time_submit');
  const meta = JSON.parse(view.private_metadata);
  assert.equal(meta.session_id, 42);
  assert.equal(meta.channel_id, 'C123');
  // Must have blocks for timezone, date, start time, end time
  const blockIds = view.blocks.map((b) => b.block_id).filter(Boolean);
  assert.ok(blockIds.includes('tz'));
  assert.ok(blockIds.includes('avail_date'));
  assert.ok(blockIds.includes('start_time'));
  assert.ok(blockIds.includes('end_time'));
  // Timezone dropdown should list all common timezones
  const tzBlock = view.blocks.find((b) => b.block_id === 'tz');
  assert.equal(tzBlock.element.options.length, COMMON_TIMEZONES.length);
});

// ---------------------------------------------------------------------------
// buildAnnouncementMessage
// ---------------------------------------------------------------------------

test('buildAnnouncementMessage includes a button with the session id as value', () => {
  const msg = buildAnnouncementMessage(7, 'alice');
  const button = msg.blocks
    .flatMap((b) => b.elements || [])
    .find((el) => el.action_id === 'open_find_time_modal');
  assert.ok(button, 'Button not found in announcement blocks');
  assert.equal(button.value, '7');
});

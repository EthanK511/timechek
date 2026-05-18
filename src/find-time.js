const { DateTime } = require('luxon');

/** Timezone options shown in the modal dropdown. */
const COMMON_TIMEZONES = [
  { label: 'Eastern Time (ET)',          value: 'America/New_York' },
  { label: 'Central Time (CT)',           value: 'America/Chicago' },
  { label: 'Mountain Time (MT)',          value: 'America/Denver' },
  { label: 'Pacific Time (PT)',           value: 'America/Los_Angeles' },
  { label: 'Alaska Time (AKT)',           value: 'America/Anchorage' },
  { label: 'Hawaii Time (HT)',            value: 'Pacific/Honolulu' },
  { label: 'UTC',                         value: 'UTC' },
  { label: 'British Time (GMT/BST)',      value: 'Europe/London' },
  { label: 'Central European (CET/CEST)', value: 'Europe/Paris' },
  { label: 'India Standard (IST)',        value: 'Asia/Kolkata' },
  { label: 'Japan Standard (JST)',        value: 'Asia/Tokyo' },
  { label: 'Australia Eastern (AET)',     value: 'Australia/Sydney' },
];

/**
 * Convert a local date + time string in a given IANA timezone to a UTC ISO string.
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @param {string} timeStr  - "HH:MM"
 * @param {string} timezone - IANA timezone id, e.g. "America/New_York"
 * @returns {string} UTC ISO string
 */
function localToUTC(dateStr, timeStr, timezone) {
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}`, { zone: timezone });
  if (!dt.isValid) {
    throw new Error(`Invalid date/time "${dateStr} ${timeStr}" in timezone "${timezone}": ${dt.invalidReason}`);
  }
  return dt.toUTC().toISO();
}

/**
 * Format a UTC ISO string in a given IANA timezone for human display.
 * Returns e.g. "May 18, 2026, 2:00 PM EDT"
 * @param {string} utcISO   - UTC ISO string
 * @param {string} timezone - IANA timezone id
 * @returns {string}
 */
function formatInTimezone(utcISO, timezone) {
  const dt = DateTime.fromISO(utcISO, { zone: 'UTC' }).setZone(timezone);
  return dt.toFormat("MMM d, yyyy, h:mm a ZZZZ");
}

/**
 * Compute the intersection of all submitted availability ranges.
 * Each submission must have `start_time_utc` and `end_time_utc`.
 * Returns an array with one overlap object {start, end} if there is overlap,
 * or an empty array if there is none.
 * @param {Array<{start_time_utc: string, end_time_utc: string}>} submissions
 * @returns {Array<{start: string, end: string}>}
 */
function computeOverlap(submissions) {
  if (!submissions.length) return [];

  const overlapStart = Math.max(...submissions.map((s) => new Date(s.start_time_utc).getTime()));
  const overlapEnd = Math.min(...submissions.map((s) => new Date(s.end_time_utc).getTime()));

  if (overlapStart >= overlapEnd) return [];

  return [
    {
      start: new Date(overlapStart).toISOString(),
      end: new Date(overlapEnd).toISOString(),
    },
  ];
}

/**
 * Build the Slack modal view JSON for the find-time submission form.
 * @param {number|string} sessionId
 * @param {string} channelId
 * @returns {object} Slack modal view object
 */
function buildModal(sessionId, channelId) {
  return {
    type: 'modal',
    callback_id: 'find_time_submit',
    private_metadata: JSON.stringify({ session_id: sessionId, channel_id: channelId }),
    title: { type: 'plain_text', text: 'Find a Time', emoji: true },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Select the date and time range when you are available, in your timezone.',
        },
      },
      {
        type: 'input',
        block_id: 'tz',
        label: { type: 'plain_text', text: 'Your Timezone' },
        element: {
          type: 'static_select',
          action_id: 'tz_select',
          placeholder: { type: 'plain_text', text: 'Select your timezone' },
          options: COMMON_TIMEZONES.map((tz) => ({
            text: { type: 'plain_text', text: tz.label },
            value: tz.value,
          })),
        },
      },
      {
        type: 'input',
        block_id: 'avail_date',
        label: { type: 'plain_text', text: 'Date' },
        element: {
          type: 'datepicker',
          action_id: 'date_pick',
          placeholder: { type: 'plain_text', text: 'Select a date' },
        },
      },
      {
        type: 'input',
        block_id: 'start_time',
        label: { type: 'plain_text', text: 'Available From' },
        element: {
          type: 'timepicker',
          action_id: 'start_pick',
          placeholder: { type: 'plain_text', text: 'Start time' },
        },
      },
      {
        type: 'input',
        block_id: 'end_time',
        label: { type: 'plain_text', text: 'Available Until' },
        element: {
          type: 'timepicker',
          action_id: 'end_pick',
          placeholder: { type: 'plain_text', text: 'End time' },
        },
      },
    ],
  };
}

/**
 * Build the Slack channel announcement message sent when /find-time is invoked.
 * Includes an interactive button so other users can open the modal.
 * @param {number|string} sessionId
 * @param {string} invokerName - display name of the person who ran /find-time
 * @returns {{ text: string, blocks: Array }}
 */
function buildAnnouncementMessage(sessionId, invokerName) {
  return {
    text: `📅 ${invokerName} started a find-time poll! Click the button to submit your availability.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📅 *Find-a-Time poll started by ${invokerName}!*\n<!channel> Please submit the times you are available.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📅 Submit My Availability', emoji: true },
            style: 'primary',
            action_id: 'open_find_time_modal',
            value: String(sessionId),
          },
        ],
      },
    ],
  };
}

/**
 * Build the final results message posted to the channel after /find-time-end.
 * Each submitter's times are shown in their own timezone.
 *
 * @param {Array<{user_id, user_name, timezone, timezone_label, start_time_utc, end_time_utc}>} submissions
 * @param {Object<string, string>} presenceMap  - { userId: 'active'|'away' }
 * @returns {string} Slack mrkdwn text
 */
function buildResultMessage(submissions, presenceMap = {}) {
  const submitters = submissions.map((s) => `<@${s.user_id}>`).join(', ');
  const lines = [`:calendar: *Find-a-Time Results*`, `_Responses from: ${submitters}_`, ''];

  const overlap = computeOverlap(submissions);

  if (overlap.length) {
    lines.push(':tada: *Everyone is available during this window:*');
    for (const s of submissions) {
      const tzLabel = s.timezone_label || s.timezone;
      const start = formatInTimezone(overlap[0].start, s.timezone);
      const end = formatInTimezone(overlap[0].end, s.timezone);
      lines.push(`• <@${s.user_id}> *(${tzLabel})*: ${start} – ${end}`);
    }
  } else {
    lines.push(':x: *No common availability found across all responses.*');
    lines.push('_Individual availability windows:_');
    for (const s of submissions) {
      const tzLabel = s.timezone_label || s.timezone;
      const start = formatInTimezone(s.start_time_utc, s.timezone);
      const end = formatInTimezone(s.end_time_utc, s.timezone);
      lines.push(`• <@${s.user_id}> *(${tzLabel})*: ${start} – ${end}`);
    }
  }

  // Online presence section
  if (Object.keys(presenceMap).length) {
    lines.push('');
    lines.push('*Current Slack presence:*');
    const online = submissions.filter((s) => presenceMap[s.user_id] === 'active');
    const away = submissions.filter((s) => presenceMap[s.user_id] !== 'active');
    if (online.length) {
      lines.push(`:large_green_circle: Online now: ${online.map((s) => `<@${s.user_id}>`).join(', ')}`);
    }
    if (away.length) {
      lines.push(`:white_circle: Away: ${away.map((s) => `<@${s.user_id}>`).join(', ')}`);
    }
    if (online.length === submissions.length && submissions.length > 0) {
      lines.push(':sparkles: *Everyone is online right now!*');
    }
  }

  return lines.join('\n');
}

module.exports = {
  COMMON_TIMEZONES,
  localToUTC,
  formatInTimezone,
  computeOverlap,
  buildModal,
  buildAnnouncementMessage,
  buildResultMessage,
};

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { sendSlackMessage: defaultSlackSender, openModal, postMessage, getChannelMembers, getUserPresence } = require('./slack');
const { verifySlackRequest } = require('./slack-verify');
const { buildModal, buildAnnouncementMessage, buildResultMessage, localToUTC, COMMON_TIMEZONES } = require('./find-time');

function parseISODate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatWindow(window) {
  return `${window.start_time} → ${window.end_time} (${window.vote_count} vote${window.vote_count === 1 ? '' : 's'})`;
}

async function buildSchedule(db, huddleId) {
  return db.all(
    `
      SELECT
        w.id,
        w.start_time,
        w.end_time,
        w.proposer_name,
        COUNT(v.id) AS vote_count,
        GROUP_CONCAT(v.voter_name, ', ') AS voters
      FROM availability_windows w
      LEFT JOIN votes v ON v.window_id = w.id
      WHERE w.huddle_id = ?
      GROUP BY w.id
      ORDER BY vote_count DESC, w.start_time ASC
    `,
    [huddleId]
  );
}

function createApp({
  db,
  sendSlackMessage = defaultSlackSender,
  defaultSlackWebhookUrl = process.env.SLACK_WEBHOOK_URL,
  slackBotToken = process.env.SLACK_BOT_TOKEN,
  slackSigningSecret = process.env.SLACK_SIGNING_SECRET,
  slackApiCalls = { openModal, postMessage, getChannelMembers, getUserPresence },
} = {}) {
  const app = express();

  // Capture raw body for Slack request signature verification on /slack/* routes.
  // express.raw() must be registered before express.json() so that the body stream
  // is not consumed twice.
  app.use('/slack/', express.raw({ type: '*/*' }));

  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/huddles', async (_req, res, next) => {
    try {
      const rows = await db.all(
        `
          SELECT
            h.id,
            h.title,
            h.description,
            h.created_at,
            COUNT(w.id) AS window_count
          FROM huddles h
          LEFT JOIN availability_windows w ON w.huddle_id = h.id
          GROUP BY h.id
          ORDER BY h.created_at DESC
        `
      );
      res.json({ huddles: rows });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/huddles', async (req, res, next) => {
    try {
      const title = String(req.body?.title || '').trim();
      const description = String(req.body?.description || '').trim();

      if (!title) {
        return res.status(400).json({ error: 'Title is required.' });
      }

      const result = await db.run(
        'INSERT INTO huddles (title, description, created_at) VALUES (?, ?, ?)',
        [title, description, new Date().toISOString()]
      );

      const huddle = await db.get('SELECT * FROM huddles WHERE id = ?', [result.id]);
      return res.status(201).json({ huddle });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/huddles/:id', async (req, res, next) => {
    try {
      const huddleId = Number(req.params.id);
      const huddle = await db.get('SELECT * FROM huddles WHERE id = ?', [huddleId]);
      if (!huddle) {
        return res.status(404).json({ error: 'Huddle not found.' });
      }

      const schedule = await buildSchedule(db, huddleId);
      const windows = schedule.map((row) => ({
        ...row,
        vote_count: Number(row.vote_count),
        voters: row.voters ? row.voters.split(', ').filter(Boolean) : [],
      }));

      const topVoteCount = windows.length ? windows[0].vote_count : 0;
      const topWindows = windows.filter((w) => w.vote_count === topVoteCount && topVoteCount > 0);

      return res.json({ huddle, windows, topWindows });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/huddles/:id/windows', async (req, res, next) => {
    try {
      const huddleId = Number(req.params.id);
      const huddle = await db.get('SELECT * FROM huddles WHERE id = ?', [huddleId]);
      if (!huddle) {
        return res.status(404).json({ error: 'Huddle not found.' });
      }

      const proposerName = String(req.body?.proposerName || '').trim();
      const startTime = String(req.body?.startTime || '').trim();
      const endTime = String(req.body?.endTime || '').trim();
      const startDate = parseISODate(startTime);
      const endDate = parseISODate(endTime);

      if (!proposerName || !startDate || !endDate) {
        return res.status(400).json({ error: 'Proposer name, start time, and end time are required.' });
      }

      if (startDate >= endDate) {
        return res.status(400).json({ error: 'End time must be after start time.' });
      }

      const result = await db.run(
        `
          INSERT INTO availability_windows (huddle_id, start_time, end_time, proposer_name, created_at)
          VALUES (?, ?, ?, ?, ?)
        `,
        [huddleId, startDate.toISOString(), endDate.toISOString(), proposerName, new Date().toISOString()]
      );

      const window = await db.get('SELECT * FROM availability_windows WHERE id = ?', [result.id]);
      return res.status(201).json({ window });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/windows/:id/votes', async (req, res, next) => {
    try {
      const windowId = Number(req.params.id);
      const voterName = String(req.body?.voterName || '').trim();

      if (!voterName) {
        return res.status(400).json({ error: 'Voter name is required.' });
      }

      const window = await db.get(
        `
          SELECT w.*, h.id AS huddle_id
          FROM availability_windows w
          JOIN huddles h ON h.id = w.huddle_id
          WHERE w.id = ?
        `,
        [windowId]
      );

      if (!window) {
        return res.status(404).json({ error: 'Availability window not found.' });
      }

      const existing = await db.get('SELECT id FROM votes WHERE window_id = ? AND voter_name = ?', [windowId, voterName]);
      let voted;

      if (existing) {
        await db.run('DELETE FROM votes WHERE id = ?', [existing.id]);
        voted = false;
      } else {
        await db.run('INSERT INTO votes (window_id, voter_name, created_at) VALUES (?, ?, ?)', [
          windowId,
          voterName,
          new Date().toISOString(),
        ]);
        voted = true;
      }

      const updated = await buildSchedule(db, window.huddle_id);
      return res.json({ voted, schedule: updated });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/huddles/:id/schedule', async (req, res, next) => {
    try {
      const huddleId = Number(req.params.id);
      const huddle = await db.get('SELECT * FROM huddles WHERE id = ?', [huddleId]);
      if (!huddle) {
        return res.status(404).json({ error: 'Huddle not found.' });
      }

      const schedule = await buildSchedule(db, huddleId);
      return res.json({ schedule });
    } catch (error) {
      return next(error);
    }
  });

  async function postToSlack(huddleId, mode) {
    const huddle = await db.get('SELECT * FROM huddles WHERE id = ?', [huddleId]);
    if (!huddle) {
      const error = new Error('Huddle not found.');
      error.statusCode = 404;
      throw error;
    }

    const schedule = await buildSchedule(db, huddleId);
    const webhookUrl = String(defaultSlackWebhookUrl || '').trim();

    if (!webhookUrl) {
      const error = new Error('Slack webhook URL is not configured.');
      error.statusCode = 400;
      throw error;
    }

    let text;
    if (mode === 'results') {
      const maxVotes = schedule[0]?.vote_count ?? 0;
      const winners = schedule.filter((w) => Number(w.vote_count) === Number(maxVotes));
      if (!winners.length || Number(maxVotes) === 0) {
        text = `:calendar: *${huddle.title}* has no votes yet. Please vote on preferred huddle times.`;
      } else {
        text = [
          `:tada: *${huddle.title}* top huddle time${winners.length > 1 ? 's' : ''}:`,
          ...winners.map((w) => `• ${formatWindow({ ...w, vote_count: Number(w.vote_count) })}`),
        ].join('\n');
      }
    } else {
      const topThree = schedule.slice(0, 3);
      text = [
        `:bell: Reminder to vote for *${huddle.title}* huddle times.`,
        topThree.length
          ? `Current leading options:\n${topThree
              .map((w) => `• ${formatWindow({ ...w, vote_count: Number(w.vote_count) })}`)
              .join('\n')}`
          : 'No availability windows have been proposed yet.',
      ].join('\n');
    }

    await sendSlackMessage(webhookUrl, text);
    return { huddle, text };
  }

  app.post('/api/huddles/:id/slack/results', async (req, res, next) => {
    try {
      const payload = await postToSlack(Number(req.params.id), 'results');
      return res.json({ ok: true, message: 'Results posted to Slack.', payload });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/huddles/:id/slack/reminder', async (req, res, next) => {
    try {
      const payload = await postToSlack(Number(req.params.id), 'reminder');
      return res.json({ ok: true, message: 'Reminder posted to Slack.', payload });
    } catch (error) {
      return next(error);
    }
  });

  // ---------------------------------------------------------------------------
  // Slack App endpoints — /find-time and /find-time-end slash commands + modal
  // ---------------------------------------------------------------------------

  /**
   * Middleware to verify every /slack/* request is genuinely from Slack.
   * Rejects requests with an invalid or replayed signature.
   */
  function requireSlackSignature(req, res, next) {
    if (!slackSigningSecret) {
      // Skip verification when no secret is configured (e.g. in unit tests)
      return next();
    }
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!verifySlackRequest(slackSigningSecret, rawBody, timestamp, signature)) {
      return res.status(401).json({ error: 'Invalid Slack signature.' });
    }
    return next();
  }

  /**
   * Close an open find-time session, compute overlap, fetch presences, and post
   * the results message to the channel.
   */
  async function closeSession(session) {
    const now = new Date().toISOString();
    await db.run(
      `UPDATE find_time_sessions SET status = 'closed', closed_at = ? WHERE id = ?`,
      [now, session.id]
    );

    const submissions = await db.all(
      'SELECT * FROM find_time_submissions WHERE session_id = ?',
      [session.id]
    );

    let presenceMap = {};
    if (slackBotToken && submissions.length) {
      await Promise.all(
        submissions.map(async (s) => {
          try {
            presenceMap[s.user_id] = await slackApiCalls.getUserPresence(slackBotToken, s.user_id);
          } catch {
            presenceMap[s.user_id] = 'unknown';
          }
        })
      );
    }

    const text = buildResultMessage(submissions, presenceMap);

    if (slackBotToken) {
      await slackApiCalls.postMessage(slackBotToken, session.channel_id, text);
    }

    return { text, submissions };
  }

  // Simple in-memory rate limiter for Slack-facing endpoints.
  // Limits each remote IP to at most 60 requests per 60-second window.
  const slackRateLimit = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests.' },
  });

  /**
   * POST /slack/commands
   * Handles the /find-time and /find-time-end slash commands.
   */
  app.post('/slack/commands', slackRateLimit, requireSlackSignature, async (req, res, next) => {
    try {
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
      const params = Object.fromEntries(new URLSearchParams(rawBody));

      const { command, channel_id: channelId, user_id: userId, user_name: userName, trigger_id: triggerId } = params;

      if (command === '/find-time') {
        // Check for existing open session in this channel
        const existing = await db.get(
          `SELECT * FROM find_time_sessions WHERE channel_id = ? AND status = 'open'`,
          [channelId]
        );
        if (existing) {
          return res.json({
            response_type: 'ephemeral',
            text: 'A find-time poll is already open in this channel. Use `/find-time-end` to close it and see results.',
          });
        }

        // Fetch channel members to track expected participant count
        let expectedCount = 0;
        if (slackBotToken) {
          try {
            const members = await slackApiCalls.getChannelMembers(slackBotToken, channelId);
            // Bots typically have IDs starting with 'B'; filter them out heuristically.
            // A more accurate approach is users.info but that would require N API calls.
            expectedCount = members.filter((id) => !id.startsWith('B')).length;
          } catch {
            // Not a fatal error — we just won't auto-close on full submission
            expectedCount = 0;
          }
        }

        const result = await db.run(
          `INSERT INTO find_time_sessions (channel_id, creator_id, creator_name, status, expected_count, created_at)
           VALUES (?, ?, ?, 'open', ?, ?)`,
          [channelId, userId, userName, expectedCount, new Date().toISOString()]
        );
        const sessionId = result.id;

        // Open the modal for the person who ran /find-time
        if (slackBotToken && triggerId) {
          try {
            await slackApiCalls.openModal(slackBotToken, triggerId, buildModal(sessionId, channelId));
          } catch {
            // Non-fatal; modal open can fail if trigger_id expired
          }
        }

        // Post an announcement to the channel with a button for everyone else
        if (slackBotToken) {
          try {
            const { text, blocks } = buildAnnouncementMessage(sessionId, userName);
            await slackApiCalls.postMessage(slackBotToken, channelId, text, blocks);
          } catch {
            // Non-fatal
          }
        }

        return res.json({
          response_type: 'ephemeral',
          text: 'Find-time poll started! A message has been posted to the channel.',
        });
      }

      if (command === '/find-time-end') {
        const session = await db.get(
          `SELECT * FROM find_time_sessions WHERE channel_id = ? AND status = 'open'`,
          [channelId]
        );
        if (!session) {
          return res.json({
            response_type: 'ephemeral',
            text: 'There is no active find-time poll in this channel.',
          });
        }

        const submissions = await db.all(
          'SELECT * FROM find_time_submissions WHERE session_id = ?',
          [session.id]
        );
        if (!submissions.length) {
          return res.json({
            response_type: 'ephemeral',
            text: 'No one has submitted availability yet. The poll is still open.',
          });
        }

        await closeSession(session);

        return res.json({
          response_type: 'ephemeral',
          text: 'Find-time poll closed! Results have been posted to the channel.',
        });
      }

      return res.status(400).json({ error: `Unknown command: ${command}` });
    } catch (error) {
      return next(error);
    }
  });

  /**
   * POST /slack/interactive
   * Handles interactive component payloads:
   *   - block_actions: button click → open the find-time modal
   *   - view_submission: modal submitted → save availability
   */
  app.post('/slack/interactive', slackRateLimit, requireSlackSignature, async (req, res, next) => {
    try {
      const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : '';
      const payloadStr = new URLSearchParams(rawBody).get('payload');
      if (!payloadStr) {
        return res.status(400).json({ error: 'Missing payload.' });
      }
      const payload = JSON.parse(payloadStr);

      const { type, user, trigger_id: triggerId } = payload;

      // -----------------------------------------------------------------------
      // Button click → open the modal
      // -----------------------------------------------------------------------
      if (type === 'block_actions') {
        const action = payload.actions?.[0];
        if (action?.action_id === 'open_find_time_modal') {
          const sessionId = Number(action.value);
          const session = await db.get(
            `SELECT * FROM find_time_sessions WHERE id = ? AND status = 'open'`,
            [sessionId]
          );
          if (!session) {
            return res.json({
              response_action: 'errors',
              errors: { tz: 'This find-time poll has already been closed.' },
            });
          }

          if (slackBotToken && triggerId) {
            await slackApiCalls.openModal(slackBotToken, triggerId, buildModal(sessionId, session.channel_id));
          }
        }
        return res.send('');
      }

      // -----------------------------------------------------------------------
      // Modal submission → save availability
      // -----------------------------------------------------------------------
      if (type === 'view_submission' && payload.view?.callback_id === 'find_time_submit') {
        let meta;
        try {
          meta = JSON.parse(payload.view.private_metadata || '{}');
        } catch {
          meta = {};
        }
        const { session_id: sessionId, channel_id: channelId } = meta;

        const session = await db.get(
          `SELECT * FROM find_time_sessions WHERE id = ? AND status = 'open'`,
          [sessionId]
        );
        if (!session) {
          return res.json({
            response_action: 'errors',
            errors: { tz: 'This find-time poll has already been closed.' },
          });
        }

        const values = payload.view.state?.values || {};
        const timezone = values?.tz?.tz_select?.selected_option?.value;
        const dateStr = values?.avail_date?.date_pick?.selected_date;
        const startStr = values?.start_time?.start_pick?.selected_time;
        const endStr = values?.end_time?.end_pick?.selected_time;

        if (!timezone || !dateStr || !startStr || !endStr) {
          return res.json({
            response_action: 'errors',
            errors: { tz: 'Please fill in all fields.' },
          });
        }

        const tzEntry = COMMON_TIMEZONES.find((t) => t.value === timezone);
        if (!tzEntry) {
          return res.json({
            response_action: 'errors',
            errors: { tz: 'Unknown timezone selected.' },
          });
        }

        let startUtc, endUtc;
        try {
          startUtc = localToUTC(dateStr, startStr, timezone);
          endUtc = localToUTC(dateStr, endStr, timezone);
        } catch (err) {
          return res.json({
            response_action: 'errors',
            errors: { start_time: err.message },
          });
        }

        if (new Date(startUtc) >= new Date(endUtc)) {
          return res.json({
            response_action: 'errors',
            errors: { end_time: 'End time must be after start time.' },
          });
        }

        const userId = user?.id;
        const userName = user?.name || user?.username || userId;

        // Upsert: allow re-submission (UPDATE on conflict)
        await db.run(
          `INSERT INTO find_time_submissions
             (session_id, user_id, user_name, timezone, timezone_label, start_time_utc, end_time_utc, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, user_id) DO UPDATE SET
             timezone = excluded.timezone,
             timezone_label = excluded.timezone_label,
             start_time_utc = excluded.start_time_utc,
             end_time_utc = excluded.end_time_utc,
             created_at = excluded.created_at`,
          [sessionId, userId, userName, timezone, tzEntry.label, startUtc, endUtc, new Date().toISOString()]
        );

        // Auto-close when all expected participants have submitted
        if (session.expected_count > 0) {
          const count = await db.get(
            'SELECT COUNT(*) AS cnt FROM find_time_submissions WHERE session_id = ?',
            [sessionId]
          );
          if (count.cnt >= session.expected_count) {
            await closeSession(session);
          }
        }

        // Acknowledge the modal submission (close the modal)
        return res.json({ response_action: 'clear' });
      }

      return res.send('');
    } catch (error) {
      return next(error);
    }
  });

  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Internal server error.' });
  });

  return app;
}

module.exports = { createApp };

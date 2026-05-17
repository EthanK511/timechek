const express = require('express');
const path = require('path');
const { sendSlackMessage: defaultSlackSender } = require('./slack');

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

function createApp({ db, sendSlackMessage = defaultSlackSender, defaultSlackWebhookUrl = process.env.SLACK_WEBHOOK_URL } = {}) {
  const app = express();
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

  async function postToSlack(huddleId, webhookOverride, mode) {
    const huddle = await db.get('SELECT * FROM huddles WHERE id = ?', [huddleId]);
    if (!huddle) {
      const error = new Error('Huddle not found.');
      error.statusCode = 404;
      throw error;
    }

    const schedule = await buildSchedule(db, huddleId);
    const webhookUrl = String(webhookOverride || defaultSlackWebhookUrl || '').trim();

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
      const payload = await postToSlack(Number(req.params.id), req.body?.webhookUrl, 'results');
      return res.json({ ok: true, message: 'Results posted to Slack.', payload });
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/huddles/:id/slack/reminder', async (req, res, next) => {
    try {
      const payload = await postToSlack(Number(req.params.id), req.body?.webhookUrl, 'reminder');
      return res.json({ ok: true, message: 'Reminder posted to Slack.', payload });
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

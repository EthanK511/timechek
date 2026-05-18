const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const TEST_SIGNING_SECRET = 'test_signing_secret_abc123';

function makeSlackHeaders(body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = `v0=${crypto.createHmac('sha256', TEST_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': sig,
  };
}

async function setup() {
  const db = createDatabase(':memory:');
  await db.init();

  const slackCalls = [];
  const app = createApp({
    db,
    defaultSlackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/XYZ',
    sendSlackMessage: async (webhookUrl, text) => {
      slackCalls.push({ webhookUrl, text });
    },
  });

  return { db, app, slackCalls };
}

/** Set up an app with Slack App mode (bot token + signing secret) for /slack/* tests. */
async function setupSlackApp() {
  const db = createDatabase(':memory:');
  await db.init();

  const apiCalls = { openModal: [], postMessage: [], getChannelMembers: [], getUserPresence: {} };

  const app = createApp({
    db,
    slackBotToken: 'xoxb-test',
    slackSigningSecret: TEST_SIGNING_SECRET,
    slackApiCalls: {
      openModal: async (token, triggerId, view) => {
        apiCalls.openModal.push({ triggerId, view });
      },
      postMessage: async (token, channel, text, blocks) => {
        apiCalls.postMessage.push({ channel, text, blocks });
      },
      getChannelMembers: async (token, channelId) => {
        return apiCalls.getChannelMembers[channelId] || ['U_ALICE', 'U_BOB'];
      },
      getUserPresence: async (token, userId) => {
        return apiCalls.getUserPresence[userId] || 'active';
      },
    },
  });

  return { db, app, apiCalls };
}

test('creates huddle, windows, votes and schedule ordering', async () => {
  const { db, app } = await setup();

  const huddleRes = await request(app).post('/api/huddles').send({ title: 'Team huddle', description: 'Sprint sync' });
  assert.equal(huddleRes.status, 201);
  const huddleId = huddleRes.body.huddle.id;

  const firstWindow = await request(app)
    .post(`/api/huddles/${huddleId}/windows`)
    .send({ proposerName: 'Alex', startTime: '2026-05-18T10:00', endTime: '2026-05-18T10:30' });
  assert.equal(firstWindow.status, 201);

  const secondWindow = await request(app)
    .post(`/api/huddles/${huddleId}/windows`)
    .send({ proposerName: 'Sam', startTime: '2026-05-18T11:00', endTime: '2026-05-18T11:30' });
  assert.equal(secondWindow.status, 201);

  const firstWindowId = firstWindow.body.window.id;
  const secondWindowId = secondWindow.body.window.id;

  assert.equal((await request(app).post(`/api/windows/${firstWindowId}/votes`).send({ voterName: 'Alex' })).status, 200);
  assert.equal((await request(app).post(`/api/windows/${firstWindowId}/votes`).send({ voterName: 'Sam' })).status, 200);
  assert.equal((await request(app).post(`/api/windows/${secondWindowId}/votes`).send({ voterName: 'Riley' })).status, 200);

  const details = await request(app).get(`/api/huddles/${huddleId}`);
  assert.equal(details.status, 200);
  assert.equal(details.body.windows[0].id, firstWindowId);
  assert.equal(details.body.windows[0].vote_count, 2);

  await db.close();
});

test('toggles vote and posts result to slack', async () => {
  const { db, app, slackCalls } = await setup();

  const huddle = await request(app).post('/api/huddles').send({ title: 'Design huddle' });
  const huddleId = huddle.body.huddle.id;

  const window = await request(app)
    .post(`/api/huddles/${huddleId}/windows`)
    .send({ proposerName: 'Casey', startTime: '2026-05-18T09:00', endTime: '2026-05-18T09:30' });
  const windowId = window.body.window.id;

  const addVote = await request(app).post(`/api/windows/${windowId}/votes`).send({ voterName: 'Casey' });
  assert.equal(addVote.body.voted, true);

  const removeVote = await request(app).post(`/api/windows/${windowId}/votes`).send({ voterName: 'Casey' });
  assert.equal(removeVote.body.voted, false);

  const slack = await request(app)
    .post(`/api/huddles/${huddleId}/slack/results`)
    .send({});

  assert.equal(slack.status, 200);
  assert.equal(slackCalls.length, 1);
  assert.match(slackCalls[0].text, /no votes yet/i);

  await db.close();
});

// ---------------------------------------------------------------------------
// /slack/commands — /find-time
// ---------------------------------------------------------------------------

test('/find-time creates a session and returns ephemeral ack', async () => {
  const { db, app, apiCalls } = await setupSlackApp();

  const body = 'command=%2Ffind-time&channel_id=C001&user_id=U_ALICE&user_name=alice&trigger_id=tr1';
  const res = await request(app)
    .post('/slack/commands')
    .set(makeSlackHeaders(body))
    .send(body);

  assert.equal(res.status, 200);
  assert.match(res.body.text, /poll started/i);

  // Session created in DB
  const session = await db.get(`SELECT * FROM find_time_sessions WHERE channel_id = 'C001'`);
  assert.ok(session);
  assert.equal(session.status, 'open');
  assert.equal(session.creator_id, 'U_ALICE');

  // Modal opened and announcement posted
  assert.equal(apiCalls.openModal.length, 1);
  assert.equal(apiCalls.postMessage.length, 1);

  await db.close();
});

test('/find-time returns ephemeral error if session already open', async () => {
  const { db, app } = await setupSlackApp();

  const body = 'command=%2Ffind-time&channel_id=C002&user_id=U_ALICE&user_name=alice&trigger_id=tr1';
  await request(app).post('/slack/commands').set(makeSlackHeaders(body)).send(body);
  const res = await request(app).post('/slack/commands').set(makeSlackHeaders(body)).send(body);

  assert.equal(res.status, 200);
  assert.match(res.body.text, /already open/i);

  await db.close();
});

test('/find-time-end with no active session returns ephemeral error', async () => {
  const { db, app } = await setupSlackApp();

  const body = 'command=%2Ffind-time-end&channel_id=C003&user_id=U_ALICE&user_name=alice&trigger_id=tr1';
  const res = await request(app)
    .post('/slack/commands')
    .set(makeSlackHeaders(body))
    .send(body);

  assert.equal(res.status, 200);
  assert.match(res.body.text, /no active/i);

  await db.close();
});

test('/find-time-end closes session and posts results', async () => {
  const { db, app, apiCalls } = await setupSlackApp();

  // Open session
  const openBody = 'command=%2Ffind-time&channel_id=C004&user_id=U_ALICE&user_name=alice&trigger_id=tr1';
  await request(app).post('/slack/commands').set(makeSlackHeaders(openBody)).send(openBody);

  const session = await db.get(`SELECT * FROM find_time_sessions WHERE channel_id = 'C004'`);

  // Insert a submission directly
  await db.run(
    `INSERT INTO find_time_submissions
       (session_id, user_id, user_name, timezone, timezone_label, start_time_utc, end_time_utc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [session.id, 'U_ALICE', 'alice', 'UTC', 'UTC', '2026-05-18T14:00:00.000Z', '2026-05-18T17:00:00.000Z', new Date().toISOString()]
  );

  const endBody = 'command=%2Ffind-time-end&channel_id=C004&user_id=U_ALICE&user_name=alice&trigger_id=tr2';
  const res = await request(app)
    .post('/slack/commands')
    .set(makeSlackHeaders(endBody))
    .send(endBody);

  assert.equal(res.status, 200);
  assert.match(res.body.text, /closed/i);

  // Session marked closed
  const closed = await db.get(`SELECT status FROM find_time_sessions WHERE id = ?`, [session.id]);
  assert.equal(closed.status, 'closed');

  // Results posted to channel (postMessage called twice: announce + results)
  const resultPost = apiCalls.postMessage.find((c) => /Find-a-Time Results/.test(c.text));
  assert.ok(resultPost, 'Results message not posted');

  await db.close();
});

// ---------------------------------------------------------------------------
// /slack/interactive — button click opens modal
// ---------------------------------------------------------------------------

test('button click opens the find-time modal', async () => {
  const { db, app, apiCalls } = await setupSlackApp();

  // Create a session first
  const { id: sessionId } = await db.run(
    `INSERT INTO find_time_sessions (channel_id, creator_id, creator_name, status, expected_count, created_at)
     VALUES ('C005', 'U_ALICE', 'alice', 'open', 0, ?)`,
    [new Date().toISOString()]
  );

  const interactivePayload = JSON.stringify({
    type: 'block_actions',
    user: { id: 'U_BOB', name: 'bob' },
    trigger_id: 'tr_button',
    actions: [{ action_id: 'open_find_time_modal', value: String(sessionId) }],
  });
  const body = `payload=${encodeURIComponent(interactivePayload)}`;
  const res = await request(app)
    .post('/slack/interactive')
    .set(makeSlackHeaders(body))
    .send(body);

  assert.equal(res.status, 200);
  assert.equal(apiCalls.openModal.length, 1);
  assert.equal(apiCalls.openModal[0].triggerId, 'tr_button');

  await db.close();
});

// ---------------------------------------------------------------------------
// /slack/interactive — modal submission saves availability
// ---------------------------------------------------------------------------

test('modal submission saves availability and returns clear action', async () => {
  const { db, app } = await setupSlackApp();

  const { id: sessionId } = await db.run(
    `INSERT INTO find_time_sessions (channel_id, creator_id, creator_name, status, expected_count, created_at)
     VALUES ('C006', 'U_ALICE', 'alice', 'open', 0, ?)`,
    [new Date().toISOString()]
  );

  const viewPayload = {
    type: 'view_submission',
    user: { id: 'U_ALICE', name: 'alice' },
    view: {
      callback_id: 'find_time_submit',
      private_metadata: JSON.stringify({ session_id: sessionId, channel_id: 'C006' }),
      state: {
        values: {
          tz: { tz_select: { selected_option: { value: 'America/New_York' } } },
          avail_date: { date_pick: { selected_date: '2026-05-18' } },
          start_time: { start_pick: { selected_time: '14:00' } },
          end_time: { end_pick: { selected_time: '17:00' } },
        },
      },
    },
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(viewPayload))}`;
  const res = await request(app)
    .post('/slack/interactive')
    .set(makeSlackHeaders(body))
    .send(body);

  assert.equal(res.status, 200);
  assert.equal(res.body.response_action, 'clear');

  const sub = await db.get(`SELECT * FROM find_time_submissions WHERE session_id = ?`, [sessionId]);
  assert.ok(sub);
  assert.equal(sub.user_id, 'U_ALICE');
  assert.equal(sub.timezone, 'America/New_York');
  // 14:00 EDT (UTC-4 in May) = 18:00 UTC
  assert.equal(sub.start_time_utc, '2026-05-18T18:00:00.000Z');
  assert.equal(sub.end_time_utc, '2026-05-18T21:00:00.000Z');

  await db.close();
});

test('modal submission rejects end time before start time', async () => {
  const { db, app } = await setupSlackApp();

  const { id: sessionId } = await db.run(
    `INSERT INTO find_time_sessions (channel_id, creator_id, creator_name, status, expected_count, created_at)
     VALUES ('C007', 'U_ALICE', 'alice', 'open', 0, ?)`,
    [new Date().toISOString()]
  );

  const viewPayload = {
    type: 'view_submission',
    user: { id: 'U_ALICE', name: 'alice' },
    view: {
      callback_id: 'find_time_submit',
      private_metadata: JSON.stringify({ session_id: sessionId, channel_id: 'C007' }),
      state: {
        values: {
          tz: { tz_select: { selected_option: { value: 'UTC' } } },
          avail_date: { date_pick: { selected_date: '2026-05-18' } },
          start_time: { start_pick: { selected_time: '17:00' } },
          end_time: { end_pick: { selected_time: '14:00' } },
        },
      },
    },
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(viewPayload))}`;
  const res = await request(app)
    .post('/slack/interactive')
    .set(makeSlackHeaders(body))
    .send(body);

  assert.equal(res.status, 200);
  assert.ok(res.body.response_action === 'errors', 'Expected errors response action');

  await db.close();
});

test('modal submission auto-closes session when all expected members submit', async () => {
  const { db, app, apiCalls } = await setupSlackApp();

  // expected_count = 1 so first submission triggers auto-close
  const { id: sessionId } = await db.run(
    `INSERT INTO find_time_sessions (channel_id, creator_id, creator_name, status, expected_count, created_at)
     VALUES ('C008', 'U_ALICE', 'alice', 'open', 1, ?)`,
    [new Date().toISOString()]
  );

  const viewPayload = {
    type: 'view_submission',
    user: { id: 'U_ALICE', name: 'alice' },
    view: {
      callback_id: 'find_time_submit',
      private_metadata: JSON.stringify({ session_id: sessionId, channel_id: 'C008' }),
      state: {
        values: {
          tz: { tz_select: { selected_option: { value: 'UTC' } } },
          avail_date: { date_pick: { selected_date: '2026-05-18' } },
          start_time: { start_pick: { selected_time: '10:00' } },
          end_time: { end_pick: { selected_time: '12:00' } },
        },
      },
    },
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(viewPayload))}`;
  await request(app).post('/slack/interactive').set(makeSlackHeaders(body)).send(body);

  const session = await db.get(`SELECT status FROM find_time_sessions WHERE id = ?`, [sessionId]);
  assert.equal(session.status, 'closed');

  const resultPost = apiCalls.postMessage.find((c) => /Find-a-Time Results/.test(c.text));
  assert.ok(resultPost, 'Auto-close should post results');

  await db.close();
});

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

test('/slack/commands rejects requests with invalid signature', async () => {
  const { db, app } = await setupSlackApp();

  const body = 'command=%2Ffind-time&channel_id=C099&user_id=U_X&user_name=x&trigger_id=tr1';
  const res = await request(app)
    .post('/slack/commands')
    .set({
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-slack-signature': 'v0=badsignature',
    })
    .send(body);

  assert.equal(res.status, 401);

  await db.close();
});


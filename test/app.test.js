const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createDatabase } = require('../src/db');
const { createApp } = require('../src/app');

async function setup() {
  const db = createDatabase(':memory:');
  await db.init();

  const slackCalls = [];
  const app = createApp({
    db,
    sendSlackMessage: async (webhookUrl, text) => {
      slackCalls.push({ webhookUrl, text });
    },
  });

  return { db, app, slackCalls };
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
    .send({ webhookUrl: 'https://hooks.slack.com/services/T000/B000/XYZ' });

  assert.equal(slack.status, 200);
  assert.equal(slackCalls.length, 1);
  assert.match(slackCalls[0].text, /no votes yet/i);

  await db.close();
});

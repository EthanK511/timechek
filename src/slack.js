async function sendSlackMessage(webhookUrl, text) {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error('Slack webhook URL must be a valid https://hooks.slack.com URL.');
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'hooks.slack.com') {
    throw new Error('Slack webhook URL must be a valid https://hooks.slack.com URL.');
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body}`);
  }
}

/**
 * Call a Slack Web API endpoint with a bot token.
 * @param {string} endpoint  - e.g. "chat.postMessage"
 * @param {string} botToken  - xoxb-... bot OAuth token
 * @param {object} params    - request body / query params
 * @param {'POST'|'GET'} [method='POST']
 * @returns {Promise<object>} parsed JSON response
 */
async function callSlackAPI(endpoint, botToken, params = {}, method = 'POST') {
  let url = `https://slack.com/api/${endpoint}`;
  const headers = { Authorization: `Bearer ${botToken}` };
  let body;

  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params);
  }

  const response = await fetch(url, { method, headers, body });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Slack API ${endpoint} HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

/**
 * Open a Slack modal using a trigger_id.
 */
async function openModal(botToken, triggerId, view) {
  const data = await callSlackAPI('views.open', botToken, { trigger_id: triggerId, view });
  if (!data.ok) throw new Error(`views.open failed: ${data.error}`);
  return data;
}

/**
 * Post a message to a Slack channel.
 */
async function postMessage(botToken, channel, text, blocks) {
  const payload = { channel, text };
  if (blocks) payload.blocks = blocks;
  const data = await callSlackAPI('chat.postMessage', botToken, payload);
  if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
  return data;
}

/**
 * Fetch the list of member user IDs in a channel.
 * Requires channels:read (public) or groups:read (private) scope.
 */
async function getChannelMembers(botToken, channelId) {
  const data = await callSlackAPI('conversations.members', botToken, { channel: channelId });
  if (!data.ok) throw new Error(`conversations.members failed: ${data.error}`);
  return data.members || [];
}

/**
 * Get a user's current presence ('active' or 'away').
 * Requires users:read scope.
 */
async function getUserPresence(botToken, userId) {
  const data = await callSlackAPI('users.getPresence', botToken, { user: userId }, 'GET');
  if (!data.ok) return 'unknown';
  return data.presence;
}

/**
 * Get user info (includes is_bot field for filtering bots).
 * Requires users:read scope.
 */
async function getUserInfo(botToken, userId) {
  const data = await callSlackAPI('users.info', botToken, { user: userId }, 'GET');
  if (!data.ok) throw new Error(`users.info failed: ${data.error}`);
  return data.user;
}

module.exports = {
  sendSlackMessage,
  callSlackAPI,
  openModal,
  postMessage,
  getChannelMembers,
  getUserPresence,
  getUserInfo,
};

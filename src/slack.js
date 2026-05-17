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

module.exports = { sendSlackMessage };

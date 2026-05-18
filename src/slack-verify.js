const crypto = require('crypto');

/**
 * Verifies a Slack request using the signing secret.
 * See https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * @param {string} signingSecret - SLACK_SIGNING_SECRET
 * @param {string} rawBody       - raw UTF-8 request body string
 * @param {string} timestamp     - X-Slack-Request-Timestamp header value
 * @param {string} signature     - X-Slack-Signature header value
 * @returns {boolean}
 */
function verifySlackRequest(signingSecret, rawBody, timestamp, signature) {
  if (!signingSecret || !rawBody || !timestamp || !signature) return false;

  // Reject requests older than 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  const expected = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

module.exports = { verifySlackRequest };

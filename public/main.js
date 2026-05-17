let currentHuddleId = null;

const huddleListEl = document.getElementById('huddle-list');
const panelEl = document.getElementById('huddle-panel');
const titleEl = document.getElementById('huddle-title');
const descriptionEl = document.getElementById('huddle-description');
const scheduleEl = document.getElementById('schedule');
const statusEl = document.getElementById('status');
const voterNameEl = document.getElementById('voter-name');
const slackWebhookEl = document.getElementById('slack-webhook');

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b42318' : '#0d8b5f';
}

function toLocalDisplay(iso) {
  return new Date(iso).toLocaleString();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function renderSchedule(windows = [], topWindows = []) {
  if (!windows.length) {
    scheduleEl.innerHTML = '<p class="meta">No availability windows yet. Add one above.</p>';
    return;
  }

  const topIds = new Set(topWindows.map((w) => w.id));
  const voterName = voterNameEl.value.trim();

  scheduleEl.innerHTML = windows
    .map(
      (window) => `
      <div class="schedule-item ${topIds.has(window.id) ? 'top' : ''}">
        <strong>${toLocalDisplay(window.start_time)} → ${toLocalDisplay(window.end_time)}</strong>
        <p class="meta">Proposed by ${window.proposer_name}</p>
        <p class="meta">Votes: ${window.vote_count}${window.voters.length ? ` (${window.voters.join(', ')})` : ''}</p>
        <button type="button" data-window-id="${window.id}" ${voterName ? '' : 'disabled'}>
          Toggle vote
        </button>
      </div>
    `
    )
    .join('');

  scheduleEl.querySelectorAll('button[data-window-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const voterNameValue = voterNameEl.value.trim();
        if (!voterNameValue) {
          setStatus('Enter a voter name first.', true);
          return;
        }

        await api(`/api/windows/${button.dataset.windowId}/votes`, {
          method: 'POST',
          body: JSON.stringify({ voterName: voterNameValue }),
        });
        await loadSelectedHuddle();
        setStatus('Vote updated.');
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
}

async function loadHuddles(selectId) {
  const { huddles } = await api('/api/huddles');

  huddleListEl.innerHTML = huddles.length
    ? huddles
        .map(
          (huddle) => `
      <li>
        <button type="button" data-huddle-id="${huddle.id}">
          <strong>${huddle.title}</strong><br />
          <span class="meta">${huddle.window_count} window${Number(huddle.window_count) === 1 ? '' : 's'}</span>
        </button>
      </li>`
        )
        .join('')
    : '<li class="meta">No huddles yet.</li>';

  huddleListEl.querySelectorAll('button[data-huddle-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      currentHuddleId = Number(button.dataset.huddleId);
      await loadSelectedHuddle();
    });
  });

  if (selectId) {
    currentHuddleId = selectId;
    await loadSelectedHuddle();
  }
}

async function loadSelectedHuddle() {
  if (!currentHuddleId) return;
  const { huddle, windows, topWindows } = await api(`/api/huddles/${currentHuddleId}`);
  panelEl.hidden = false;
  titleEl.textContent = huddle.title;
  descriptionEl.textContent = huddle.description || '';
  renderSchedule(windows, topWindows);
}

async function postSlack(type) {
  if (!currentHuddleId) return;

  const webhookUrl = slackWebhookEl.value.trim();
  const endpoint = type === 'results' ? 'results' : 'reminder';

  await api(`/api/huddles/${currentHuddleId}/slack/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify({ webhookUrl }),
  });
}

document.getElementById('create-huddle-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const { huddle } = await api('/api/huddles', {
      method: 'POST',
      body: JSON.stringify({
        title: form.get('title'),
        description: form.get('description'),
      }),
    });
    event.currentTarget.reset();
    await loadHuddles(huddle.id);
    setStatus('Huddle created.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById('window-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentHuddleId) {
    setStatus('Create or select a huddle first.', true);
    return;
  }

  const form = new FormData(event.currentTarget);

  try {
    await api(`/api/huddles/${currentHuddleId}/windows`, {
      method: 'POST',
      body: JSON.stringify({
        proposerName: form.get('proposerName'),
        startTime: form.get('startTime'),
        endTime: form.get('endTime'),
      }),
    });
    event.currentTarget.reset();
    await loadHuddles(currentHuddleId);
    setStatus('Availability window added.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

voterNameEl.addEventListener('input', async () => {
  await loadSelectedHuddle();
});

document.getElementById('post-results-btn').addEventListener('click', async () => {
  try {
    await postSlack('results');
    setStatus('Results posted to Slack.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.getElementById('post-reminder-btn').addEventListener('click', async () => {
  try {
    await postSlack('reminder');
    setStatus('Reminder posted to Slack.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

loadHuddles().catch((error) => setStatus(error.message, true));

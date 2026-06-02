/**
 * popup.js — ContentTrack extension popup logic (v2).
 *
 * - Reads auto-fetched email/IP from chrome.storage.sync (set by background.js).
 * - Shows identity status: auto-detected or manual fallback.
 * - No dashboard link (admin-only dashboard).
 * - Sync Now triggers background flush.
 */

const API_BASE = 'http://localhost:8000';

// ── DOM refs ───────────────────────────────────────────────────────────────────
const identityEmail   = document.getElementById('identity-email');
const identityIp      = document.getElementById('identity-ip');
const identityBadge   = document.getElementById('identity-badge');
const fallbackToggle  = document.getElementById('fallback-toggle');
const fallbackSection = document.getElementById('fallback-section');
const emailInput      = document.getElementById('email-input');
const btnSetEmail     = document.getElementById('btn-set-email');
const emailDisplay    = document.getElementById('email-display');
const statusDot       = document.getElementById('status-dot');
const statusLabel     = document.getElementById('status-label');
const csDomain        = document.getElementById('cs-domain');
const csMeta          = document.getElementById('cs-meta');
const statDomains     = document.getElementById('stat-domains');
const statClicks      = document.getElementById('stat-clicks');
const statScroll      = document.getElementById('stat-scroll');
const statTime        = document.getElementById('stat-time');
const btnSync         = document.getElementById('btn-sync');
const toastArea       = document.getElementById('toast-area');


// ── Utility ────────────────────────────────────────────────────────────────────
function secondsToHuman(s) {
  if (s <= 0) return '0m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function showToast(msg, color = '#22c55e') {
  toastArea.innerHTML = `<div class="toast" style="background:${color}">${msg}</div>`;
  setTimeout(() => { toastArea.innerHTML = ''; }, 3000);
}


// ── Load and display auto-fetched identity ────────────────────────────────────
async function loadIdentity() {
  const { userEmail, userName, userIP } = await chrome.storage.sync.get(['userEmail', 'userName', 'userIP']);

  if (userEmail) {
    identityEmail.textContent = userEmail;
    identityIp.textContent    = userIP ? `IP: ${userIP}` : 'IP: detecting...';
    identityBadge.textContent = '✓ Auto';
    identityBadge.classList.remove('pending');
    identityBadge.style.background = '#16a34a';
    fallbackToggle.style.display = 'block';  // show manual override option
  } else {
    // Identity API didn't return an email — show manual fallback
    identityEmail.textContent = 'Not detected';
    identityIp.textContent    = 'Sign into Chrome to auto-detect';
    identityBadge.textContent = '⚠ Manual';
    identityBadge.style.background = '#d97706';
    fallbackToggle.style.display = 'block';
    fallbackSection.classList.add('visible');  // auto-show fallback
  }
}


// ── Toggle fallback manual email section ──────────────────────────────────────
fallbackToggle.addEventListener('click', () => {
  fallbackSection.classList.toggle('visible');
});


// ── Save manual email (fallback) ──────────────────────────────────────────────
btnSetEmail.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) {
    showToast('⚠️ Enter a valid email', '#ef4444');
    return;
  }
  const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  await chrome.storage.sync.set({ userEmail: email, userName: name });
  emailDisplay.textContent = `✅ Saved: ${email}`;
  identityEmail.textContent = email;
  identityBadge.textContent = '✓ Manual';
  identityBadge.style.background = '#2563eb';
  showToast('✅ Email saved!');
});


// ── Check server reachability ─────────────────────────────────────────────────
async function checkServer() {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard/kpis`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      statusDot.classList.remove('offline');
      statusLabel.textContent = 'Server connected — tracking active';
    } else {
      throw new Error();
    }
  } catch {
    statusDot.classList.add('offline');
    statusLabel.textContent = 'Server offline (start backend)';
  }
}


// ── Poll active tab stats via content script ──────────────────────────────────
async function loadActiveTabStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  try {
    const stats = await chrome.tabs.sendMessage(tab.id, { type: 'getStats' });
    if (stats) {
      const domain = stats.domain || new URL(tab.url || 'about:blank').hostname.replace('www.', '');
      csDomain.textContent = domain || '—';

      let metaLine = `⏱ ${secondsToHuman(stats.time_spent_seconds)}  •  🖱 ${stats.clicks} clicks  •  📜 ${stats.scroll_depth}% scroll`;
      if (stats.content_type && stats.content_type !== 'Webpage') {
        metaLine = `[${stats.content_type}] ` + metaLine;
      }
      csMeta.textContent = metaLine;
    }
  } catch {
    const url    = tab.url || '';
    const domain = url.startsWith('http') ? new URL(url).hostname.replace('www.', '') : '—';
    csDomain.textContent = domain;
    csMeta.textContent   = 'Navigate to a page to start tracking';
  }
}


// ── Sync Now button ───────────────────────────────────────────────────────────
btnSync.addEventListener('click', async () => {
  const { userEmail } = await chrome.storage.sync.get('userEmail');
  if (!userEmail) {
    showToast('⚠️ No email detected. Sign into Chrome.', '#f59e0b');
    return;
  }
  btnSync.textContent = '⏳ Syncing...';
  btnSync.disabled    = true;

  chrome.runtime.sendMessage({ type: 'syncNow' });

  await new Promise(r => setTimeout(r, 1800));
  btnSync.textContent = '⚡ Sync Now';
  btnSync.disabled    = false;
  showToast('✅ Data synced!');
});


// ── Load session summary from background storage ──────────────────────────────
async function loadSessionSummary() {
  const { sessionSummary } = await chrome.storage.session.get('sessionSummary').catch(() => ({}));
  if (sessionSummary) {
    statDomains.textContent = sessionSummary.domains  || 0;
    statClicks.textContent  = sessionSummary.clicks   || 0;
    statScroll.textContent  = `${sessionSummary.scroll || 0}%`;
    statTime.textContent    = secondsToHuman(sessionSummary.time || 0);
  }
}


// ── Init ───────────────────────────────────────────────────────────────────────
(async () => {
  await checkServer();
  await loadIdentity();
  await loadActiveTabStats();
  await loadSessionSummary();
})();

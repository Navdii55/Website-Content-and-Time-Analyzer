/**
 * background.js — Service worker for ContentTrack extension (v2).
 *
 * Key improvements:
 *  1. Auto-fetches signed-in Google email via chrome.identity API on startup.
 *  2. Auto-fetches public IP address from ipify on each flush.
 *  3. Tracks time ONLY for the ACTIVE & VISIBLE tab — background tabs are excluded.
 *     Content script reports only the delta since last snapshot (not cumulative total).
 *  4. Online/offline status driven by chrome.windows.onFocusChanged.
 *  5. Queues detailed page visits (URLs, titles, YouTube info) and flushes them separately.
 *  6. All data is auto-synced every 60 seconds via the 'periodicSync' alarm.
 *  7. No manual email entry required — identity API handles it automatically.
 */

const API_BASE = 'http://localhost:8000';

// ── In-memory state ───────────────────────────────────────────────────────────
let accumulator = {};   // { [domain]: { time, pages, clicks, maxScroll, bounceCount, totalVisits } }
let pageVisitQueue = [];   // queue of individual page visit objects
let activeTabId = null;
let userOnline = true;

// ── Category guesser ──────────────────────────────────────────────────────────
const CATEGORY_MAP = {
  'github.com': 'Development',
  'stackoverflow.com': 'Development',
  'gitlab.com': 'Development',
  'developer.mozilla.org': 'Development',
  'youtube.com': 'Entertainment',
  'netflix.com': 'Entertainment',
  'twitch.tv': 'Entertainment',
  'reddit.com': 'Social',
  'twitter.com': 'Social',
  'x.com': 'Social',
  'instagram.com': 'Social',
  'facebook.com': 'Social',
  'linkedin.com': 'Professional',
  'notion.so': 'Productivity',
  'figma.com': 'Design',
  'dribbble.com': 'Design',
  'pinterest.com': 'Social',
  'amazon.in': 'E-Commerce',
  'amazon.com': 'E-Commerce',
  'flipkart.com': 'E-Commerce',
  'coursera.org': 'Education',
  'udemy.com': 'Education',
  'khanacademy.org': 'Education',
  'medium.com': 'Reading',
  'news.ycombinator.com': 'Tech News',
  'maps.google.com': 'Navigation',
  'google.com': 'Search',
};

function guessCategory(domain) {
  return CATEGORY_MAP[domain] || 'Browsing';
}


// ── Auto-fetch user email via chrome.identity ─────────────────────────────────
async function autoFetchEmail() {
  return new Promise((resolve) => {
    try {
      chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
        if (chrome.runtime.lastError) {
          console.warn('[ContentTrack] identity error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (info && info.email) {
          const email = info.email;
          const name = email
            .split('@')[0]
            .replace(/[._-]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
          chrome.storage.sync.set({ userEmail: email, userName: name });
          console.log('[ContentTrack] Auto-fetched email:', email);
          resolve({ email, name });
        } else {
          console.warn('[ContentTrack] identity returned empty email. User may not be signed into Chrome.');
          resolve(null);
        }
      });
    } catch (err) {
      console.warn('[ContentTrack] identity API unavailable:', err.message);
      resolve(null);
    }
  });
}


// ── Fetch public IP from ipify ─────────────────────────────────────────────────
async function getPublicIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(4000),
    });
    const data = await res.json();
    if (data.ip) {
      await chrome.storage.sync.set({ userIP: data.ip });
      return data.ip;
    }
  } catch (err) {
    console.warn('[ContentTrack] IP fetch failed:', err.message);
  }
  // Return cached IP if fetch fails
  const { userIP } = await chrome.storage.sync.get('userIP');
  return userIP || null;
}


// ── Accumulate domain stats ───────────────────────────────────────────────────
function accumulate(domain, stats) {
  if (!domain || domain === 'newtab' || domain === '') return;
  if (!accumulator[domain]) {
    accumulator[domain] = {
      time_spent_seconds: 0,
      pages_visited: 0,
      clicks: 0,
      max_scroll: 0,
      bounce_count: 0,
      total_visits: 0,
    };
  }
  const acc = accumulator[domain];
  // Use the delta time from content.js (not cumulative since page load)
  acc.time_spent_seconds += stats.time_spent_seconds || 0;
  acc.pages_visited += 1;
  acc.clicks += stats.clicks || 0;
  acc.max_scroll = Math.max(acc.max_scroll, stats.scroll_depth || 0);
  acc.total_visits += 1;
  if (stats.bounced) acc.bounce_count += 1;
}


// ── Queue a detailed page visit ───────────────────────────────────────────────
function queuePageVisit(stats) {
  if (!stats || !stats.full_url) return;
  if (stats.full_url.startsWith('chrome') || stats.full_url.startsWith('about')) return;
  pageVisitQueue.push({
    full_url: stats.full_url,
    page_title: stats.page_title || null,
    content_type: stats.content_type || 'Webpage',
    extra_info: stats.extra_info || null,
    time_spent_seconds: stats.time_spent_seconds || 0,
    clicks: stats.clicks || 0,
    scroll_depth: stats.scroll_depth || 0,
  });
}


// ── Snapshot the active tab via its content script ────────────────────────────
async function snapshotActiveTab() {
  if (!activeTabId) return;
  try {
    const stats = await chrome.tabs.sendMessage(activeTabId, { type: 'getStats' });
    if (stats && stats.domain) {
      accumulate(stats.domain, stats);
      queuePageVisit(stats);
    }
  } catch (_) {
    // Tab may not have a content script (e.g. chrome:// pages)
  }
}


// ── Flush domain-level accumulator to /api/ingest ─────────────────────────────
async function flush(status = 'online') {
  const { userEmail, userName } = await chrome.storage.sync.get(['userEmail', 'userName']);
  if (!userEmail) {
    console.log('[ContentTrack] No email available — skipping flush.');
    return;
  }

  const ipAddress = await getPublicIP();

  const domains = Object.keys(accumulator);
  if (domains.length > 0) {
    const promises = domains.map(async (domain) => {
      const acc = accumulator[domain];
      const bounceRate = acc.total_visits > 0
        ? Math.round((acc.bounce_count / acc.total_visits) * 100)
        : 0;

      const payload = {
        email: userEmail,
        name: userName || 'Extension User',
        ip_address: ipAddress,
        domain,
        time_spent_seconds: acc.time_spent_seconds,
        pages_visited: acc.pages_visited,
        clicks: acc.clicks,
        scroll_depth: acc.max_scroll,
        bounce_rate: bounceRate,
        content_category: guessCategory(domain),
        status,
      };

      try {
        const res = await fetch(`${API_BASE}/api/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          console.log(`[ContentTrack] Synced domain: ${domain}`);
          delete accumulator[domain];
        }
      } catch (err) {
        console.warn(`[ContentTrack] Sync failed for ${domain}:`, err.message);
      }
    });
    await Promise.all(promises);
  }

  // ── Flush page visits to /api/ingest/pages ──────────────────────────────────
  if (pageVisitQueue.length > 0) {
    const visits = [...pageVisitQueue];
    pageVisitQueue = [];
    try {
      const res = await fetch(`${API_BASE}/api/ingest/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: userEmail,
          name: userName || 'Extension User',
          ip_address: ipAddress,
          page_visits: visits,
        }),
      });
      if (!res.ok) {
        // Put back on failure
        pageVisitQueue = [...visits, ...pageVisitQueue];
      } else {
        console.log(`[ContentTrack] Synced ${visits.length} page visit(s)`);
      }
    } catch (err) {
      pageVisitQueue = [...visits, ...pageVisitQueue];
      console.warn('[ContentTrack] Page visits sync failed:', err.message);
    }
  }
}


// ── Send a lightweight status-only update ─────────────────────────────────────
async function sendStatusUpdate(status) {
  const { userEmail, userName } = await chrome.storage.sync.get(['userEmail', 'userName']);
  if (!userEmail) return;
  const ipAddress = await chrome.storage.sync.get('userIP').then(d => d.userIP || null);
  try {
    await fetch(`${API_BASE}/api/user/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userEmail,
        name: userName || 'Extension User',
        ip_address: ipAddress,
        status,
      }),
    });
  } catch (_) { }
}


// ── Tab event handlers ────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await snapshotActiveTab();   // snapshot the tab LOSING focus
  activeTabId = tabId;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeTabId) {
    await snapshotActiveTab();
    activeTabId = null;
    await flush();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.status === 'loading') {
    // New page in the same tab — snapshot old page before it unloads
    await snapshotActiveTab();
  }
});


// ── Window focus — drives online / offline status ─────────────────────────────
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // User switched to a non-Chrome app → mark offline
    if (userOnline) {
      userOnline = false;
      await snapshotActiveTab();
      await flush('offline');
      await sendStatusUpdate('offline');
    }
  } else {
    // User returned to Chrome → mark online
    if (!userOnline) {
      userOnline = true;
      await sendStatusUpdate('online');
    }
  }
});


// ── Message bus (popup → background) ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'pageStats' && msg.data) {
    accumulate(msg.data.domain, msg.data);
    queuePageVisit(msg.data);
  }
  if (msg.type === 'syncNow') {
    snapshotActiveTab().then(() => flush());
  }
});


// ── Periodic alarm — every 60 seconds ────────────────────────────────────────
chrome.alarms.create('periodicSync', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodicSync') {
    await snapshotActiveTab();
    await flush(userOnline ? 'online' : 'offline');
  }
});


// ── Startup: auto-fetch email + IP ────────────────────────────────────────────
async function init() {
  await autoFetchEmail();
  await getPublicIP();
  // Get the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tab) activeTabId = tab.id;
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

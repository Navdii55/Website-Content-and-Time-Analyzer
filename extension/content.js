/**
 * content.js — Injected into every page by the ContentTrack extension (v2).
 *
 * Key fixes:
 *  1. TIME: Only counts time while the tab is VISIBLE (visibilityState === 'visible').
 *           Reports DELTA time since last snapshot, not cumulative since injection.
 *           This eliminates multi-tab time multiplication completely.
 *
 *  2. DETAIL: Captures full URL, page title, and content type on every page.
 *
 *  3. YOUTUBE: Extracts video ID and title from YouTube watch pages.
 *
 *  4. ARTICLES: Detects article headlines from news/blog pages.
 */

(function () {
  // Prevent double-injection
  if (window.__contentTrackInjected) return;
  window.__contentTrackInjected = true;

  // ── Interaction counters ─────────────────────────────────────────────────────
  let clickCount = 0;
  let maxScrollPct = 0;

  // ── Visible-time tracking (fixes multi-tab multiplication) ──────────────────
  // visibleMs: accumulated ms the tab has been visible since last snapshot
  // lastSnapshotVisibleMs: what was already reported in the last getStats() call
  let visibleMs = 0;
  let lastSnapshotVisibleMs = 0;
  // start timer immediately if tab is already visible (e.g. on initial load)
  let visibilityStart = (document.visibilityState === 'visible') ? Date.now() : null;

  function getCurrentVisibleMs() {
    // Total visible ms up to right now (including ongoing visible session)
    let total = visibleMs;
    if (visibilityStart !== null) {
      total += Date.now() - visibilityStart;
    }
    return total;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // Accumulate the current visible stretch
      if (visibilityStart !== null) {
        visibleMs += Date.now() - visibilityStart;
        visibilityStart = null;
      }
      // Push stats on hide (tab switched away or window minimized)
      chrome.runtime.sendMessage({ type: 'pageStats', data: getStats(true) });
    } else {
      // Tab became visible again — restart the timer
      visibilityStart = Date.now();
    }
  });

  // ── Click tracking ────────────────────────────────────────────────────────────
  document.addEventListener('click', () => { clickCount++; }, { passive: true });

  // ── Scroll depth tracking ─────────────────────────────────────────────────────
  function measureScroll() {
    const scrolled = window.scrollY + window.innerHeight;
    const total = document.documentElement.scrollHeight;
    if (total > 0) {
      const pct = Math.round((scrolled / total) * 100);
      if (pct > maxScrollPct) maxScrollPct = pct;
    }
  }
  window.addEventListener('scroll', measureScroll, { passive: true });
  measureScroll();

  // ── Page detail detection ─────────────────────────────────────────────────────
  function detectPageDetails() {
    const hostname = location.hostname.replace('www.', '');
    const title = document.title;
    const url = location.href;

    // YouTube video detection
    if ((hostname === 'youtube.com' || hostname === 'm.youtube.com') && url.includes('/watch')) {
      const videoId = new URLSearchParams(location.search).get('v') || '';
      // Try multiple selectors — YouTube's DOM varies by page state
      const titleEl = document.querySelector(
        'h1.ytd-watch-metadata yt-formatted-string, ' +
        'h1.ytd-video-primary-info-renderer yt-formatted-string, ' +
        '#title h1 yt-formatted-string, ' +
        'h1.title'
      );
      const videoTitle = titleEl ? titleEl.textContent.trim() : title;
      return {
        content_type: 'YouTube Video',
        extra_info: JSON.stringify({ video_id: videoId, video_title: videoTitle }),
      };
    }

    // Netflix / streaming
    if (hostname.includes('netflix.com') || hostname.includes('primevideo.com') || hostname.includes('hotstar.com')) {
      return {
        content_type: 'Streaming',
        extra_info: JSON.stringify({ title }),
      };
    }

    // Article / news detection
    const articleH1 = document.querySelector('article h1, main h1, [role="main"] h1, .article-title, .post-title');
    if (articleH1 && articleH1.textContent.trim().length > 10) {
      return {
        content_type: 'Article',
        extra_info: JSON.stringify({ headline: articleH1.textContent.trim().slice(0, 200) }),
      };
    }

    // Generic webpage
    return {
      content_type: 'Webpage',
      extra_info: null,
    };
  }

  // ── Build a stats snapshot ────────────────────────────────────────────────────
  /**
   * @param {boolean} resetDelta - if true, mark the current visible time as "reported"
   *   so the next call only returns the additional time since this snapshot.
   *   This is the key fix for double-counting across multiple alarm ticks.
   */
  function getStats(resetDelta = false) {
    const totalVisible = getCurrentVisibleMs();
    const deltaMs = totalVisible - lastSnapshotVisibleMs;
    const deltaSeconds = Math.max(0, Math.round(deltaMs / 1000));

    if (resetDelta) {
      lastSnapshotVisibleMs = totalVisible;
    }

    const visibleSoFarSeconds = Math.round(totalVisible / 1000);
    const bounced = visibleSoFarSeconds < 15 && clickCount === 0;

    const { content_type, extra_info } = detectPageDetails();

    return {
      domain: location.hostname.replace('www.', ''),
      full_url: location.href,
      page_title: document.title,
      content_type,
      extra_info,
      time_spent_seconds: deltaSeconds,   // DELTA only — prevents double counting
      clicks: clickCount,
      scroll_depth: maxScrollPct,
      bounced,
    };
  }

  // ── Respond to background polling (getStats) ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStats') {
      sendResponse(getStats(true));  // reset delta so next call gets only new time
      return true;
    }
  });

  // ── Push stats on page unload ─────────────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({ type: 'pageStats', data: getStats(true) });
  });

})();

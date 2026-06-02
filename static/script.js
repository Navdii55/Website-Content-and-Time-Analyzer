// ================================================================
// ContentTrack — Dashboard Script v2
// ================================================================

let allUsers          = [];
let currentModalUserId = null;
const AUTO_REFRESH_MS  = 120_000;   // 2 minutes

// ── NAVIGATION ───────────────────────────────────────────────────────────────
function initNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', e => {
            e.preventDefault();
            switchView(item.getAttribute('data-view'));
        });
    });
}

function switchView(viewName) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));

    const navEl  = document.getElementById('nav-' + viewName);
    const viewEl = document.getElementById('view-' + viewName);
    if (navEl)  navEl.classList.add('active');
    if (viewEl) viewEl.classList.add('active-view');

    if (viewName === 'users')    renderUsersCards();
    if (viewName === 'reports')  renderReportsTable();
    if (viewName === 'timeline') renderTimeline();
}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initNav();
    loadKPIs();
    loadUsers();
    initSearch();
    initSettings();
    initModal();
    startAutoRefresh();
});

// ── KPI DATA ─────────────────────────────────────────────────────────────────
function loadKPIs() {
    return fetch('/api/dashboard/kpis')
        .then(r => r.json())
        .then(data => {
            document.getElementById('kpi-users').innerText    = data.total_users;
            document.getElementById('kpi-online').innerText   = data.online_users ?? '—';
            document.getElementById('kpi-time').innerText     = data.combined_time;
            document.getElementById('kpi-websites').innerText = data.total_websites;
            document.getElementById('kpi-pages').innerText    = data.total_pages;
            document.getElementById('kpi-clicks').innerText   = data.total_clicks.toLocaleString();
            document.getElementById('status-text').innerText  = data.tracking_status;
        })
        .catch(() => {
            document.getElementById('status-text').innerText = '⚠ Connection Error';
        });
}

// ── USER TABLE (DASHBOARD) ────────────────────────────────────────────────────
function loadUsers() {
    return fetch('/api/dashboard/users')
        .then(r => r.json())
        .then(users => {
            allUsers = users;
            renderTable(users);
        });
}

function renderTable(users) {
    const tbody = document.getElementById('user-table-body');
    tbody.innerHTML = '';

    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:32px;">No users found.</td></tr>`;
        return;
    }

    users.forEach(user => {
        const isOnline = user.status === 'online';
        const row      = document.createElement('tr');
        row.innerHTML  = `
            <td>
                <span class="table-email">${user.email}</span>
                <span class="table-name">${user.name}</span>
            </td>
            <td style="font-size:12px;color:var(--text-muted);">${user.ip_address || '—'}</td>
            <td><b>${user.total_time}</b></td>
            <td style="color:var(--accent-purple);font-weight:700;">${user.total_websites}</td>
            <td style="color:var(--accent-blue);font-weight:700;">${user.total_pages}</td>
            <td style="font-weight:700;">${user.total_clicks.toLocaleString()}</td>
            <td>${user.avg_scroll_depth}</td>
            <td>
                <span class="chip ${isOnline ? 'chip-online' : 'chip-offline'}">
                    ${isOnline ? '🟢 Online' : '⚫ Offline'}
                </span>
            </td>
            <td>
                <button class="btn-view" onclick="openModal('${user.id}')">👁️ View</button>
            </td>
            <td>
                <a class="btn-download" href="/api/report/${user.id}" download="${user.name.replace(/ /g,'_')}_report.pdf">📥 PDF</a>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// ── SEARCH ────────────────────────────────────────────────────────────────────
function initSearch() {
    const input = document.getElementById('search-input');
    input.addEventListener('input', () => {
        const q        = input.value.toLowerCase().trim();
        const filtered = allUsers.filter(u =>
            u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)
        );
        renderTable(filtered);
    });
}

// ── USERS CARDS VIEW ──────────────────────────────────────────────────────────
function renderUsersCards() {
    if (allUsers.length === 0) { setTimeout(renderUsersCards, 400); return; }
    const grid = document.getElementById('users-cards-grid');
    grid.innerHTML = '';
    allUsers.forEach(user => {
        const initials = user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        const card     = document.createElement('div');
        card.className = 'user-card';
        card.onclick   = () => openModal(user.id);
        card.innerHTML = `
            <div class="user-card-header">
                <div class="user-card-avatar">${initials}</div>
                <div>
                    <div class="user-card-name">${user.name}</div>
                    <div class="user-card-email">${user.email}</div>
                    <div style="font-size:11px;color:var(--text-muted);">IP: ${user.ip_address || '—'}</div>
                </div>
                <span class="chip ${user.status === 'online' ? 'chip-online' : 'chip-offline'}" style="margin-left:auto;">${user.status === 'online' ? '🟢' : '⚫'}</span>
            </div>
            <div class="user-card-stats">
                <div class="user-stat"><div class="user-stat-label">⏱ Time</div><div class="user-stat-value">${user.total_time}</div></div>
                <div class="user-stat"><div class="user-stat-label">🌐 Sites</div><div class="user-stat-value">${user.total_websites}</div></div>
                <div class="user-stat"><div class="user-stat-label">📄 Pages</div><div class="user-stat-value">${user.total_pages}</div></div>
                <div class="user-stat"><div class="user-stat-label">🖱 Clicks</div><div class="user-stat-value">${user.total_clicks}</div></div>
            </div>
        `;
        grid.appendChild(card);
    });
}

// ── REPORTS VIEW ──────────────────────────────────────────────────────────────
function renderReportsTable() {
    if (allUsers.length === 0) { setTimeout(renderReportsTable, 400); return; }
    const tbody = document.getElementById('reports-table-body');
    tbody.innerHTML = '';
    allUsers.forEach(user => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><b>${user.name}</b></td>
            <td>${user.email}</td>
            <td style="font-size:12px;color:var(--text-muted);">${user.ip_address || '—'}</td>
            <td>${user.total_time}</td>
            <td>${user.total_websites}</td>
            <td>${user.total_pages}</td>
            <td>
                <button class="btn-view" onclick="openModal('${user.id}')" style="margin-right:8px;">👁️ Preview</button>
                <a class="btn-download" href="/api/report/${user.id}" download="${user.name.replace(/ /g,'_')}_report.pdf">📥 PDF</a>
            </td>
        `;
        tbody.appendChild(row);
    });
}

// ── TIMELINE VIEW ─────────────────────────────────────────────────────────────
function renderTimeline() {
    if (allUsers.length === 0) { setTimeout(renderTimeline, 400); return; }
    const section  = document.getElementById('timeline-section');
    section.innerHTML = '';

    allUsers.forEach((user, i) => {
        const item     = document.createElement('div');
        item.className = 'timeline-item';
        const isLast   = i === allUsers.length - 1;
        const dotColor = user.status === 'online' ? 'background:var(--accent-green)' : 'background:#9CA3AF';
        item.innerHTML = `
            <div class="timeline-dot-col">
                <div class="timeline-dot" style="${dotColor}"></div>
                ${!isLast ? '<div class="timeline-line"></div>' : ''}
            </div>
            <div style="flex-grow:1;padding-bottom:${isLast ? 0 : 12}px;">
                <div class="timeline-card">
                    <div class="timeline-card-top">
                        <span class="timeline-user">${user.name}</span>
                        <span class="timeline-time">${user.last_active}</span>
                    </div>
                    <div class="timeline-site">${user.email} &nbsp;•&nbsp; IP: ${user.ip_address || '—'}</div>
                    <div class="timeline-meta">Status: <b>${user.status === 'online' ? '🟢 Active' : '⚫ Offline'}</b> &nbsp;|&nbsp; Sites: ${user.total_websites} &nbsp;|&nbsp; Time: ${user.total_time}</div>
                </div>
            </div>
        `;
        section.appendChild(item);
    });
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function initModal() {
    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('modal-overlay').addEventListener('click', e => {
        if (e.target === document.getElementById('modal-overlay')) closeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });
}

function openModal(userId, silent = false) {
    currentModalUserId = userId;
    fetch(`/api/user/${userId}`)
        .then(r => r.json())
        .then(user => {
            const initials = user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
            document.getElementById('modal-avatar').innerText = initials;
            document.getElementById('modal-name').innerText   = user.name;
            document.getElementById('modal-email').innerText  = user.email;
            document.getElementById('modal-ip').innerText     = `IP: ${user.ip_address || '—'}`;

            const statusChip       = document.getElementById('modal-status');
            statusChip.innerText   = user.status === 'online' ? '🟢 Online' : '⚫ Offline';
            statusChip.className   = `status-chip chip ${user.status === 'online' ? 'chip-online' : 'chip-offline'}`;

            // Stats Grid
            document.getElementById('modal-stats-grid').innerHTML = `
                <div class="modal-stat-card"><div class="modal-stat-label">⏱ Total Time</div><div class="modal-stat-value">${user.total_time}</div></div>
                <div class="modal-stat-card"><div class="modal-stat-label">🌐 Websites</div><div class="modal-stat-value">${user.total_websites}</div></div>
                <div class="modal-stat-card"><div class="modal-stat-label">📄 Pages</div><div class="modal-stat-value">${user.total_pages}</div></div>
                <div class="modal-stat-card"><div class="modal-stat-label">🖱 Clicks</div><div class="modal-stat-value">${user.total_clicks.toLocaleString()}</div></div>
                <div class="modal-stat-card"><div class="modal-stat-label">📜 Avg Scroll</div><div class="modal-stat-value">${user.avg_scroll_depth}</div></div>
                <div class="modal-stat-card"><div class="modal-stat-label">🕐 Last Active</div><div class="modal-stat-value" style="font-size:13px;">${user.last_active}</div></div>
            `;

            // Per-domain site breakdown
            const siteList = document.getElementById('modal-site-list');
            siteList.innerHTML = '';
            user.websites.forEach(site => {
                const row     = document.createElement('div');
                row.className = 'site-row';
                row.innerHTML = `
                    <div class="site-row-top">
                        <span class="site-domain">🌐 ${site.domain}</span>
                        <span class="site-category">${site.content_category}</span>
                    </div>
                    <div class="site-metrics">
                        <div class="metric-item"><span class="metric-label">Time Spent</span><span class="metric-value">${site.time_spent}</span></div>
                        <div class="metric-item"><span class="metric-label">Pages</span><span class="metric-value">${site.pages_visited}</span></div>
                        <div class="metric-item"><span class="metric-label">Clicks</span><span class="metric-value">${site.clicks}</span></div>
                        <div class="metric-item"><span class="metric-label">Scroll Depth</span><span class="metric-value">${site.scroll_depth}</span></div>
                        <div class="metric-item"><span class="metric-label">Bounce Rate</span><span class="metric-value">${site.bounce_rate}</span></div>
                    </div>
                `;
                siteList.appendChild(row);
            });

            // ── Detailed page visits ──────────────────────────────────────────
            const pvContainer = document.getElementById('modal-page-visits');
            const pvTitle     = document.getElementById('modal-pv-title');
            pvContainer.innerHTML = '';

            if (!user.page_visits || user.page_visits.length === 0) {
                pvTitle.style.display = 'none';
                pvContainer.innerHTML = '';
            } else {
                pvTitle.style.display = '';
                pvTitle.innerText = `Recent Page Visits (${user.page_visits.length})`;

                const uniqueVisits = Array.from(
                    new Map(
                        user.page_visits.map(v => [
                            `${v.full_url}-${v.visited_at}`,
                            v
                        ])
                    ).values()
                );

            uniqueVisits.forEach(pv => {
                    const card     = document.createElement('div');
                    card.className = 'site-row';
                    let iconLabel = '🌐';
                    let detailHtml = '';

                    if (pv.content_type === 'YouTube Video') {
                        iconLabel = '▶️';
                        const vid = pv.extra_info?.video_title || pv.page_title;
                        const vid_id = pv.extra_info?.video_id || '';
                        detailHtml = `
                            <div style="font-size:13px;font-weight:600;color:#a78bfa;margin:4px 0 2px;">
                                ${vid}
                            </div>
                            ${vid_id ? `<div style="font-size:11px;color:var(--text-muted);">Video ID: ${vid_id}</div>` : ''}
                        `;
                    } else if (pv.content_type === 'Article') {
                        iconLabel = '📰';
                        const headline = pv.extra_info?.headline || pv.page_title;
                        detailHtml = `<div style="font-size:13px;color:#94a3b8;margin:4px 0 2px;">${headline}</div>`;
                    } else {
                        detailHtml = `<div style="font-size:12px;color:var(--text-muted);margin:3px 0;">${pv.page_title}</div>`;
                    }

                    const truncUrl = pv.full_url.length > 70
                        ? pv.full_url.slice(0, 67) + '...'
                        : pv.full_url;

                    card.innerHTML = `
                        <div class="site-row-top">
                            <span class="site-domain">${iconLabel} ${pv.domain}</span>
                            <span class="site-category" style="background:${pvTypeBadgeColor(pv.content_type)}">${pv.content_type}</span>
                        </div>
                        ${detailHtml}
                        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
                            <a href="${pv.full_url}" target="_blank" style="color:#60a5fa;text-decoration:none;" title="${pv.full_url}">${truncUrl}</a>
                        </div>
                        <div class="site-metrics">
                            <div class="metric-item"><span class="metric-label">Visited</span><span class="metric-value" style="font-size:11px;">${pv.visited_at}</span></div>
                            <div class="metric-item"><span class="metric-label">Time</span><span class="metric-value">${pv.time_spent}</span></div>
                            <div class="metric-item"><span class="metric-label">Clicks</span><span class="metric-value">${pv.clicks}</span></div>
                            <div class="metric-item"><span class="metric-label">Scroll</span><span class="metric-value">${pv.scroll_depth}</span></div>
                        </div>
                    `;
                    pvContainer.appendChild(card);
                });
            }

            document.getElementById('modal-overlay').classList.remove('hidden');
        });
}

function pvTypeBadgeColor(type) {
    const map = {
        'YouTube Video': '#d8ff29',
        'Article':       '#8feb25',
        'Streaming':     '#4fed3a',
        'Webpage':       '#34ee1b',
    };
    return map[type] || '#374151';
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    currentModalUserId = null;
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function initSettings() {
    document.getElementById('btn-save-settings').addEventListener('click', () => {
        showToast('✅ Settings saved successfully!');
    });

    document.getElementById('btn-export-all').addEventListener('click', () => {
        fetch('/api/dashboard/users')
            .then(r => r.json())
            .then(data => {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href     = url;
                a.download = 'all_users_export.json';
                a.click();
                URL.revokeObjectURL(url);
                showToast('📥 Export started!');
            });
    });
}

// ── AUTO-REFRESH (every 2 minutes) ────────────────────────────────────────────
function startAutoRefresh() {
    updateLastRefreshTime();

    setInterval(async () => {
        try {
            await loadKPIs();
            await loadUsers();

            // Silently refresh open modal if one is active
            const overlay = document.getElementById('modal-overlay');
            if (currentModalUserId && !overlay.classList.contains('hidden')) {
                openModal(currentModalUserId, true);
            }

            updateLastRefreshTime();
            showToast('🔄 Dashboard auto-refreshed');
        } catch (_) {
            // Network issue — don't crash
        }
    }, AUTO_REFRESH_MS);
}

function updateLastRefreshTime() {
    const el = document.getElementById('last-refresh');
    if (!el) return;
    const now = new Date();
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    el.textContent = `🔁 Refreshed ${time}`;
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast     = document.createElement('div');
    toast.className = 'toast';
    toast.innerText = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
/**
 * Web admin panel UI (ADR-0081) — the worker-served static surface.
 *
 * Three routes, no build step, no dependency:
 *   GET /admin        → ADMIN_SHELL_HTML (the shell + Telegram widget)
 *   GET /admin/app.js → ADMIN_APP_JS (the vanilla SPA)
 *   GET /admin/app.css → ADMIN_APP_CSS (yellow + a bit pixelly)
 *
 * The shell carries no data: every value on screen comes from
 * /api/admin/* after the session is verified. All server strings are
 * escaped before they reach innerHTML (the `esc` helper in app.js).
 * No inline script, no inline style, no inline event handlers — the
 * CSP allows only `script-src 'self' https://telegram.org`, so the
 * Telegram Login Widget is the only external script and every
 * interaction runs through one delegated click listener.
 *
 * Copy is the bot panel v2 design doc's terse English (§§2–17), 1:1.
 */
export const TELEGRAM_BOT_USERNAME = 'Pixel_IVbot';

export const ADMIN_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pixel Admin</title>
<link rel="stylesheet" href="/admin/app.css">
<script src="/admin/app.js"></script>
<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="Pixel_IVbot" data-size="large" data-onauth="onTelegramAuth(user)" data-request-access="write"></script>
</head>
<body>
<div id="app"><p class="loading">Loading…</p></div>
<div id="toast" role="status" aria-live="polite"></div>
<noscript><p class="loading">Pixel Admin needs JavaScript.</p></noscript>
</body>
</html>
`;

export const ADMIN_APP_CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: #fff8d6; color: #111; font-family: "Courier New", ui-monospace, monospace; font-size: 15px; line-height: 1.5; }
#app { max-width: 720px; margin: 0 auto; padding: 16px 12px 64px; }
header { background: #ffd400; border: 3px solid #111; box-shadow: 4px 4px 0 #111; padding: 10px 12px; margin-bottom: 12px; }
header h1 { margin: 0; font-size: 20px; letter-spacing: 2px; text-transform: uppercase; }
header .who { font-size: 13px; margin-top: 2px; }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
nav button, .btn { font: inherit; background: #fff; color: #111; border: 2px solid #111; box-shadow: 2px 2px 0 #111; padding: 6px 10px; cursor: pointer; }
nav button.active { background: #ffd400; }
button:disabled { opacity: .45; cursor: default; }
.btn { display: inline-block; margin: 2px 4px 2px 0; }
.btn.primary { background: #ffd400; }
.btn.danger { background: #ff5a5a; color: #fff; }
.card { background: #fff; border: 2px solid #111; box-shadow: 3px 3px 0 #111; padding: 10px 12px; margin-bottom: 10px; }
.card h2 { margin: 0 0 6px; font-size: 16px; text-transform: uppercase; letter-spacing: 1px; }
.card h3 { margin: 8px 0 4px; font-size: 14px; }
.row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; }
.row .k { color: #555; }
.muted { color: #555; font-size: 13px; }
.small { font-size: 13px; }
pre.soul { white-space: pre-wrap; word-break: break-word; background: #fff8d6; border: 2px solid #111; padding: 8px; margin: 6px 0; max-height: 320px; overflow: auto; }
input, select { font: inherit; border: 2px solid #111; padding: 6px 8px; background: #fff; max-width: 100%; }
.loading { text-align: center; padding: 40px 0; }
#toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: #111; color: #ffd400; padding: 8px 14px; border: 2px solid #ffd400; font-size: 14px; display: none; z-index: 10; max-width: 90vw; }
#toast.show { display: block; }
.pill { display: inline-block; border: 2px solid #111; padding: 0 6px; font-size: 12px; background: #fff8d6; }
.pill.on { background: #ffd400; }
.pill.off { background: #eee; }
`;

export const ADMIN_APP_JS = `
(function () {
  'use strict';
  var screens = ['dashboard', 'queue', 'posts', 'schedule', 'soul', 'stats', 'admins', 'manual', 'providers', 'debug'];
  var labels = { dashboard: 'Dashboard', queue: 'Queue', posts: 'Posts', schedule: 'Schedule', soul: 'Soul', stats: 'Stats', admins: 'Admins', manual: 'Manual', providers: 'Providers', debug: 'Debug' };
  var me = null;
  var screen = 'dashboard';
  var soulOpen = false;
  var toastTimer = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDate(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Tehran', day: '2-digit', month: 'short' });
  }
  function api(path, opts) {
    return fetch(path, {
      method: (opts && opts.method) || 'GET',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) { me = null; render(); return null; }
      return res.json().then(function (body) { return { status: res.status, body: body }; });
    }).catch(function () { toast('Network error'); return null; });
  }
  function unavailable(res) {
    if (res && res.body && res.body.available === false) { toast('Not available'); return true; }
    return false;
  }
  function denied(res) {
    if (res && res.status === 403) { toast('Not allowed'); return true; }
    return false;
  }

  function headerHtml() {
    var who = me ? esc(me.firstName || ('user ' + me.userId)) + ' · ' + esc(me.role) : '';
    return '<header><h1>Pixel Admin</h1><div class="who">' + who +
      ' <button class="btn small" data-action="logout">Log out</button></div></header>';
  }
  function navHtml() {
    var html = '<nav>';
    screens.forEach(function (s) {
      html += '<button data-action="nav" data-screen="' + s + '"' + (s === screen ? ' class="active"' : '') + '>' + labels[s] + '</button>';
    });
    return html + '</nav>';
  }
  function loginHtml() {
    return '<header><h1>Pixel Admin</h1></header>' +
      '<div class="card"><h2>Sign in</h2>' +
      '<p>Sign in with Telegram to manage Pixel.</p>' +
      '<div id="telegram-login"></div>' +
      '<p class="muted">Only the owner and the admins can sign in. The session lasts 24 hours.</p></div>';
  }
  function mountWidget() {
    var slot = $('telegram-login');
    if (!slot) return;
    var scripts = document.querySelectorAll('script[data-telegram-login]');
    if (scripts.length > 0) slot.appendChild(scripts[0]);
  }

  function dashboardHtml(d) {
    var botOn = d.mode !== 'paused';
    var last = d.lastChange ? esc(d.lastChange.action) + ' · ' + fmtTime(d.lastChange.createdAt) : '—';
    return '<div class="card"><h2>Dashboard</h2>' +
      '<div class="row"><span class="k">Bot</span><span><span class="pill ' + (botOn ? 'on' : 'off') + '">' + (botOn ? 'ON' : 'OFF') + '</span> ' +
      '<button class="btn small" data-action="toggle-bot" data-mode="' + esc(d.mode) + '">' + (botOn ? 'Turn off' : 'Turn on') + '</button></span></div>' +
      '<div class="row"><span class="k">Mode</span><span>' + esc(d.mode) + '</span></div>' +
      '<div class="row"><span class="k">Cap</span><span>' + d.today.counted + '/' + d.effectiveCap + ' today</span></div>' +
      '<div class="row"><span class="k">Queue</span><span>' + d.queue.readyDrafts + ' ready · ' + d.queue.pendingPublications + ' pending</span></div>' +
      '<div class="row"><span class="k">Soul</span><span>v' + (d.soulVersion == null ? '—' : d.soulVersion) + '</span></div>' +
      '<div class="row"><span class="k">Providers</span><span>' + d.providers.enabled + '/' + d.providers.total + '</span></div>' +
      '<div class="row"><span class="k">Next tick</span><span>~' + d.nextTickInMinutes + ' min</span></div>' +
      '<div class="row"><span class="k">Last change</span><span>' + last + '</span></div></div>';
  }

  function queueHtml(q) {
    var html = '<div class="card"><h2>Queue</h2>';
    html += '<h3>Ready drafts (' + q.counts.ready + ')</h3>';
    if (q.drafts.length === 0) html += '<p class="muted">No ready drafts.</p>';
    q.drafts.forEach(function (dft) {
      html += '<div class="row"><span><strong>' + esc(dft.headline || '(no headline)') + '</strong><br>' +
        '<span class="muted">' + esc(dft.summary || '') + '</span></span>' +
        '<span><button class="btn small" data-action="preview" data-id="' + esc(dft.id) + '">Preview</button>' +
        '<button class="btn small primary" data-action="approve" data-id="' + esc(dft.id) + '">Approve</button>' +
        '<button class="btn small danger" data-action="reject" data-id="' + esc(dft.id) + '">Reject</button></span></div>';
    });
    html += '<h3>Scheduled (' + q.counts.pending + ')</h3>';
    if (q.publications.length === 0) html += '<p class="muted">Nothing scheduled.</p>';
    q.publications.forEach(function (p) {
      html += '<div class="row"><span>' + esc(p.id) + '<br><span class="muted">' + esc(p.status) + ' · pri ' + p.priority +
        ' · run ' + fmtTime(p.runAfter) + ' · tries ' + p.attempts + '/' + p.maxAttempts + '</span></span>' +
        '<span><button class="btn small" data-action="send-now" data-id="' + esc(p.id) + '">Send now</button>' +
        '<button class="btn small danger" data-action="cancel-pub" data-id="' + esc(p.id) + '">Cancel</button></span></div>';
    });
    html += '<p><button class="btn danger" data-action="clear-queue">Clear queue</button></p></div>';
    html += '<div class="card" id="preview-card" style="display:none"></div>';
    return html;
  }

  function previewHtml(p) {
    var html = '<h3>Preview</h3>';
    html += '<p><strong>' + esc(p.headline || '(no headline)') + '</strong></p>';
    if (p.summary) html += '<p>' + esc(p.summary) + '</p>';
    if (p.sourceName) html += '<p class="muted">Source: ' + esc(p.sourceName) + '</p>';
    if (p.claims && p.claims.length > 0) {
      html += '<p>Claims (' + p.claims.length + '):</p><ul>';
      p.claims.forEach(function (c) { html += '<li>' + esc(c.text) + ' <span class="muted">[' + esc(c.status) + ']</span></li>'; });
      html += '</ul>';
    }
    if (p.verdict) html += '<p>Verdict: ' + esc(p.verdict) + '</p>';
    if (p.rewriteStatus) html += '<p class="muted">Rewrite: ' + esc(p.rewriteStatus) + '</p>';
    return html;
  }

  function postsHtml(p) {
    var html = '<div class="card"><h2>Posts</h2>';
    if (p.posts.length === 0) html += '<p class="muted">No posts yet.</p>';
    p.posts.forEach(function (post) {
      html += '<div class="row"><span>' + esc(post.title || '(no title)') + '<br><span class="muted">' + esc(post.category) +
        ' · ' + fmtDate(post.publishedAtMs) + ' ' + fmtTime(post.publishedAtMs) + (post.pinned ? ' · pinned' : '') + (post.expired ? ' · expired' : '') + '</span></span>' +
        '<span>' + (post.pinned
          ? '<button class="btn small" data-action="unpin" data-id="' + post.channelMessageId + '">Unpin</button>'
          : '<button class="btn small" data-action="pin" data-ref-type="' + esc(post.refType) + '" data-ref-id="' + esc(post.refId) + '" data-id="' + post.channelMessageId + '">Pin</button>') +
        '<button class="btn small" data-action="edit-post" data-ref-type="' + esc(post.refType) + '" data-ref-id="' + esc(post.refId) + '" data-id="' + post.channelMessageId + '">Edit</button>' +
        '<button class="btn small danger" data-action="delete-post" data-ref-type="' + esc(post.refType) + '" data-ref-id="' + esc(post.refId) + '" data-id="' + post.channelMessageId + '">Delete</button></span></div>';
    });
    html += '<div class="row"><span class="k">Auto-pin P0</span><span><span class="pill ' + (p.autoPinEnabled ? 'on' : 'off') + '">' + (p.autoPinEnabled ? 'ON' : 'OFF') + '</span> ' +
      '<button class="btn small" data-action="toggle-autopin" data-on="' + (p.autoPinEnabled ? '1' : '0') + '">' + (p.autoPinEnabled ? 'Turn off' : 'Turn on') + '</button></span></div>';
    html += '<div class="row"><span class="k">Retention</span><span><span class="pill ' + (p.retention.enabled ? 'on' : 'off') + '">' + (p.retention.enabled ? 'ON' : 'OFF') + '</span> ' +
      esc(p.retention.defaultDays) + 'd / free ' + esc(p.retention.freeGameDays) + 'd ' +
      '<button class="btn small" data-action="toggle-retention" data-on="' + (p.retention.enabled ? '1' : '0') + '" data-default="' + p.retention.defaultDays + '" data-free="' + p.retention.freeGameDays + '">' + (p.retention.enabled ? 'Turn off' : 'Turn on') + '</button></span></div></div>';
    return html;
  }

  function scheduleHtml(s) {
    var html = '<div class="card"><h2>Schedule</h2>';
    html += '<div class="row"><span class="k">Mode</span><span>';
    ['auto', 'paused', 'approval'].forEach(function (m) {
      html += '<button class="btn small' + (s.mode === m ? ' primary' : '') + '" data-action="set-mode" data-mode="' + m + '">' + m + '</button>';
    });
    html += '</span></div>';
    html += '<div class="row"><span class="k">Cap</span><span><input id="cap-input" type="number" min="1" max="30" value="' + s.cap + '" style="width:80px"> ' +
      '<button class="btn small" data-action="set-cap">Save</button> <span class="muted">effective ' + s.effectiveCap + '</span></span></div>';
    html += '<div class="row"><span class="k">Event</span><span><span class="pill ' + (s.eventActive ? 'on' : 'off') + '">' + (s.eventActive ? 'ON' : 'OFF') + '</span> ' +
      '<button class="btn small" data-action="toggle-event" data-on="' + (s.eventActive ? '1' : '0') + '">' + (s.eventActive ? 'Turn off' : 'Turn on') + '</button></span></div>';
    html += '<div class="row"><span class="k">Today</span><span>' + s.today.counted + ' counted · ' + s.today.p0Bypass + ' P0 · ' + s.today.owner + ' owner</span></div>';
    html += '<div class="row"><span class="k">Next tick</span><span>~' + s.nextTickInMinutes + ' min</span></div>';
    html += '<p><button class="btn" data-action="force-tick">Force tick</button></p></div>';
    return html;
  }

  function soulHtml(s) {
    var html = '<div class="card"><h2>Soul &amp; Memory</h2>';
    html += '<div class="row"><span class="k">Soul</span><span>v' + (s.soulVersion == null ? '—' : s.soulVersion) + '</span></div>';
    html += '<p><button class="btn small" data-action="toggle-soul">View full</button> ' +
      '<button class="btn small" data-action="reload-soul">Reload</button> ' +
      '<button class="btn small" data-action="test-ai">Test AI</button></p>';
    if (soulOpen) html += '<pre class="soul">' + esc(s.soulText || '(no soul text)') + '</pre>';
    html += '<h3>AI today</h3>';
    if (s.aiToday.length === 0) html += '<p class="muted">No AI runs today.</p>';
    s.aiToday.forEach(function (r) {
      html += '<div class="row"><span>' + esc(r.provider) + '</span><span>' + r.runs + ' runs · ' + r.succeeded + ' ok · ' + r.outputTokens + ' tokens</span></div>';
    });
    html += '<h3>Flags</h3>';
    html += '<div class="row"><span class="k">AI</span><span>' + (s.flags.aiEnabled ? 'ON' : 'OFF') + '</span></div>';
    html += '<div class="row"><span class="k">Gemini</span><span>' + (s.flags.geminiEnabled ? 'ON' : 'OFF') + '</span></div>';
    html += '<div class="row"><span class="k">Images</span><span>' + (s.flags.imageEnabled ? 'ON' : 'OFF') + '</span></div>';
    html += '<div class="row"><span class="k">Failover</span><span>' + (s.flags.failoverEnabled ? 'ON' : 'OFF') + '</span></div>';
    html += '</div>';
    return html;
  }

  function statsHtml(s) {
    var html = '<div class="card"><h2>Stats</h2>';
    html += '<div class="row"><span class="k">Stories</span><span>' + s.totals.stories + '</span></div>';
    html += '<div class="row"><span class="k">Drafts</span><span>' + s.totals.drafts + '</span></div>';
    html += '<div class="row"><span class="k">Claims</span><span>' + s.totals.claims + '</span></div>';
    html += '<div class="row"><span class="k">Source items</span><span>' + s.totals.sourceItems + '</span></div>';
    html += '<h3>Drafts by status</h3>';
    html += '<div class="row"><span class="k">ready</span><span>' + s.draftsByStatus.ready + '</span></div>';
    html += '<div class="row"><span class="k">approved</span><span>' + s.draftsByStatus.approved + '</span></div>';
    html += '<div class="row"><span class="k">approval required</span><span>' + s.draftsByStatus.approvalRequired + '</span></div>';
    html += '<div class="row"><span class="k">rejected</span><span>' + s.draftsByStatus.rejected + '</span></div>';
    html += '<h3>Publications</h3>';
    Object.keys(s.publicationsByStatus).forEach(function (k) {
      html += '<div class="row"><span class="k">' + esc(k) + '</span><span>' + s.publicationsByStatus[k] + '</span></div>';
    });
    html += '<h3>AI all time</h3>';
    if (s.aiAllTime.length === 0) html += '<p class="muted">No AI runs yet.</p>';
    s.aiAllTime.forEach(function (r) {
      html += '<div class="row"><span>' + esc(r.provider) + '</span><span>' + r.runs + ' runs · ' + r.outputTokens + ' tokens</span></div>';
    });
    html += '</div>';
    return html;
  }

  function adminsHtml(a) {
    var html = '<div class="card"><h2>Admins</h2>';
    if (!a.manageEnabled) html += '<p class="muted">Read-only — admin management is off.</p>';
    a.admins.forEach(function (admin) {
      html += '<div class="row"><span>' + admin.telegramUserId + ' · ' + esc(admin.role) + ' · ' + esc(admin.status) + '</span>' +
        '<span>' + (a.manageEnabled && admin.status === 'active' ? '<button class="btn small danger" data-action="remove-admin" data-id="' + admin.telegramUserId + '">Remove</button>' : '') + '</span></div>';
    });
    if (a.manageEnabled) {
      html += '<p><input id="add-admin-id" type="number" placeholder="Telegram user id" style="width:180px"> ' +
        '<select id="add-admin-role"><option value="chief_editor">chief_editor</option><option value="source_manager">source_manager</option><option value="reviewer">reviewer</option></select> ' +
        '<button class="btn small primary" data-action="add-admin">Add</button></p>';
    }
    html += '</div>';
    return html;
  }

  function manualHtml(m) {
    var html = '<div class="card"><h2>Manual Post</h2>';
    html += '<p class="muted">Pick a provider to run its pipeline once. Manual trigger needs the bot engine seam — not available yet.</p>';
    html += '<h3>Providers</h3>';
    m.providers.forEach(function (p) {
      html += '<div class="row"><span>' + esc(p.name) + (p.enabled ? '' : ' (off)') + ' · ' + p.readyCount + ' ready</span>' +
        '<span><button class="btn small" data-action="manual-provider" data-id="' + esc(p.id) + '">Trigger</button></span></div>';
    });
    html += '<h3>By category</h3>';
    if (m.categories.length === 0) html += '<p class="muted">No ready drafts.</p>';
    m.categories.forEach(function (c) {
      html += '<div class="row"><span>' + esc(c.contentType) + ' · ' + c.count + ' ready</span>' +
        '<span><button class="btn small" data-action="manual-category" data-id="' + esc(c.contentType) + '">Trigger</button></span></div>';
    });
    html += '<p><button class="btn" data-action="manual-dry-run">Dry run</button></p></div>';
    return html;
  }

  function providersHtml(p) {
    var html = '<div class="card"><h2>Providers</h2>';
    html += '<p><button class="btn small" data-action="test-all">Test all sources</button> ' +
      '<button class="btn small" data-action="health-all">Health check all</button> <span class="muted">' + p.healthy + '/' + p.enabled + ' healthy</span></p>';
    p.providers.forEach(function (prov) {
      html += '<div class="row"><span><strong>' + esc(prov.name) + '</strong> <span class="muted">' + esc(prov.connector) + ' · ' + esc(prov.lane) + ' · ' + esc(prov.trustTier) + '</span><br>' +
        '<span class="muted">items ' + prov.itemsTotal + ' · ready ' + prov.readyCount + ' · published ' + prov.publishedCount +
        (prov.lastError ? ' · error: ' + esc(prov.lastError) : '') + '</span></span>' +
        '<span><span class="pill ' + (prov.enabled ? 'on' : 'off') + '">' + (prov.enabled ? 'ON' : 'OFF') + '</span> ' +
        '<button class="btn small" data-action="toggle-provider" data-id="' + esc(prov.id) + '" data-on="' + (prov.enabled ? '1' : '0') + '">' + (prov.enabled ? 'Turn off' : 'Turn on') + '</button></span></div>';
    });
    html += '</div>';
    return html;
  }

  function debugHtml(d) {
    var last = d.lastChange ? esc(d.lastChange.action) + ' · ' + fmtTime(d.lastChange.createdAt) : '—';
    var html = '<div class="card"><h2>Debug</h2>';
    html += '<div class="row"><span class="k">Version</span><span>' + esc(d.build.version) + ' · ' + esc(d.build.commit) + '</span></div>';
    html += '<div class="row"><span class="k">Schema</span><span>' + d.build.schema + '</span></div>';
    html += '<div class="row"><span class="k">Mode</span><span>' + esc(d.mode) + '</span></div>';
    html += '<div class="row"><span class="k">Stories</span><span>' + d.totals.stories + '</span></div>';
    html += '<div class="row"><span class="k">Drafts</span><span>' + d.totals.drafts + '</span></div>';
    html += '<div class="row"><span class="k">Claims</span><span>' + d.totals.claims + '</span></div>';
    html += '<div class="row"><span class="k">AI</span><span>' + (d.flags.aiEnabled ? 'ON' : 'OFF') + ' · Gemini ' + (d.flags.geminiEnabled ? 'ON' : 'OFF') + ' · images ' + (d.flags.imageEnabled ? 'ON' : 'OFF') + ' · failover ' + (d.flags.failoverEnabled ? 'ON' : 'OFF') + '</span></div>';
    html += '<div class="row"><span class="k">Admin manage</span><span>' + (d.adminManageEnabled ? 'ON' : 'OFF') + '</span></div>';
    html += '<div class="row"><span class="k">Last change</span><span>' + last + '</span></div>';
    html += '<p class="muted">No last-tick readout exists yet — the bridge tick leaves no stored marker. Last change above is the latest audit event.</p></div>';
    return html;
  }

  function renderScreen() {
    var el = $('app');
    if (!me) { el.innerHTML = loginHtml(); mountWidget(); return; }
    var path = { dashboard: '/api/admin/dashboard', queue: '/api/admin/queue', posts: '/api/admin/posts', schedule: '/api/admin/schedule', soul: '/api/admin/soul', stats: '/api/admin/stats', admins: '/api/admin/admins', manual: '/api/admin/manual', providers: '/api/admin/providers', debug: '/api/admin/debug' }[screen];
    el.innerHTML = headerHtml() + navHtml() + '<p class="loading">Loading…</p>';
    api(path).then(function (res) {
      if (!res) return;
      if (denied(res)) { el.innerHTML = headerHtml() + navHtml() + '<div class="card"><p>Not allowed.</p></div>'; return; }
      if (res.status !== 200) { toast('Failed to load'); return; }
      var body = res.body;
      var html = headerHtml() + navHtml();
      if (screen === 'dashboard') html += dashboardHtml(body);
      else if (screen === 'queue') html += queueHtml(body);
      else if (screen === 'posts') html += postsHtml(body);
      else if (screen === 'schedule') html += scheduleHtml(body);
      else if (screen === 'soul') html += soulHtml(body);
      else if (screen === 'stats') html += statsHtml(body);
      else if (screen === 'admins') html += adminsHtml(body);
      else if (screen === 'manual') html += manualHtml(body);
      else if (screen === 'providers') html += providersHtml(body);
      else if (screen === 'debug') html += debugHtml(body);
      el.innerHTML = html;
    });
  }
  function render() { renderScreen(); }

  function postAction(path, body, done) {
    api(path, { method: 'POST', body: body }).then(function (res) {
      if (!res) return;
      if (unavailable(res)) return;
      if (denied(res)) return;
      if (res.status !== 200) { toast('Failed'); return; }
      var kind = res.body && res.body.kind;
      if (kind === 'denied') { toast('Not allowed'); return; }
      if (kind === 'not_found') { toast('Not found'); return; }
      if (kind === 'not_ready') { toast('Not ready'); return; }
      if (kind === 'invalid' || kind === 'invalid_role' || kind === 'invalid_text') { toast('Invalid'); return; }
      if (kind === 'manage_disabled') { toast('Management off'); return; }
      if (kind === 'owner_protected') { toast('Owner protected'); return; }
      if (kind === 'no_destination') { toast('No channel'); return; }
      if (kind === 'transport_unavailable') { toast('Bot unavailable'); return; }
      if (kind === 'enqueue_failed' || kind === 'pin_failed' || kind === 'unpin_failed' || kind === 'delete_failed' || kind === 'edit_failed') { toast('Failed'); return; }
      if (kind === 'edit_failed_retryable' || kind === 'no_capture') { toast('Try again'); return; }
      if (kind === 'no_change' || kind === 'already_approved' || kind === 'already_rejected' || kind === 'already_active' || kind === 'already_disabled' || kind === 'already_pinned' || kind === 'not_pinned') { toast('No change'); render(); return; }
      toast(kind === 'applied' ? 'Saved' : 'Done');
      if (done) done(res.body);
      render();
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-action]');
    if (!t) return;
    var action = t.getAttribute('data-action');
    if (action === 'nav') { screen = t.getAttribute('data-screen'); render(); return; }
    if (action === 'logout') {
      api('/api/admin/logout', { method: 'POST' }).then(function () { me = null; render(); });
      return;
    }
    if (action === 'toggle-bot') {
      postAction('/api/admin/schedule/mode', { mode: t.getAttribute('data-mode') === 'paused' ? 'auto' : 'paused' });
      return;
    }
    if (action === 'preview') {
      api('/api/admin/drafts/' + encodeURIComponent(t.getAttribute('data-id'))).then(function (res) {
        if (!res || res.status !== 200) { toast('Failed'); return; }
        var card = $('preview-card');
        if (card) { card.style.display = 'block'; card.innerHTML = previewHtml(res.body); }
      });
      return;
    }
    if (action === 'approve') { postAction('/api/admin/drafts/' + encodeURIComponent(t.getAttribute('data-id')) + '/approve', {}); return; }
    if (action === 'reject') {
      if (!window.confirm('Reject this draft?')) return;
      postAction('/api/admin/drafts/' + encodeURIComponent(t.getAttribute('data-id')) + '/reject', {});
      return;
    }
    if (action === 'send-now') { postAction('/api/admin/queue/' + encodeURIComponent(t.getAttribute('data-id')) + '/send-now', {}); return; }
    if (action === 'cancel-pub') {
      if (!window.confirm('Cancel this publication?')) return;
      postAction('/api/admin/queue/' + encodeURIComponent(t.getAttribute('data-id')) + '/cancel', {});
      return;
    }
    if (action === 'clear-queue') {
      if (!window.confirm('Cancel every scheduled publication?')) return;
      postAction('/api/admin/schedule/clear-queue', {});
      return;
    }
    if (action === 'pin') { postAction('/api/admin/posts/pin', { refType: t.getAttribute('data-ref-type'), refId: t.getAttribute('data-ref-id'), channelMessageId: Number(t.getAttribute('data-id')) }); return; }
    if (action === 'unpin') { postAction('/api/admin/posts/unpin', { channelMessageId: Number(t.getAttribute('data-id')) }); return; }
    if (action === 'delete-post') {
      if (!window.confirm('Delete this post from the channel?')) return;
      postAction('/api/admin/posts/delete', { refType: t.getAttribute('data-ref-type'), refId: t.getAttribute('data-ref-id'), channelMessageId: Number(t.getAttribute('data-id')) });
      return;
    }
    if (action === 'edit-post') {
      var text = window.prompt('New post text:');
      if (text === null) return;
      postAction('/api/admin/posts/edit', { refType: t.getAttribute('data-ref-type'), refId: t.getAttribute('data-ref-id'), channelMessageId: Number(t.getAttribute('data-id')), text: text });
      return;
    }
    if (action === 'toggle-autopin') { postAction('/api/admin/posts/settings/auto-pin', { enabled: t.getAttribute('data-on') !== '1' }); return; }
    if (action === 'toggle-retention') {
      postAction('/api/admin/posts/settings/retention', { rule: { enabled: t.getAttribute('data-on') !== '1', defaultDays: Number(t.getAttribute('data-default')), freeGameDays: Number(t.getAttribute('data-free')) } });
      return;
    }
    if (action === 'set-mode') { postAction('/api/admin/schedule/mode', { mode: t.getAttribute('data-mode') }); return; }
    if (action === 'set-cap') {
      var cap = Number(($('cap-input') || {}).value);
      postAction('/api/admin/schedule/cap', { cap: cap });
      return;
    }
    if (action === 'toggle-event') { postAction('/api/admin/schedule/event', { active: t.getAttribute('data-on') !== '1' }); return; }
    if (action === 'force-tick') { postAction('/api/admin/schedule/force-tick', {}); return; }
    if (action === 'toggle-soul') { soulOpen = !soulOpen; render(); return; }
    if (action === 'reload-soul') { render(); return; }
    if (action === 'test-ai') { postAction('/api/admin/soul/test-ai', {}); return; }
    if (action === 'add-admin') {
      var id = Number(($('add-admin-id') || {}).value);
      var role = ($('add-admin-role') || {}).value;
      if (!id) { toast('Invalid'); return; }
      postAction('/api/admin/admins', { targetUserId: id, targetRole: role });
      return;
    }
    if (action === 'remove-admin') {
      if (!window.confirm('Remove this admin?')) return;
      postAction('/api/admin/admins/' + encodeURIComponent(t.getAttribute('data-id')) + '/remove', {});
      return;
    }
    if (action === 'manual-provider') { postAction('/api/admin/manual/provider/' + encodeURIComponent(t.getAttribute('data-id')), {}); return; }
    if (action === 'manual-category') { postAction('/api/admin/manual/category/' + encodeURIComponent(t.getAttribute('data-id')), {}); return; }
    if (action === 'manual-dry-run') { postAction('/api/admin/manual/dry-run', {}); return; }
    if (action === 'toggle-provider') { postAction('/api/admin/providers/' + encodeURIComponent(t.getAttribute('data-id')) + '/toggle', { enabled: t.getAttribute('data-on') !== '1' }); return; }
    if (action === 'test-all' || action === 'health-all') {
      api('/api/admin/providers').then(function (res) {
        if (!res || res.status !== 200) { toast('Failed'); return; }
        toast(res.body.healthy + '/' + res.body.enabled + ' healthy');
        render();
      });
      return;
    }
  });

  window.onTelegramAuth = function (user) {
    api('/api/admin/auth', { method: 'POST', body: user }).then(function (res) {
      if (!res) return;
      if (res.status === 401) { toast('Sign-in failed'); return; }
      if (res.status !== 200) { toast('Sign-in failed'); return; }
      me = res.body;
      render();
    });
  };

  api('/api/admin/me').then(function (res) {
    if (res && res.status === 200) me = res.body;
    render();
  });
})();
`;

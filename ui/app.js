let allProjects = [];
let scanPollTimer = null;

const TYPE_LABELS = {
  python: 'Python', nodejs: 'Node.js', typescript: 'TypeScript',
  electron: 'Electron', react: 'React', nextjs: 'Next.js',
  'react-native': 'React Native', swift: 'Swift', monorepo: 'Monorepo', unknown: 'Unknown',
};

const DAY = 86400000;

const STATUS_DISPLAY = {
  'Active':      'Active',
  'Stale':       'Quiet',
  'Abandoned':   'Dormant',
  'Early Stage': 'New',
};

const STATUS_TOOLTIPS = {
  'Active':      'Commits in the last 30 days',
  'Stale':       'No commits in 30+ days',
  'Abandoned':   'No meaningful activity for a long time — likely shelved',
  'Early Stage': 'Recently created, minimal commits',
};

const TIME_BUCKETS = [
  { label: 'Last 7 days',    max: 7 * DAY,   cssClass: 'bucket-7d' },
  { label: '7 – 14 days ago', max: 14 * DAY,  cssClass: 'bucket-14d' },
  { label: '14 – 30 days ago', max: 30 * DAY, cssClass: 'bucket-30d' },
  { label: '30 – 60 days ago', max: 60 * DAY, cssClass: 'bucket-60d' },
  { label: '60 – 90 days ago', max: 90 * DAY, cssClass: 'bucket-90d' },
  { label: '90 – 120 days ago', max: 120 * DAY, cssClass: 'bucket-120d' },
  { label: 'Older',           max: Infinity,   cssClass: 'bucket-old' },
];

const NO_HISTORY_BUCKET = { label: 'No git history', cssClass: 'bucket-none' };

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Data fetching ---

async function fetchProjects(includeIgnored = false) {
  const res = await fetch(`/api/projects?includeIgnored=${includeIgnored}`);
  return res.json();
}

async function fetchScanStatus() {
  const res = await fetch('/api/scan/status');
  return res.json();
}

async function triggerScan(projectIds, type = 'quick', forceRegenerate = false) {
  const body = { type, forceRegenerate };
  if (projectIds) body.projectIds = projectIds;
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Scan request failed');
  return data;
}

async function fetchCostEstimate() {
  const res = await fetch('/api/scan/cost-estimate');
  return res.json();
}

async function fetchQuickScanPreview() {
  const res = await fetch('/api/scan/quick-preview');
  return res.json();
}

async function ignoreProject(id, ignored) {
  await fetch(`/api/projects/${id}/ignore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ignored }),
  });
}

async function setDeepScanIgnored(id, ignored) {
  await fetch(`/api/projects/${id}/deep-scan-ignore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ignored }),
  });
}

async function stopScan() {
  await fetch('/api/scan/stop', { method: 'POST' });
}

// --- Rendering ---

function formatDate(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < DAY) return 'today';
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))}w ago`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo ago`;
  return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

function parseStatus(summary) {
  if (!summary) return null;
  const match = summary.match(/STATUS:\s*(Active|Stale|Abandoned|Early\s*Stage)/i);
  if (!match) return null;
  return match[1].replace(/\s+/g, ' ').trim();
}

// Status is now computed deterministically server-side and stored on the project.
// Fall back to parsing legacy summaries that still embed a "STATUS:" line.
function projectStatus(p) {
  return p.status || parseStatus(p.summary);
}

// A summary is outdated when the project has changed commit since it was
// generated. No commit hash at all means no version signal (e.g. no git) —
// treated as not outdated, matching needsSummaryRefresh's server-side logic.
function summaryOutdated(p) {
  if (!p.summary) return false;
  if (!p.commit_hash) return false;
  return p.commit_hash !== p.summary_commit_hash;
}

function getSummaryText(summary) {
  if (!summary) return null;
  return summary
    .replace(/\nSTATUS:.*$/s, '')
    .replace(/^#+\s*Project\s*Summary:?\s*/i, '')
    .replace(/^\*\*Project\s*Summary:?\*\*\s*/i, '')
    .replace(/^Project\s*Summary:?\s*/i, '')
    .replace(/^#\s+\S+\s*\n+/i, '') // "# project-name" header
    .replace(/^#+\s*.*summary.*\n*/im, '')
    .trim();
}

function bucketProjects(projects) {
  const now = Date.now();
  const buckets = TIME_BUCKETS.map(b => ({ ...b, projects: [] }));
  const noHistory = { ...NO_HISTORY_BUCKET, projects: [] };

  for (const p of projects) {
    // Projects with no commit history (no git, or git with no commits) have no
    // meaningful position on the activity timeline — bucket them separately
    // rather than treating first_seen_at as recent activity.
    if (!p.last_commit_date) {
      noHistory.projects.push(p);
      continue;
    }
    const age = now - p.last_commit_date;
    for (const bucket of buckets) {
      if (age < bucket.max) {
        bucket.projects.push(p);
        break;
      }
    }
  }

  return [...buckets, noHistory].filter(b => b.projects.length > 0);
}

function renderCard(p) {
  const type = p.type || 'unknown';
  const typeLabel = type !== 'unknown' ? (TYPE_LABELS[type] || type) : null;
  const integrations = Array.isArray(p.integrations) ? p.integrations : [];
  const status = projectStatus(p);
  const statusDisplay = STATUS_DISPLAY[status] || status;
  const summaryText = getSummaryText(p.summary);
  const statusClass = status ? `status-${status.split(' ')[0]}` : '';

  const staleDeps = Array.isArray(p.stale_deps) ? p.stale_deps : [];

  const card = document.createElement('div');
  card.className = `project-card${p.has_uncommitted ? ' has-uncommitted' : ''}${p.ignored ? ' ignored' : ''}`;
  card.dataset.id = p.id;

  const groupTooltip = p.group_name
    ? `Parent directory: ${esc(p.group_name)} inside scan root "${esc(p.root_label || '')}"`
    : `Scan root: ${esc(p.root_label || '')}`;

  const docBadges = [
    p.has_readme ? '<span class="doc-badge-sm doc-readme" title="Project has a README.md file">README</span>' : '',
    p.has_claude_md ? '<span class="doc-badge-sm doc-claude" title="Project has a CLAUDE.md file (Claude Code instructions)">CLAUDE</span>' : '',
  ].filter(Boolean).join('');

  card.innerHTML = `
    <div class="card-header">
      <div>
        <div class="card-title">${esc(p.user_label || p.name)}</div>
        ${p.group_name
          ? `<div class="card-group" title="${groupTooltip}">${esc(p.group_name)} &middot; ${esc(p.root_label || '')}</div>`
          : `<div class="card-group" title="${groupTooltip}">${esc(p.root_label || '')}</div>`}
        ${docBadges ? `<div class="doc-flags-inline">${docBadges}</div>` : ''}
      </div>
      <div class="card-flags">
        ${typeLabel ? `<span class="badge badge-${type}" title="Detected project type">${typeLabel}</span>` : ''}
        ${!p.has_git ? '<span class="flag-no-git" title="No git repository">no git</span>' : p.has_uncommitted ? '<span class="flag-uncommitted" title="Uncommitted changes present">uncommitted</span>' : ''}
        ${staleDeps.length > 0 ? `<span class="flag-outdated" title="${staleDeps.map(d => `${d.name}: ${d.current} → ${d.latest}`).join('\n')}">${staleDeps.length} outdated deps</span>` : ''}
      </div>
    </div>

    ${summaryText
      ? `<div class="card-summary">${renderMarkdown(esc(summaryText))}</div>`
      : `<div class="card-summary no-summary" title="Run a Deep Scan (bucket or project) to generate an AI summary">No summary yet</div>`
    }

    ${status || summaryOutdated(p) ? `<div class="card-status-line">
      ${status ? `<span class="status-pill ${statusClass}" title="${STATUS_TOOLTIPS[status] || ''}">${statusDisplay}</span>` : ''}
      ${summaryOutdated(p) ? '<span class="status-pill status-outdated" title="Project changed since this summary was generated — run a Deep Scan to refresh it">Outdated</span>' : ''}
    </div>` : ''}

    ${integrations.length > 0 ? `
      <div class="card-integrations">
        ${integrations.map(i => `<span class="integration-tag" title="Detected in project dependencies or config files">${esc(i)}</span>`).join('')}
      </div>
    ` : ''}

    <div class="card-meta">
      <span class="meta-commit" title="${p.last_commit_message ? esc(p.last_commit_message) : 'No commits found'}">${p.last_commit_message ? esc(p.last_commit_message.slice(0, 60)) : 'no commits'}</span>
      <span class="meta-date" title="${p.last_commit_date ? 'Last git commit: ' + new Date(p.last_commit_date).toLocaleString() : 'No commit date available'}">${formatDate(p.last_commit_date)}</span>
    </div>
  `;

  card.addEventListener('click', () => openModal(p));
  return card;
}

function renderTimeline(projects) {
  const container = document.getElementById('projectGrid');
  const empty = document.getElementById('emptyState');
  container.innerHTML = '';

  if (projects.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const buckets = bucketProjects(projects);

  for (const bucket of buckets) {
    const section = document.createElement('div');
    section.className = `timeline-section ${bucket.cssClass}`;

    const header = document.createElement('div');
    header.className = 'timeline-header';
    header.innerHTML = `
      <div class="timeline-marker"></div>
      <div class="timeline-label">${bucket.label}</div>
      <div class="timeline-count">${bucket.projects.length} project${bucket.projects.length !== 1 ? 's' : ''}</div>
      <div class="timeline-header-actions">
        <button class="btn-bucket-scan btn-bucket-scan-quick" title="Refresh metadata for this group — free, no AI calls">Quick Scan</button>
        <button class="btn-bucket-scan btn-bucket-scan-deep" title="Generate AI summaries for this group">Deep Scan</button>
      </div>
    `;

    const ids = bucket.projects.map(p => p.id);

    const quickBtn = header.querySelector('.btn-bucket-scan-quick');
    quickBtn.addEventListener('click', () => {
      quickBtn.disabled = true;
      quickBtn.textContent = 'Scanning...';
      setScanUIState(true);
      document.getElementById('scanStatus').textContent = `Quick scanning ${bucket.label} (${ids.length})...`;
      document.getElementById('scanStatus').className = 'scan-status scanning';
      triggerScan(ids, 'quick').then(() => startPolling());
    });

    const deepBtn = header.querySelector('.btn-bucket-scan-deep');
    deepBtn.addEventListener('click', () => openBucketDeepScanConfirm(bucket));

    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'timeline-grid';
    for (const p of bucket.projects) {
      grid.appendChild(renderCard(p));
    }
    section.appendChild(grid);

    container.appendChild(section);
  }
}

function updateStats(visible, total) {
  const bar = document.getElementById('statsBar');
  const uncommitted = allProjects.filter(p => p.has_uncommitted && !p.ignored).length;
  bar.textContent = `${visible} of ${total} projects${uncommitted > 0 ? ` · ${uncommitted} uncommitted` : ''}`;
}

function buildGroupOptions(projects) {
  const groups = [...new Set(projects.map(p => p.group_name).filter(Boolean))].sort();
  const sel = document.getElementById('filterGroup');
  const current = sel.value;
  sel.innerHTML = '<option value="">All groups</option>';
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    sel.appendChild(opt);
  });
  if (current) sel.value = current;
}

function getFiltered() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const type = document.getElementById('filterType').value;
  const group = document.getElementById('filterGroup').value;
  const uncommittedOnly = document.getElementById('filterUncommitted').checked;
  const showIgnored = document.getElementById('filterIgnored').checked;

  return allProjects.filter(p => {
    if (!showIgnored && p.ignored) return false;
    if (uncommittedOnly && !p.has_uncommitted) return false;
    if (type && p.type !== type) return false;
    if (group && p.group_name !== group) return false;
    if (search) {
      const haystack = [p.name, p.user_label, p.group_name, p.root_label,
        p.last_commit_message, p.summary, ...(p.integrations || [])].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function applyFilters() {
  const filtered = getFiltered();
  renderTimeline(filtered);
  updateStats(filtered.length, allProjects.filter(p => !p.ignored).length);
}

// --- Modal ---

function openModal(p) {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modalContent');
  const integrations = Array.isArray(p.integrations) ? p.integrations : [];
  const languages = Array.isArray(p.languages) ? p.languages : [];
  const status = projectStatus(p);
  const statusDisplay = STATUS_DISPLAY[status] || status;
  const summaryText = getSummaryText(p.summary);
  const statusClass = status ? `status-${status.split(' ')[0]}` : '';
  const modalTypeLabel = p.type && p.type !== 'unknown' ? (TYPE_LABELS[p.type] || p.type) : null;

  content.innerHTML = `
    <button class="modal-close" id="modalClose">&times;</button>
    <div class="modal-title">${esc(p.user_label || p.name)}</div>
    <div class="modal-path">
      <span>${esc(p.path)}</span>
      <button class="path-action" id="btnCopyPath" title="Copy path to clipboard">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25z"/></svg>
      </button>
      <button class="path-action" id="btnOpenFinder" title="Reveal in Finder">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 0A1.75 1.75 0 000 1.75v12.5C0 15.216.784 16 1.75 16h12.5A1.75 1.75 0 0016 14.25V1.75A1.75 1.75 0 0014.25 0zm.25 1.75a.25.25 0 01.25-.25h4.5a.25.25 0 01.25.25v2.5a.25.25 0 01-.25.25h-4.5a.25.25 0 01-.25-.25zm0 4.5a.25.25 0 01.25-.25h4.5a.25.25 0 01.25.25v2.5a.25.25 0 01-.25.25h-4.5a.25.25 0 01-.25-.25zm6 0a.25.25 0 01.25-.25h4.5a.25.25 0 01.25.25v2.5a.25.25 0 01-.25.25h-4.5a.25.25 0 01-.25-.25z"/></svg>
      </button>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
      ${modalTypeLabel ? `<span class="badge badge-${p.type}">${modalTypeLabel}</span>` : ''}
      ${p.has_uncommitted ? '<span class="flag-uncommitted">uncommitted changes</span>' : ''}
      ${status ? `<span class="status-pill ${statusClass}" title="${STATUS_TOOLTIPS[status] || ''}">${statusDisplay}</span>` : ''}
      ${summaryOutdated(p) ? '<span class="status-pill status-outdated" title="Project changed since this summary was generated">Outdated</span>' : ''}
      ${p.deep_scan_ignored ? '<span class="status-pill status-Abandoned" title="This project is excluded from Deep Scan AI summaries">Skipping AI</span>' : ''}
    </div>

    <div class="modal-section">
      <div class="modal-section-label">Summary</div>
      <div class="modal-section-body" id="modalSummary">${summaryText ? renderMarkdown(esc(summaryText)) : '<span style="color:var(--text-muted);font-style:italic">No summary yet — run a Deep Scan to generate one.</span>'}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-label">Details</div>
      <div class="modal-section-body">
        <table style="border-collapse:collapse;width:100%;">
          ${p.group_name ? row('Group', p.group_name) : ''}
          ${row('Scan root', p.root_label || '—')}
          ${row('Languages', languages.join(', ') || '—')}
          ${row('Branch', p.branch || '—')}
          ${row('Last commit', p.last_commit_date
            ? `${new Date(p.last_commit_date).toLocaleString()}${p.last_commit_message ? ` &mdash; <span style="color:var(--text-muted)">${esc(p.last_commit_message)}</span>` : ''}`
            : '—', true)}
          ${row('Recent commits', p.commit_count_30d || 0)}
          ${row('Docs', [p.has_readme ? 'README.md' : null, p.has_claude_md ? 'CLAUDE.md' : null].filter(Boolean).join(', ') || 'none')}
          ${Array.isArray(p.stale_deps) && p.stale_deps.length > 0 ? row('Outdated deps', p.stale_deps.map(d => `${d.name} ${d.current}→${d.latest}`).join(', ')) : ''}
        </table>
      </div>
    </div>

    ${integrations.length > 0 ? `
      <div class="modal-section">
        <div class="modal-section-label">Integrations</div>
        <div class="card-integrations" style="margin:0">
          ${integrations.map(i => `<span class="integration-tag">${esc(i)}</span>`).join('')}
        </div>
      </div>
    ` : ''}

    <div class="modal-actions">
      <button class="btn btn-secondary" id="btnQuickScanProject" title="Refresh git/dependency metadata for this project — free, no AI calls">Quick Scan</button>
      <button class="btn btn-primary" id="btnDeepScanProject" title="Generate a fresh AI summary for this project">Deep Scan</button>
      <button class="btn btn-ai-chat" id="btnAIChat" style="margin-left:auto">AI Chat</button>
    </div>
    <div class="modal-settings-row">
      <span class="modal-settings-label">Project settings</span>
      <div class="modal-settings-toggles">
        <button class="btn-flag-toggle" id="btnDeepScanIgnoreToggle" title="Excludes this project from Deep Scan AI summaries — metadata still refreshes normally">
          ${p.deep_scan_ignored ? 'Include in Deep Scans' : 'Skip AI summaries'}
        </button>
        <button class="btn-flag-toggle" id="btnIgnoreToggle" title="Hides this project from the dashboard entirely">
          ${p.ignored ? 'Unignore project' : 'Ignore project'}
        </button>
      </div>
    </div>
  `;

  modal.style.display = 'flex';

  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalBackdrop').onclick = closeModal;

  document.getElementById('btnCopyPath').onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(p.path).then(() => {
      const btn = document.getElementById('btnCopyPath');
      btn.title = 'Copied!';
      setTimeout(() => { btn.title = 'Copy path to clipboard'; }, 1500);
    });
  };

  document.getElementById('btnOpenFinder').onclick = (e) => {
    e.stopPropagation();
    fetch('/api/open-finder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p.path }),
    });
  };

  document.getElementById('btnAIChat').onclick = () => {
    openChat(p);
  };

  document.getElementById('btnQuickScanProject').onclick = () => {
    const btn = document.getElementById('btnQuickScanProject');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    triggerScan([p.id], 'quick').then(() => pollProjectScan(p.id, btn, 'Scanning...'));
  };

  document.getElementById('btnDeepScanProject').onclick = () => openProjectDeepScanConfirm(p);

  document.getElementById('btnDeepScanIgnoreToggle').onclick = async () => {
    await setDeepScanIgnored(p.id, !p.deep_scan_ignored);
    closeModal();
    await reload();
  };

  document.getElementById('btnIgnoreToggle').onclick = async () => {
    await ignoreProject(p.id, !p.ignored);
    closeModal();
    await reload();
  };
}

// Polls scan status until it finishes, updating `btn`'s label, then reloads
// and reopens the project's modal so the refreshed data is visible.
function pollProjectScan(projectId, btn, analyzingLabel) {
  const poll = setInterval(async () => {
    const s = await fetchScanStatus();
    if (s.progress && btn) {
      const phase = s.progress.phase;
      if (phase === 'analyzing') btn.textContent = analyzingLabel;
      else if (phase === 'summarizing') btn.textContent = 'Generating summary...';
    }
    if (!s.inProgress) {
      clearInterval(poll);
      await reload();
      const updated = allProjects.find(x => x.id === projectId);
      if (updated) openModal(updated);
    }
  }, 1000);
}

function row(label, value, raw) {
  return `<tr>
    <td style="padding:3px 12px 3px 0;color:var(--text-muted);font-size:11px;white-space:nowrap;vertical-align:top">${label}</td>
    <td style="padding:3px 0;font-size:12px;color:var(--text-dim)">${raw ? String(value) : esc(String(value))}</td>
  </tr>`;
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  closeChat();
}

// --- Deep Scan confirmation ---
// Deep Scan never fires from a single click without review: bucket scans show a
// checklist (large groups may not need every project touched), single-project
// scans show a lightweight confirm. Both show a real historical cost estimate
// rather than a fabricated per-project "complexity" score, since AI summary
// cost is flat per project (bounded prompt) — see summarizer/index.js.

function closeScanConfirm() {
  document.getElementById('scanConfirmModal').style.display = 'none';
}

// formatDate() collapses anything under a day to "today", which is exactly the
// resolution that matters when deciding whether a rescan is worth it.
function formatAgoPrecise(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

function formatDuration(ms) {
  if (ms == null) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// Below this, a rescan is very unlikely to surface anything new — the popup says
// so plainly instead of silently letting the user re-walk the whole tree.
const QUICK_SCAN_FRESH_MS = 6 * 3600000;

// Fleet-wide Quick Scan confirmation. Free (no AI calls), but it re-walks every
// scan root and can re-run dependency checks, so the popup answers "is this
// even needed?" before it starts.
async function openQuickScanConfirm() {
  const modal = document.getElementById('scanConfirmModal');
  const content = document.getElementById('scanConfirmContent');

  let preview;
  try {
    preview = await fetchQuickScanPreview();
  } catch {
    preview = null;
  }

  const last = preview?.lastFleetQuickScan;
  const fresh = last?.finished_at && (Date.now() - last.finished_at) < QUICK_SCAN_FRESH_MS;

  let freshnessHtml;
  if (last?.finished_at) {
    const bits = [`found ${last.projects_found} project${last.projects_found !== 1 ? 's' : ''}`];
    const took = formatDuration(last.finished_at - last.started_at);
    if (took) bits.push(`took ${took}`);
    freshnessHtml = `
      <div class="scan-freshness ${fresh ? 'is-fresh' : ''}">
        <div><strong>Last full Quick Scan: ${formatAgoPrecise(last.finished_at)}</strong> — ${bits.join(', ')}.</div>
        ${fresh ? '<div class="scan-freshness-hint">Nothing has likely changed since — you can probably skip this.</div>' : ''}
      </div>`;
  } else if (preview?.lastAnyScan?.finished_at) {
    freshnessHtml = `
      <div class="scan-freshness">
        <div><strong>No full Quick Scan on record.</strong></div>
        <div class="scan-freshness-hint">Last scan of any kind was ${formatAgoPrecise(preview.lastAnyScan.finished_at)}. Full-fleet runs have only been tracked separately since this version.</div>
      </div>`;
  } else {
    freshnessHtml = `
      <div class="scan-freshness">
        <div><strong>Never scanned.</strong></div>
        <div class="scan-freshness-hint">This is the first run — it will build the project list from scratch.</div>
      </div>`;
  }

  const roots = preview?.scanRoots || [];
  const rootsHtml = roots.length
    ? roots.map(r => `<div class="settings-kv"><span class="settings-key">${esc(r.label)}</span><span class="settings-val">${esc(r.path)}</span></div>`).join('')
    : '<div class="settings-empty">No scan roots configured — set SCAN_ROOTS in .env.</div>';

  const ignore = preview?.ignore || [];
  const avgDuration = formatDuration(preview?.avgDurationMs);

  content.innerHTML = `
    <button class="modal-close" id="scanConfirmClose">&times;</button>
    <div class="modal-title">Quick Scan — full fleet</div>
    ${freshnessHtml}

    <div class="modal-section">
      <div class="modal-section-label">Directories to scan</div>
      <div class="modal-section-body">${rootsHtml}</div>
    </div>

    ${ignore.length ? `
    <div class="modal-section">
      <div class="modal-section-label">Ignored</div>
      <div class="modal-section-body">${ignore.map(p => `<div class="settings-val">${esc(p)}</div>`).join('')}</div>
    </div>` : ''}

    <div class="modal-section">
      <div class="modal-section-label">What it does</div>
      <div class="modal-section-body">
        <div class="settings-kv"><span class="settings-key">Cost</span><span class="settings-val">$0.00 — no AI calls</span></div>
        <div class="settings-kv"><span class="settings-key">Currently tracked</span><span class="settings-val">${preview?.projectsTracked ?? '—'} projects</span></div>
        <div class="settings-kv"><span class="settings-key">Typical duration</span><span class="settings-val">${avgDuration ? `~${avgDuration}` : 'no timing history yet'}</span></div>
        <div class="scan-confirm-note-line">Re-walks the scan roots, refreshes git metadata, and re-checks dependencies for projects whose commit changed.</div>
      </div>
    </div>

    <div class="scan-confirm-summary">Summaries are untouched — only a Deep Scan spends anything.</div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="scanConfirmCancel">Cancel</button>
      <button class="btn ${fresh ? 'btn-secondary' : 'btn-primary'}" id="scanConfirmGo" style="margin-left:auto">${fresh ? 'Scan anyway' : 'Run Quick Scan'}</button>
    </div>
  `;
  modal.style.display = 'flex';

  document.getElementById('scanConfirmClose').onclick = closeScanConfirm;
  document.getElementById('scanConfirmCancel').onclick = closeScanConfirm;
  document.getElementById('scanConfirmBackdrop').onclick = closeScanConfirm;

  const goBtn = document.getElementById('scanConfirmGo');
  goBtn.onclick = () => {
    goBtn.disabled = true;
    goBtn.textContent = 'Starting...';
    triggerScan().then(() => {
      closeScanConfirm();
      setScanUIState(true);
      document.getElementById('scanStatus').textContent = 'Starting quick scan...';
      document.getElementById('scanStatus').className = 'scan-status scanning';
      startPolling();
    }).catch(err => {
      document.querySelector('#scanConfirmContent .scan-confirm-summary').textContent = err.message;
      goBtn.disabled = false;
      goBtn.textContent = 'Run Quick Scan';
    });
  };
}

function formatCostEstimate(avgCostPerSummary, count) {
  if (avgCostPerSummary == null) return 'No cost history yet — first Deep Scan will establish a baseline.';
  return `~$${(avgCostPerSummary * count).toFixed(4)} estimated (${count} × ~$${avgCostPerSummary.toFixed(4)} avg/summary)`;
}

async function openBucketDeepScanConfirm(bucket) {
  const modal = document.getElementById('scanConfirmModal');
  const content = document.getElementById('scanConfirmContent');
  const candidates = bucket.projects.filter(p => !p.summary || summaryOutdated(p));

  if (candidates.length === 0) {
    content.innerHTML = `
      <button class="modal-close" id="scanConfirmClose">&times;</button>
      <div class="modal-title">Deep Scan — ${esc(bucket.label)}</div>
      <p style="color:var(--text-muted);font-size:13px">All ${bucket.projects.length} project${bucket.projects.length !== 1 ? 's' : ''} in this group already have up-to-date summaries.</p>
      <div class="modal-actions"><button class="btn btn-secondary" id="scanConfirmCancel">Close</button></div>
    `;
    modal.style.display = 'flex';
    document.getElementById('scanConfirmClose').onclick = closeScanConfirm;
    document.getElementById('scanConfirmCancel').onclick = closeScanConfirm;
    document.getElementById('scanConfirmBackdrop').onclick = closeScanConfirm;
    return;
  }

  const [{ avgCostPerSummary }, cfg] = await Promise.all([
    fetchCostEstimate(),
    fetch('/api/config').then(r => r.json()).catch(() => null),
  ]);
  const cap = cfg?.maxSummariesPerScan ?? Infinity;

  content.innerHTML = `
    <button class="modal-close" id="scanConfirmClose">&times;</button>
    <div class="modal-title">Deep Scan — ${esc(bucket.label)}</div>
    <p style="color:var(--text-muted);font-size:12px;margin-bottom:12px">Review the projects below — uncheck any you don't want summarized right now.</p>
    <div class="scan-confirm-list" id="scanConfirmList">
      ${candidates.map(p => `
        <label class="scan-confirm-row">
          <input type="checkbox" value="${p.id}" ${p.deep_scan_ignored ? '' : 'checked'} />
          <span>${esc(p.user_label || p.name)}</span>
          ${p.deep_scan_ignored ? '<span class="scan-confirm-note">skip-AI</span>' : ''}
        </label>
      `).join('')}
    </div>
    <div class="scan-confirm-summary" id="scanConfirmSummary"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="scanConfirmCancel">Cancel</button>
      <button class="btn btn-primary" id="scanConfirmGo" style="margin-left:auto">Run Deep Scan</button>
    </div>
  `;
  modal.style.display = 'flex';

  const list = document.getElementById('scanConfirmList');
  const summaryEl = document.getElementById('scanConfirmSummary');
  const goBtn = document.getElementById('scanConfirmGo');

  function refresh() {
    const selected = [...list.querySelectorAll('input:checked')].map(i => i.value);
    if (selected.length === 0) {
      summaryEl.textContent = 'Select at least one project.';
      goBtn.disabled = true;
    } else if (selected.length > cap) {
      summaryEl.textContent = `${selected.length} selected exceeds the per-scan cap of ${cap} — deselect some.`;
      goBtn.disabled = true;
    } else {
      summaryEl.textContent = formatCostEstimate(avgCostPerSummary, selected.length);
      goBtn.disabled = false;
    }
    return selected;
  }
  list.addEventListener('change', refresh);
  refresh();

  document.getElementById('scanConfirmClose').onclick = closeScanConfirm;
  document.getElementById('scanConfirmCancel').onclick = closeScanConfirm;
  document.getElementById('scanConfirmBackdrop').onclick = closeScanConfirm;

  goBtn.onclick = () => {
    const selected = refresh();
    if (selected.length === 0 || selected.length > cap) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Starting...';
    triggerScan(selected, 'deep').then(() => {
      closeScanConfirm();
      setScanUIState(true);
      document.getElementById('scanStatus').textContent = `Deep scanning ${bucket.label} (${selected.length})...`;
      document.getElementById('scanStatus').className = 'scan-status scanning';
      startPolling();
    }).catch(err => {
      summaryEl.textContent = err.message;
      goBtn.disabled = false;
      goBtn.textContent = 'Run Deep Scan';
    });
  };
}

async function openProjectDeepScanConfirm(p) {
  const modal = document.getElementById('scanConfirmModal');
  const content = document.getElementById('scanConfirmContent');

  const { avgCostPerSummary } = await fetchCostEstimate();

  content.innerHTML = `
    <button class="modal-close" id="scanConfirmClose">&times;</button>
    <div class="modal-title">Deep Scan — ${esc(p.user_label || p.name)}</div>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:6px">${formatCostEstimate(avgCostPerSummary, 1)}</p>
    <p style="color:var(--text-muted);font-size:13px;margin-bottom:6px">Also re-checks dependencies, which may take a few seconds.</p>
    ${p.deep_scan_ignored ? '<p style="color:var(--warning);font-size:13px">This project is marked to skip AI summaries — this run overrides that once; the flag itself won\'t change.</p>' : ''}
    <div class="modal-actions">
      <button class="btn btn-secondary" id="scanConfirmCancel">Cancel</button>
      <button class="btn btn-primary" id="scanConfirmGo" style="margin-left:auto">Run Deep Scan</button>
    </div>
  `;
  modal.style.display = 'flex';

  document.getElementById('scanConfirmClose').onclick = closeScanConfirm;
  document.getElementById('scanConfirmCancel').onclick = closeScanConfirm;
  document.getElementById('scanConfirmBackdrop').onclick = closeScanConfirm;

  document.getElementById('scanConfirmGo').onclick = () => {
    closeScanConfirm();
    const btn = document.getElementById('btnDeepScanProject');
    const summaryEl = document.getElementById('modalSummary');
    if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
    if (summaryEl) summaryEl.innerHTML = '<span style="color:var(--accent);font-style:italic">Scanning project and generating summary...</span>';
    triggerScan([p.id], 'deep', true).then(() => pollProjectScan(p.id, btn, 'Analyzing...'));
  };
}

async function openSettings() {
  const modal = document.getElementById('modal');
  const content = document.getElementById('modalContent');

  let cfg;
  try {
    cfg = await fetch('/api/config').then(r => r.json());
  } catch {
    cfg = null;
  }

  const roots = (cfg?.scanRoots || []);
  const ignore = (cfg?.ignore || []);

  const rootsHtml = roots.length
    ? roots.map(r => `<div class="settings-kv"><span class="settings-key">${esc(r.label)}</span><span class="settings-val">${esc(r.path)}</span></div>`).join('')
    : '<div class="settings-empty">None configured</div>';

  const ignoreHtml = ignore.length
    ? ignore.map(p => `<div class="settings-val">${esc(p)}</div>`).join('')
    : '<div class="settings-empty">None</div>';

  content.innerHTML = `
    <button class="modal-close" id="modalClose">&times;</button>
    <div class="modal-title">Settings</div>
    <div class="modal-path"><span>Read-only — edit <code>.env</code> and restart the server to change.</span></div>

    <div class="modal-section">
      <div class="modal-section-label">Scan Roots</div>
      <div class="modal-section-body">${rootsHtml}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-label">Ignore Paths</div>
      <div class="modal-section-body">${ignoreHtml}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-label">Scan Limits</div>
      <div class="modal-section-body">
        <div class="settings-kv"><span class="settings-key">Active cutoff</span><span class="settings-val">${esc(String(cfg?.activeCutoffDays ?? '—'))} days</span></div>
        <div class="settings-kv"><span class="settings-key">Max summaries / Deep Scan</span><span class="settings-val">${esc(String(cfg?.maxSummariesPerScan ?? '—'))}</span></div>
      </div>
    </div>
  `;

  modal.style.display = 'flex';
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalBackdrop').onclick = closeModal;
}

// --- Scan polling ---

const PHASE_LABELS = {
  discovering: 'Discovering projects...',
  analyzing: 'Analyzing',
  'checking deps': 'Checking deps',
  summarizing: 'Generating summaries',
};

function formatProgress(progress) {
  if (!progress) return 'Scanning...';
  const { phase, projectsCurrent, projectsTotal, summariesCurrent, summariesTotal, currentProjectName, estimatedCost } = progress;

  if (phase === 'discovering') return 'Discovering projects...';

  let text = PHASE_LABELS[phase] || phase;
  if (phase === 'analyzing') {
    text += ` ${projectsCurrent}/${projectsTotal}`;
  } else if (phase === 'summarizing') {
    text += ` ${summariesCurrent}/${summariesTotal}`;
  }
  if (currentProjectName) text += ` — ${currentProjectName}`;
  if (estimatedCost > 0) text += ` · $${estimatedCost.toFixed(4)}`;
  return text;
}

function setScanUIState(scanning) {
  const btnScan = document.getElementById('btnScan');
  const btnStop = document.getElementById('btnStopScan');
  btnScan.style.display = scanning ? 'none' : '';
  btnStop.style.display = scanning ? '' : 'none';
  btnStop.disabled = false;
  if (!scanning) {
    btnScan.disabled = true;
    setTimeout(() => { btnScan.disabled = false; }, 1500);
  }
}

function updateScanningCards(activeIds) {
  const idSet = new Set(activeIds || []);
  document.querySelectorAll('.project-card').forEach(card => {
    card.classList.toggle('is-scanning', idSet.has(card.dataset.id));
  });
}

function animateScanComplete(run, wasBackground) {
  const statusEl = document.getElementById('scanStatus');
  const btnScan = document.getElementById('btnScan');

  const parts = [];
  if (run?.projects_found > 0) parts.push(`${run.projects_found} projects`);
  if (run?.summaries_generated > 0) parts.push(`${run.summaries_generated} summaries`);
  if (run?.estimated_cost_usd > 0) parts.push(`$${run.estimated_cost_usd.toFixed(4)}`);
  const text = parts.length ? parts.join(' · ') : 'Scan complete';

  if (wasBackground) {
    showScanDone(run);
    return;
  }

  // Animate result text: slides in from right, pauses, slides out left into button area
  statusEl.style.overflow = 'hidden';
  statusEl.className = 'scan-status';
  const inner = document.createElement('span');
  inner.style.display = 'inline-block';
  inner.textContent = text;
  statusEl.innerHTML = '';
  statusEl.appendChild(inner);

  inner.animate([
    { transform: 'translateX(110%)', opacity: 0 },
    { transform: 'translateX(0)',    opacity: 1, offset: 0.2 },
    { transform: 'translateX(0)',    opacity: 1, offset: 0.72 },
    { transform: 'translateX(110%)', opacity: 0 },
  ], { duration: 2200, easing: 'ease-in-out', fill: 'forwards' })
    .finished.then(() => {
      statusEl.style.overflow = '';
      showScanDone(run);
      setScanUIState(false);
      btnScan.animate([
        { transform: 'scale(0.75)', opacity: 0 },
        { transform: 'scale(1)',    opacity: 1 },
      ], { duration: 220, easing: 'ease-out' });
    });
}

function startPolling() {
  if (scanPollTimer) return;
  const el = document.getElementById('scanStatus');
  let wasBackground = false;
  scanPollTimer = setInterval(async () => {
    const s = await fetchScanStatus();
    updateScanningCards(s.progress?.activeProjectIds);
    if (s.inProgress) wasBackground = !!s.isBackground;
    if (!s.inProgress) {
      clearInterval(scanPollTimer);
      scanPollTimer = null;
      updateScanningCards([]);
      await reload();
      animateScanComplete(s.lastRun, wasBackground);
    } else {
      el.textContent = s.isBackground ? `Background: ${formatProgress(s.progress)}` : formatProgress(s.progress);
      el.className = 'scan-status scanning';
      if (!s.isBackground) setScanUIState(true);
    }
  }, 1000);
}

// Slow background poll — keeps card scanning indicators current even without a manual scan
let bgPollTimer = null;
function startBgPoll() {
  if (bgPollTimer) return;
  bgPollTimer = setInterval(async () => {
    if (scanPollTimer) return; // fast poll already running
    const s = await fetchScanStatus();
    updateScanningCards(s.progress?.activeProjectIds);
    if (s.inProgress) {
      el_scanStatus_textContent_bg(s);
      startPolling(); // hand off to fast poll
    }
  }, 5000);
}

function el_scanStatus_textContent_bg(s) {
  const el = document.getElementById('scanStatus');
  el.textContent = s.isBackground ? `Background: ${formatProgress(s.progress)}` : formatProgress(s.progress);
  el.className = 'scan-status scanning';
}

async function updateScanStatus() {
  const status = await fetchScanStatus();
  updateScanningCards(status.progress?.activeProjectIds);

  if (status.inProgress) {
    const el = document.getElementById('scanStatus');
    el.textContent = status.isBackground ? `Background: ${formatProgress(status.progress)}` : formatProgress(status.progress);
    el.className = 'scan-status scanning';
    if (!status.isBackground) setScanUIState(true);
    startPolling();
  } else {
    showScanDone(status.lastRun);
    setScanUIState(false);
  }
}

function formatCost(run) {
  if (!run || !run.summaries_generated) return '';
  const cost = (run.estimated_cost_usd || 0).toFixed(4);
  return ` · ${run.summaries_generated} summaries · $${cost} · ${(run.input_tokens || 0).toLocaleString()}/${(run.output_tokens || 0).toLocaleString()} tokens`;
}

function showScanDone(run) {
  lastScanRun = run;
  const el = document.getElementById('scanStatus');
  if (run && run.finished_at) {
    el.textContent = `Last scan: ${formatDate(run.finished_at)}${formatCost(run)}`;
    el.className = 'scan-status';
    el.title = run.estimated_cost_usd
      ? `Input: ${run.input_tokens} tokens · Output: ${run.output_tokens} tokens · Cost: $${run.estimated_cost_usd.toFixed(6)}`
      : '';
  } else {
    el.textContent = 'Never scanned';
    el.className = 'scan-status';
  }
}

// --- Init ---

async function reload() {
  const showIgnored = document.getElementById('filterIgnored').checked;
  allProjects = await fetchProjects(showIgnored);
  buildGroupOptions(allProjects);
  applyFilters();
}

// --- Chat ---

let chatProjectId = null;
let chatBusy = false;
let lastScanRun = null;
const chatHistoryCache = new Map(); // projectId -> innerHTML

function showFreshnessNotice() {
  const container = document.getElementById('chatMessages');

  const visible = allProjects.filter(p => !p.ignored);
  const needsSummary = visible.filter(p => !p.summary || summaryOutdated(p));
  const msSinceScan = lastScanRun?.finished_at ? Date.now() - lastScanRun.finished_at : null;
  const daysSinceScan = msSinceScan !== null ? Math.floor(msSinceScan / 86400000) : null;
  const neverScanned = lastScanRun == null;

  // Don't nag if a scan just ran within the last 24 hours
  if (msSinceScan !== null && msSinceScan < 86400000) return;

  const issues = [];
  if (neverScanned) issues.push('Projects have never been scanned.');
  else if (daysSinceScan > 7) issues.push(`Last scan was ${daysSinceScan} days ago.`);
  if (needsSummary.length > 0) issues.push(`${needsSummary.length} of ${visible.length} projects have no AI summary, or an outdated one.`);

  if (issues.length === 0) return;

  const notice = document.createElement('div');
  notice.className = 'chat-freshness-notice';
  notice.innerHTML = `
    <div class="freshness-text"><strong>Data may be stale.</strong> ${issues.join(' ')}</div>
    <div class="freshness-actions">
      <button class="btn btn-primary btn-sm" id="btnFreshnessScan">${neverScanned ? 'Run Quick Scan' : 'Review & Deep Scan'}</button>
      <button class="freshness-dismiss" id="btnFreshnessDismiss">&times;</button>
    </div>
  `;
  container.appendChild(notice);

  document.getElementById('btnFreshnessScan').onclick = () => {
    notice.remove();
    if (neverScanned) {
      setScanUIState(true);
      document.getElementById('scanStatus').textContent = 'Starting quick scan...';
      document.getElementById('scanStatus').className = 'scan-status scanning';
      triggerScan().then(() => startPolling());
    } else {
      openBucketDeepScanConfirm({ label: 'all projects', projects: needsSummary });
    }
  };
  document.getElementById('btnFreshnessDismiss').onclick = () => notice.remove();
}

function openGlobalChat() {
  const container = document.getElementById('chatMessages');

  if (chatProjectId && chatProjectId !== 'global') {
    chatHistoryCache.set(chatProjectId, container.innerHTML);
  }

  chatProjectId = 'global';
  document.getElementById('chatTitle').textContent = `Ask AI — ${allProjects.filter(p => !p.ignored).length} projects`;

  container.innerHTML = chatHistoryCache.get('global') || '';
  container.querySelector('.chat-freshness-notice')?.remove();

  document.getElementById('chatPanel').style.display = 'flex';
  document.getElementById('chatInput').placeholder = 'Ask anything about your projects...';
  showFreshnessNotice();
  document.getElementById('chatInput').focus();
  container.scrollTop = container.scrollHeight;
}

function openChat(project) {
  const container = document.getElementById('chatMessages');

  // Save current chat if switching projects
  if (chatProjectId && chatProjectId !== project.id) {
    chatHistoryCache.set(chatProjectId, container.innerHTML);
  }

  chatProjectId = project.id;
  document.getElementById('chatTitle').textContent = `Chat — ${project.name}`;

  // Restore cached messages or start fresh
  container.innerHTML = chatHistoryCache.get(project.id) || '';

  document.getElementById('chatPanel').style.display = 'flex';
  document.getElementById('chatInput').placeholder = 'Ask about this project...';
  document.getElementById('chatInput').focus();
  container.scrollTop = container.scrollHeight;
}

function closeChat() {
  document.getElementById('chatPanel').style.display = 'none';
}

function addChatMessage(role, content) {
  const container = document.getElementById('chatMessages');
  const msg = document.createElement('div');
  msg.className = `chat-msg chat-msg-${role}`;
  if (role === 'assistant') {
    msg.innerHTML = renderMarkdown(content);
  } else {
    msg.textContent = content;
  }
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
  return msg;
}

function renderMarkdown(text) {
  if (window.marked) {
    return window.marked.parse(text);
  }
  // fallback if marked didn't load
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/^### (.+)$/gm, '<strong style="font-size:14px">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong style="font-size:15px">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong style="font-size:16px">$1</strong>')
    .replace(/^- (.+)$/gm, '&bull; $1')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function showToolActivity(text) {
  const el = document.getElementById('chatToolActivity');
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

async function sendChatMessage() {
  if (chatBusy || !chatProjectId) return;
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  chatBusy = true;
  document.getElementById('btnChatSend').disabled = true;

  addChatMessage('user', message);

  // Create streaming assistant bubble
  const assistantMsg = addChatMessage('assistant', '');
  let fullText = '';

  try {
    const res = await fetch(`/api/chat/${chatProjectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));

        if (data.type === 'text') {
          fullText += data.text;
          assistantMsg.innerHTML = renderMarkdown(fullText);
          document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
        } else if (data.type === 'tool_start') {
          showToolActivity(`Reading: ${data.name}...`);
        } else if (data.type === 'tool_exec') {
          const label = data.name === 'read_file' ? data.input.relative_path
            : data.name === 'write_file' ? `writing ${data.input.relative_path}`
            : data.name === 'list_directory' ? `listing ${data.input.relative_path || '.'}`
            : data.name === 'search_files' ? `searching "${data.input.pattern}"`
            : data.name === 'git_command' ? `git ${data.input.args}`
            : data.name;
          showToolActivity(`Executing: ${label}`);
        } else if (data.type === 'done') {
          showToolActivity('');
        } else if (data.type === 'error') {
          fullText += `\n\nError: ${data.error}`;
          assistantMsg.innerHTML = renderMarkdown(fullText);
        }
      }
    }
  } catch (err) {
    assistantMsg.innerHTML = renderMarkdown(fullText + `\n\nConnection error: ${err.message}`);
  }

  showToolActivity('');
  chatBusy = false;
  document.getElementById('btnChatSend').disabled = false;
  document.getElementById('chatInput').focus();
}

function setChatDisabled(disabled) {
  document.getElementById('chatInput').disabled = disabled;
  document.getElementById('btnChatSend').disabled = disabled;
  document.getElementById('btnChatCondense').disabled = disabled;
  document.getElementById('btnChatClear').disabled = disabled;
}

function showChatOverlay(text) {
  let overlay = document.getElementById('chatOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'chatOverlay';
    overlay.className = 'chat-overlay';
    document.getElementById('chatMessages').appendChild(overlay);
  }
  if (text) {
    overlay.textContent = text;
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

async function condenseChat() {
  if (!chatProjectId) return;
  chatBusy = true;
  setChatDisabled(true);
  showChatOverlay('Condensing conversation...');

  try {
    const res = await fetch(`/api/chat/${chatProjectId}/condense`, { method: 'POST' });
    const data = await res.json();

    if (data.ok && data.condensed) {
      const container = document.getElementById('chatMessages');
      container.innerHTML = '';
      showChatOverlay(null);

      // Show the condensed summary as a system-style message
      const summaryMsg = document.createElement('div');
      summaryMsg.className = 'chat-msg chat-msg-condensed';
      summaryMsg.innerHTML = renderMarkdown(data.condensed);
      container.appendChild(summaryMsg);

      // Show the continuation message
      addChatMessage('assistant', 'Understood. I have the conversation context. How can I continue helping?');
    } else {
      showChatOverlay(null);
    }
  } catch (err) {
    showChatOverlay(null);
    addChatMessage('assistant', `Condensation failed: ${err.message}`);
  }

  chatBusy = false;
  setChatDisabled(false);
  document.getElementById('chatInput').focus();
}

function initChatResize() {
  const panel = document.getElementById('chatPanel');
  const handle = document.getElementById('chatResizeHandle');

  let startX, startY, startW, startH;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e) {
    const dx = startX - e.clientX;
    const dy = startY - e.clientY;
    const newW = Math.max(300, Math.min(window.innerWidth - 40, startW + dx));
    const newH = Math.max(280, Math.min(window.innerHeight - 60, startH + dy));
    panel.style.width = newW + 'px';
    panel.style.height = newH + 'px';
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
}

async function init() {
  await reload();
  await updateScanStatus();
  initChatResize();

  // Sticky controls — position just below header
  const header = document.querySelector('header');
  document.querySelector('.controls').style.top = header.offsetHeight + 'px';

  document.getElementById('searchInput').addEventListener('input', applyFilters);
  document.getElementById('filterType').addEventListener('change', applyFilters);
  document.getElementById('filterGroup').addEventListener('change', applyFilters);
  document.getElementById('filterUncommitted').addEventListener('change', applyFilters);
  document.getElementById('filterIgnored').addEventListener('change', async () => {
    await reload();
  });

  document.getElementById('btnScan').addEventListener('click', openQuickScanConfirm);

  document.getElementById('btnStopScan').addEventListener('click', () => {
    document.getElementById('btnStopScan').disabled = true;
    document.getElementById('scanStatus').textContent = 'Stopping...';
    stopScan();
  });

  startBgPoll();
  document.getElementById('btnGlobalChat').addEventListener('click', openGlobalChat);
  document.getElementById('btnSettings').addEventListener('click', openSettings);
  document.getElementById('btnChatSend').addEventListener('click', sendChatMessage);
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  document.getElementById('btnChatClose').addEventListener('click', closeChat);
  document.getElementById('btnChatClear').addEventListener('click', async () => {
    if (!chatProjectId) return;
    await fetch(`/api/chat/${chatProjectId}/clear`, { method: 'POST' });
    document.getElementById('chatMessages').innerHTML = '';
    chatHistoryCache.delete(chatProjectId);
  });
  document.getElementById('btnChatCondense').addEventListener('click', () => {
    if (!chatProjectId || chatBusy) return;
    condenseChat();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeChat(); closeModal(); }
  });
}

init();

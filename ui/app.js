let allProjects = [];
let scanPollTimer = null;

const TYPE_LABELS = {
  python: 'Python', nodejs: 'Node.js', typescript: 'TypeScript',
  electron: 'Electron', react: 'React', nextjs: 'Next.js',
  'react-native': 'React Native', swift: 'Swift', monorepo: 'Monorepo', unknown: 'Unknown',
};

const DAY = 86400000;

const STATUS_TOOLTIPS = {
  'Active': 'Commits within the last 30 days — this project is being worked on',
  'Stale': 'No commits in 30+ days but the project appears incomplete or in-progress',
  'Abandoned': 'No meaningful activity for a long time — likely shelved or forgotten',
  'Early Stage': 'Recently created with minimal commits — just getting started',
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

async function triggerScan(type, projectIds) {
  const body = { type };
  if (projectIds) body.projectIds = projectIds;
  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function ignoreProject(id, ignored) {
  await fetch(`/api/projects/${id}/ignore`, {
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

  for (const p of projects) {
    const date = p.last_commit_date || p.first_seen_at;
    const age = now - date;
    for (const bucket of buckets) {
      if (age < bucket.max) {
        bucket.projects.push(p);
        break;
      }
    }
  }

  return buckets.filter(b => b.projects.length > 0);
}

function renderCard(p) {
  const type = p.type || 'unknown';
  const typeLabel = TYPE_LABELS[type] || type;
  const integrations = Array.isArray(p.integrations) ? p.integrations : [];
  const status = parseStatus(p.summary);
  const summaryText = getSummaryText(p.summary);
  const statusClass = status ? `status-${status.split(' ')[0]}` : '';

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
        <span class="badge badge-${type}" title="Detected project type based on config files (package.json, pyproject.toml, xcodeproj, etc.)">${typeLabel}</span>
        ${!p.has_git ? '<span class="flag-no-git" title="No git repository found in this project">no git</span>' : p.has_uncommitted ? '<span class="flag-uncommitted" title="This project has uncommitted changes in its git working tree">uncommitted</span>' : ''}
      </div>
    </div>

    ${summaryText
      ? `<div class="card-summary">${renderMarkdown(esc(summaryText))}</div>`
      : `<div class="card-summary no-summary" title="Run a Deep Scan or click Scan &amp; Summarize to generate an AI summary">No summary yet</div>`
    }

    ${status ? `<div class="card-status-line"><span class="status-pill ${statusClass}" title="${STATUS_TOOLTIPS[status] || ''}">${status}</span></div>` : ''}

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
      <button class="btn-bucket-scan" title="Scan only this group">Scan</button>
    `;

    const scanBtn = header.querySelector('.btn-bucket-scan');
    const ids = bucket.projects.map(p => p.id);
    scanBtn.addEventListener('click', () => {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning...';
      setScanUIState(true);
      document.getElementById('scanStatus').textContent = `Scanning ${bucket.label} (${ids.length})...`;
      document.getElementById('scanStatus').className = 'scan-status scanning';
      triggerScan('targeted', ids).then(() => startPolling());
    });

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
  const status = parseStatus(p.summary);
  const summaryText = getSummaryText(p.summary);
  const statusClass = status ? `status-${status.split(' ')[0]}` : '';

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
      <span class="badge badge-${p.type}">${TYPE_LABELS[p.type] || p.type}</span>
      ${p.has_uncommitted ? '<span class="flag-uncommitted">uncommitted changes</span>' : ''}
      ${status ? `<span class="status-pill ${statusClass}" title="${STATUS_TOOLTIPS[status] || ''}">${status}</span>` : '<span style="font-size:10px;color:var(--text-muted)">no status yet</span>'}
    </div>

    <div class="modal-section">
      <div class="modal-section-label">Summary</div>
      <div class="modal-section-body" id="modalSummary">${summaryText ? renderMarkdown(esc(summaryText)) : '<span style="color:var(--text-muted);font-style:italic">No summary yet — click Scan &amp; Summarize to generate one.</span>'}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-label">Details</div>
      <div class="modal-section-body">
        <table style="border-collapse:collapse;width:100%;">
          ${row('Group', p.group_name || '—')}
          ${row('Root', p.root_label || '—')}
          ${row('Languages', languages.join(', ') || '—')}
          ${row('Branch', p.branch || '—')}
          ${row('Last commit', p.last_commit_date ? new Date(p.last_commit_date).toLocaleString() : '—')}
          ${row('Last message', p.last_commit_message || '—')}
          ${row('Commits (30d)', p.commit_count_30d || 0)}
          ${row('Docs', [p.has_readme ? 'README.md' : null, p.has_claude_md ? 'CLAUDE.md' : null].filter(Boolean).join(', ') || 'none')}
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
      <button class="btn btn-primary" id="btnDeepScanProject">Scan &amp; Summarize</button>
      <button class="btn btn-ai-chat" id="btnAIChat">AI Chat</button>
      <button class="btn btn-secondary" id="btnIgnoreToggle" style="margin-left:auto">
        ${p.ignored ? 'Unignore project' : 'Ignore project'}
      </button>
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

  document.getElementById('btnDeepScanProject').onclick = () => {
    const btn = document.getElementById('btnDeepScanProject');
    const summaryEl = document.getElementById('modalSummary');
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    summaryEl.innerHTML = '<span style="color:var(--accent);font-style:italic">Scanning project and generating summary...</span>';

    triggerScan('deep', [p.id]).then(() => {
      const poll = setInterval(async () => {
        const s = await fetchScanStatus();
        if (s.progress) {
          const phase = s.progress.phase;
          if (phase === 'analyzing') btn.textContent = 'Analyzing...';
          else if (phase === 'summarizing') btn.textContent = 'Generating summary...';
        }
        if (!s.inProgress) {
          clearInterval(poll);
          await reload();
          const updated = allProjects.find(x => x.id === p.id);
          if (updated) openModal(updated);
        }
      }, 1000);
    });
  };

  document.getElementById('btnIgnoreToggle').onclick = async () => {
    await ignoreProject(p.id, !p.ignored);
    closeModal();
    await reload();
  };
}

function row(label, value) {
  return `<tr>
    <td style="padding:3px 12px 3px 0;color:var(--text-muted);font-size:11px;white-space:nowrap;vertical-align:top">${label}</td>
    <td style="padding:3px 0;font-size:12px;color:var(--text-dim)">${esc(String(value))}</td>
  </tr>`;
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  closeChat();
}

// --- Scan polling ---

const PHASE_LABELS = {
  discovering: 'Discovering projects...',
  analyzing: 'Analyzing',
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
  const btnQ = document.getElementById('btnQuickScan');
  const btnD = document.getElementById('btnDeepScan');
  const btnStop = document.getElementById('btnStopScan');
  btnQ.style.display = scanning ? 'none' : '';
  btnD.style.display = scanning ? 'none' : '';
  btnStop.style.display = scanning ? '' : 'none';
  btnStop.disabled = false;
  if (!scanning) {
    btnQ.disabled = true;
    btnD.disabled = true;
    setTimeout(() => {
      btnQ.disabled = false;
      btnD.disabled = false;
    }, 1500);
  }
}

function startPolling() {
  if (scanPollTimer) return;
  const el = document.getElementById('scanStatus');
  scanPollTimer = setInterval(async () => {
    const s = await fetchScanStatus();
    if (!s.inProgress) {
      clearInterval(scanPollTimer);
      scanPollTimer = null;
      await reload();
      showScanDone(s.lastRun);
      setScanUIState(false);
    } else {
      el.textContent = formatProgress(s.progress);
      el.className = 'scan-status scanning';
      setScanUIState(true);
    }
  }, 1000);
}

async function updateScanStatus() {
  const status = await fetchScanStatus();

  if (status.inProgress) {
    document.getElementById('scanStatus').textContent = formatProgress(status.progress);
    document.getElementById('scanStatus').className = 'scan-status scanning';
    setScanUIState(true);
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

function showScanDone(lastRun) {
  const el = document.getElementById('scanStatus');
  if (lastRun && lastRun.finished_at) {
    el.textContent = `Last scan: ${formatDate(lastRun.finished_at)}${formatCost(lastRun)}`;
    el.className = 'scan-status';
    el.title = lastRun.estimated_cost_usd
      ? `Input: ${lastRun.input_tokens} tokens · Output: ${lastRun.output_tokens} tokens · Cost: $${lastRun.estimated_cost_usd.toFixed(6)}`
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
const chatHistoryCache = new Map(); // projectId -> innerHTML

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

  document.getElementById('searchInput').addEventListener('input', applyFilters);
  document.getElementById('filterType').addEventListener('change', applyFilters);
  document.getElementById('filterGroup').addEventListener('change', applyFilters);
  document.getElementById('filterUncommitted').addEventListener('change', applyFilters);
  document.getElementById('filterIgnored').addEventListener('change', async () => {
    await reload();
  });

  document.getElementById('btnQuickScan').addEventListener('click', () => {
    setScanUIState(true);
    document.getElementById('scanStatus').textContent = 'Starting quick scan...';
    document.getElementById('scanStatus').className = 'scan-status scanning';
    triggerScan('quick').then(() => startPolling());
  });

  document.getElementById('btnDeepScan').addEventListener('click', () => {
    setScanUIState(true);
    document.getElementById('scanStatus').textContent = 'Starting deep scan...';
    document.getElementById('scanStatus').className = 'scan-status scanning';
    triggerScan('deep').then(() => startPolling());
  });

  document.getElementById('btnStopScan').addEventListener('click', () => {
    document.getElementById('btnStopScan').disabled = true;
    document.getElementById('scanStatus').textContent = 'Stopping...';
    stopScan();
  });

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

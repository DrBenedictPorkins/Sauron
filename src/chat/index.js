const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { MODEL } = require('../models');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Thinking tokens count toward max_tokens, so a hard question can spend the whole
// budget reasoning and return no text at all. Rendering that as an empty reply
// tells the user nothing happened, which is false — say what happened instead.
function truncationNotice(finalMessage, yieldedText) {
  if (finalMessage.stop_reason !== 'max_tokens') return null;
  return yieldedText
    ? '\n\n[Reply cut off at the length limit. Ask for a narrower slice to see the rest.]'
    : '[No reply: the model spent its whole output limit reasoning. Ask a narrower question.]';
}

// The first content block is not necessarily the text: with thinking on it is a
// thinking block, and content[0].text is undefined.
function textOf(message) {
  return message.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// In-memory sessions keyed by project ID
const sessions = new Map();

const TOOLS = [
  {
    name: 'list_directory',
    description: 'List files and directories at a given path within the project. Returns names, types (file/dir), and sizes.',
    input_schema: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'Path relative to project root. Use "" or "." for the root directory.',
        },
      },
      required: ['relative_path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file within the project. For large files, use offset and limit to read specific line ranges.',
    input_schema: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'File path relative to project root.',
        },
        offset: {
          type: 'number',
          description: 'Starting line number (0-based). Default 0.',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read. Default 200.',
        },
      },
      required: ['relative_path'],
    },
  },
  {
    name: 'get_file_info',
    description: 'Get metadata about a file: size, last modified date, line count.',
    input_schema: {
      type: 'object',
      properties: {
        relative_path: {
          type: 'string',
          description: 'File path relative to project root.',
        },
      },
      required: ['relative_path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern across files in the project. Returns matching file paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for.',
        },
        glob: {
          type: 'string',
          description: 'Optional file glob filter, e.g. "*.py" or "src/**/*.ts".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_command',
    description: 'Run a read-only git command in the project directory. Only safe, read-only git subcommands are allowed (log, diff, show, status, branch, tag, blame, etc.). No push, pull, commit, checkout, reset, or any write operations.',
    input_schema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'Git arguments (without the "git" prefix). E.g. "log --oneline -20", "diff HEAD~3", "blame src/index.js".',
        },
      },
      required: ['args'],
    },
  },
];

const GIT_ALLOWED_COMMANDS = new Set([
  'log', 'show', 'diff', 'status', 'branch', 'tag', 'stash', 'shortlog',
  'blame', 'rev-list', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
  'describe', 'name-rev', 'reflog', 'remote',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build',
  '.next', '.nuxt', 'coverage', '.cache', '.tox', '.eggs', '.mypy_cache',
]);

function safePath(projectRoot, relativePath) {
  const cleaned = (relativePath || '.').replace(/\.\./g, '');
  const full = path.resolve(projectRoot, cleaned);
  // A bare startsWith would let /a/proj reach its sibling /a/proj2.
  if (full !== projectRoot && !full.startsWith(projectRoot + path.sep)) return null;
  return full;
}

// A tool must never throw out of the chat loop: the model controls the inputs,
// so a bad one (an invalid regex from search_files, say) would otherwise abort
// the whole conversation instead of being handed back as a correctable error.
function executeTool(toolName, input, projectRoot) {
  try {
    return dispatchTool(toolName, input, projectRoot);
  } catch (err) {
    return { error: `${toolName} failed: ${err.message}` };
  }
}

function dispatchTool(toolName, input, projectRoot) {
  switch (toolName) {
    case 'list_directory': return listDirectory(projectRoot, input.relative_path);
    case 'read_file': return readFile(projectRoot, input.relative_path, input.offset, input.limit);
    case 'get_file_info': return getFileInfo(projectRoot, input.relative_path);
    case 'search_files': return searchFiles(projectRoot, input.pattern, input.glob);
    case 'git_command': return gitCommand(projectRoot, input.args);
    default: return { error: `Unknown tool: ${toolName}` };
  }
}

function gitCommand(projectRoot, args) {
  if (!args || typeof args !== 'string') return { error: 'No args provided' };

  // Parse the subcommand (first word)
  const subcommand = args.trim().split(/\s+/)[0];
  if (!GIT_ALLOWED_COMMANDS.has(subcommand)) {
    return { error: `Git subcommand "${subcommand}" is not allowed. Only read-only commands: ${[...GIT_ALLOWED_COMMANDS].join(', ')}` };
  }

  try {
    const { execSync } = require('child_process');
    const output = execSync(`git ${args}`, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 1024 * 256,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: output.slice(0, 10000) };
  } catch (err) {
    return { error: err.stderr?.slice(0, 500) || err.message };
  }
}

function listDirectory(projectRoot, relativePath) {
  const full = safePath(projectRoot, relativePath);
  if (!full) return { error: 'Invalid path' };

  try {
    const entries = fs.readdirSync(full, { withFileTypes: true });
    const results = [];
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      try {
        const stat = fs.statSync(path.join(full, e.name));
        results.push({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? stat.size : undefined,
        });
      } catch {
        results.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' });
      }
    }
    return results;
  } catch (err) {
    return { error: err.message };
  }
}

function readFile(projectRoot, relativePath, offset = 0, limit = 200) {
  const full = safePath(projectRoot, relativePath);
  if (!full) return { error: 'Invalid path' };

  try {
    const stat = fs.statSync(full);
    if (stat.size > 1024 * 1024) return { error: 'File too large (>1MB). Use offset/limit to read sections.' };

    const content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n');
    const slice = lines.slice(offset, offset + limit);
    return {
      content: slice.join('\n'),
      totalLines: lines.length,
      showing: `${offset + 1}-${Math.min(offset + limit, lines.length)} of ${lines.length}`,
    };
  } catch (err) {
    return { error: err.message };
  }
}

function getFileInfo(projectRoot, relativePath) {
  const full = safePath(projectRoot, relativePath);
  if (!full) return { error: 'Invalid path' };

  try {
    const stat = fs.statSync(full);
    const info = {
      size: stat.size,
      modified: stat.mtime.toISOString(),
      isDirectory: stat.isDirectory(),
    };
    if (!stat.isDirectory() && stat.size < 1024 * 1024) {
      const content = fs.readFileSync(full, 'utf8');
      info.lineCount = content.split('\n').length;
    }
    return info;
  } catch (err) {
    return { error: err.message };
  }
}

function searchFiles(projectRoot, pattern, glob) {
  const results = [];
  const regex = new RegExp(pattern, 'gi');
  const globRe = glob ? new RegExp('^' + glob.replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;

  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const fullPath = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;

      if (e.isDirectory()) {
        walk(fullPath, relPath);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(relPath) && !globRe.test(e.name)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 512 * 1024) continue; // skip large files
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({ file: relPath, line: i + 1, text: lines[i].trim().slice(0, 120) });
              if (results.length >= 50) return;
            }
            regex.lastIndex = 0;
          }
        } catch {}
      }
      if (results.length >= 50) return;
    }
  }

  walk(projectRoot, '');
  return results.length > 0 ? results : { message: 'No matches found' };
}

function buildSystemPrompt(project) {
  const langs = (typeof project.languages === 'string' ? JSON.parse(project.languages) : project.languages || []).join(', ');
  const integrations = (typeof project.integrations === 'string' ? JSON.parse(project.integrations) : project.integrations || []).join(', ');

  return `You are a project analyst assistant for the Sauron project dashboard. You are scoped to a single project and can answer questions about it.

PROJECT CONTEXT:
- Name: ${project.name}
- Path: ${project.path}
- Type: ${project.type}
- Languages: ${langs || 'unknown'}
- Branch: ${project.branch || 'unknown'}
- Last commit: ${project.last_commit_message || 'unknown'} (${project.last_commit_date ? new Date(project.last_commit_date).toLocaleString() : 'unknown'})
- Commits (30d): ${project.commit_count_30d || 0}
- Uncommitted changes: ${project.has_uncommitted ? 'yes' : 'no'}
- Integrations: ${integrations || 'none detected'}
- Has README: ${project.has_readme ? 'yes' : 'no'}
- Has CLAUDE.md: ${project.has_claude_md ? 'yes' : 'no'}

${project.summary ? `AI Summary:\n${project.summary}\n` : ''}

RULES:
- You are scoped to this project directory. No access outside it, no deletes.
- Your tools are read-only. You cannot create, modify or delete files.
- Use the provided tools to explore the project when you need more information.
- Be concise. Answer questions directly.
- If asked about something outside this project, decline politely.`;
}

function getSession(projectId) {
  if (!sessions.has(projectId)) {
    sessions.set(projectId, { messages: [] });
  }
  return sessions.get(projectId);
}

function clearSession(projectId) {
  sessions.delete(projectId);
}

async function condenseSession(projectId) {
  const session = sessions.get(projectId);
  if (!session || session.messages.length < 4) return null;

  // Build a text representation of the conversation for the condensation prompt
  const lines = [];
  for (const msg of session.messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        lines.push(`USER: ${msg.content}`);
      } else if (Array.isArray(msg.content)) {
        // Tool results — summarize
        for (const part of msg.content) {
          if (part.type === 'tool_result') {
            lines.push(`[Tool result returned]`);
          }
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        lines.push(`ASSISTANT: ${msg.content}`);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') lines.push(`ASSISTANT: ${block.text}`);
          if (block.type === 'tool_use') lines.push(`[Used tool: ${block.name}]`);
        }
      }
    }
  }

  const totalTurns = session.messages.filter(m => m.role === 'user' && typeof m.content === 'string').length;
  const transcript = lines.join('\n');

  const condensationPrompt = `You are condensing a project-scoped AI chat conversation. Produce a single condensed summary that will replace the current conversation history.

RULES:
- Older exchanges (before the last 3-5 turns): aggressive compression — intent and outcome only, no detail.
- Recent exchanges (last 3-5 turns): light compression — preserve specifics, exact values, current state.
- ALWAYS preserve: active task state, file paths discussed, decisions made, errors encountered, anything explicitly marked as important.
- DISCARD: resolved tangents, superseded approaches, filler exchanges, tool call mechanics.

The conversation has ${totalTurns} user turns total.

TRANSCRIPT:
${transcript}

Write the condensed summary. Format it as a clear, scannable recap that the AI can use as context to continue the conversation seamlessly. Start with "## Conversation Summary" and use bullet points.`;

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: condensationPrompt }],
    });

    const condensed = textOf(response).trim();

    // Replace entire session with the condensed context
    session.messages = [
      { role: 'user', content: `[Condensed conversation history follows]\n\n${condensed}` },
      { role: 'assistant', content: 'Understood. I have the conversation context. How can I continue helping?' },
    ];

    return condensed;
  } catch (err) {
    console.error('Condensation error:', err.message);
    return null;
  }
}

async function* chat(project, userMessage) {
  const session = getSession(project.id);
  session.messages.push({ role: 'user', content: userMessage });

  const systemPrompt = buildSystemPrompt(project);

  // Tool use loop
  while (true) {
    const stream = getClient().messages.stream({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages: session.messages,
    });

    let sawText = false;
    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          yield { type: 'tool_start', name: event.content_block.name };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          sawText = true;
          yield { type: 'text', text: event.delta.text };
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    session.messages.push({ role: 'assistant', content: finalMessage.content });

    const notice = truncationNotice(finalMessage, sawText);
    if (notice) yield { type: 'text', text: notice };

    if (finalMessage.stop_reason === 'tool_use') {
      // Execute all tool calls
      const toolResults = [];
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          yield { type: 'tool_exec', name: block.name, input: block.input };
          const result = executeTool(block.name, block.input, project.path);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
            ...(result && result.error ? { is_error: true } : {}),
          });
        }
      }
      session.messages.push({ role: 'user', content: toolResults });
      // Loop again to get the response after tool results
    } else {
      break;
    }
  }

  yield { type: 'done' };
}

function tryParseArr(val) {
  if (Array.isArray(val)) return val;
  try { const r = JSON.parse(val); return Array.isArray(r) ? r : []; } catch { return []; }
}

function buildGlobalSystemPrompt(projects, allLinks = []) {
  // Required here, not at the top: links/ requires this module for TOOLS.
  const { linksFor } = require('../links');
  const byId = new Map(projects.map(p => [p.id, p]));
  const lines = [
    'You are a project discovery assistant for the Sauron development dashboard.',
    `You have metadata for ${projects.length} scanned projects in the user\'s development environment.`,
    '',
    'PROJECT INDEX:',
    '',
  ];

  for (const p of projects) {
    const summaryText = p.summary
      ? p.summary.replace(/\nSTATUS:.*$/s, '').replace(/^#+.*\n/gm, '').trim().slice(0, 200)
      : null;
    const langs = tryParseArr(p.languages).join(', ') || p.type || 'unknown';
    const integrations = tryParseArr(p.integrations);
    const daysAgo = p.last_commit_date ? Math.floor((Date.now() - p.last_commit_date) / 86400000) : null;

    lines.push(`### ${p.name}`);
    lines.push(`- Path: ${p.path}`);
    lines.push(`- Type: ${langs}`);
    lines.push(`- Last commit: ${daysAgo !== null ? `${daysAgo}d ago` : 'no commits'}${p.last_commit_message ? ` — "${p.last_commit_message}"` : ''}`);
    if (integrations.length) lines.push(`- Integrations: ${integrations.join(', ')}`);
    if (summaryText) lines.push(`- Summary: ${summaryText}`);
    const links = allLinks.length ? linksFor(p.id, allLinks, byId) : [];
    if (links.length) {
      lines.push(`- Links: ${links.slice(0, 12).map(l => `${l.relation.toLowerCase()} ${l.otherName} (${l.identifier})${l.stale ? ' [may be outdated]' : ''}`).join('; ')}`);
    }
    lines.push('');
  }

  lines.push('RESPONSE STYLE — CRITICAL:');
  lines.push('- Return ONLY what was asked for. Nothing else.');
  lines.push('- If asked to find or list projects: return project names only, one per line. No descriptions, no dates, no headers, no grouping, no commentary.');
  lines.push('- Exception: when asked what handles, serves or supports a project, give the project, its path, and the file:line evidence from step 4.');
  lines.push('- Add a description ONLY if the user explicitly asks for one.');
  lines.push('- Never editorialize. Never add "most active", "note:", "tip:", or any unsolicited context.');
  lines.push('');
  lines.push('LINKS: "Links" lines come from Deep Scan link finding — identifiers (domains, routes, cloud resource IDs) found in both projects\' code. Use them first for questions about what serves or depends on what. A project with no Links line may simply not have been link-scanned; fall back to the method below.');
  lines.push('');
  lines.push('TOOLS:');
  lines.push('- The index above is metadata only. When a question depends on code, config or references between projects, search with search_all_projects and read with the per-project tools. Do not answer "no" from metadata alone when a search could settle it.');
  lines.push('- Per-project tools take a "project" argument: the project path from the index (preferred) or its exact name.');
  lines.push('- All tools are read-only.');
  lines.push('');
  lines.push('FINDING WHAT SERVES, HANDLES OR SUPPORTS A PROJECT:');
  lines.push('Applies to any question of the form "what handles / serves / supports / backs / talks to X", where X is a project, its name, or its path.');
  lines.push('Other code almost never names a project\'s folder path or folder name, so do not search for the path or name — go straight to step 1. Trace the connection through the identifiers the code actually uses:');
  lines.push('1. In the named project, search_files for outbound endpoints: "https?://", "baseURL|base_url|BASE_URL|endpoint|apiUrl|API_URL|host", and the network client files (APIClient, api.ts, client.py, etc.). Read the client to collect hostnames, base paths and route names.');
  lines.push('2. search_all_projects for each hostname/domain, then for distinctive route names (multi-word route names, not single common words). Ignore generic ones like "auth" or "files".');
  lines.push('3. Read the matching project\'s route definitions and infrastructure (FastAPI/Express routes, CDK/Terraform domain config) to confirm it serves those routes on that domain.');
  lines.push('4. Answer with the serving project, its path, and the file:line evidence on both sides. If step 1 finds no endpoints or step 2 finds no match, say exactly which identifiers you searched for.');
  lines.push('Never answer "nothing handles it" or "no other project" until steps 1-2 are done.');
  lines.push('The same method applies in reverse ("what calls this API?"): collect the routes and domain a backend serves, then search_all_projects for them.');

  return lines.join('\n');
}

// Global chat tools: one fleet-wide search, plus the per-project tools with a
// "project" argument naming which tracked project to run against.
const GLOBAL_TOOLS = [
  {
    name: 'search_all_projects',
    description: 'Search file contents across every tracked project at once (ripgrep, case-insensitive). Returns matches grouped by project. Use this to find which projects reference a path, name, URL, API, or identifier.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex (Rust/ripgrep syntax) or plain text.' },
        glob: { type: 'string', description: 'Optional file glob filter, e.g. "*.swift" or "*.{ts,js}".' },
      },
      required: ['pattern'],
    },
  },
  ...TOOLS.map(t => ({
    ...t,
    input_schema: {
      ...t.input_schema,
      properties: {
        project: { type: 'string', description: 'Project path from the index (preferred) or exact project name.' },
        ...t.input_schema.properties,
      },
      required: ['project', ...t.input_schema.required],
    },
  })),
];

const RG_EXCLUDES = [...SKIP_DIRS, 'DerivedData', 'Pods', '.build', '*.xcassets'];

function searchAllProjects(projects, pattern, glob) {
  if (!pattern || typeof pattern !== 'string') return { error: 'No pattern provided' };
  // The index can hold projects deleted since the last scan; rg exits 2 on them.
  projects = projects.filter(p => fs.existsSync(p.path));
  const { execFileSync } = require('child_process');
  const args = ['-n', '-i', '--no-heading', '--max-count', '5', '--max-filesize', '512K', '--max-columns', '200'];
  for (const d of RG_EXCLUDES) args.push('-g', `!${d}`);
  if (glob) args.push('-g', glob);
  args.push('-e', pattern, '--', ...projects.map(p => p.path));

  let out;
  try {
    out = execFileSync('rg', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 * 8, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'ripgrep (rg) is not installed on this machine.' };
    if (err.status === 1) return { message: `No matches in ${projects.length} projects.` };
    // status 2 with output means some paths were unreadable; keep what matched.
    if (err.status === 2 && err.stdout) out = err.stdout;
    else return { error: (err.stderr || err.message).slice(0, 500) };
  }

  // Longest path first, so a nested project claims its own files.
  const roots = [...projects].sort((a, b) => b.path.length - a.path.length);
  const byProject = new Map();
  let total = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const owner = roots.find(p => m[1] === p.path || m[1].startsWith(p.path + path.sep));
    if (!owner) continue;
    if (!byProject.has(owner.path)) byProject.set(owner.path, { project: owner.name, path: owner.path, matches: [] });
    const entry = byProject.get(owner.path);
    total++;
    if (entry.matches.length < 10) {
      entry.matches.push({ file: path.relative(owner.path, m[1]), line: Number(m[2]), text: m[3].trim().slice(0, 160) });
    }
  }
  const results = [...byProject.values()].slice(0, 40);
  return {
    projectsSearched: projects.length,
    projectsMatched: byProject.size,
    totalMatches: total,
    ...(byProject.size > results.length ? { note: `Showing 40 of ${byProject.size} matching projects. Narrow the pattern or glob.` } : {}),
    results,
  };
}

function resolveProject(projects, ref) {
  if (!ref || typeof ref !== 'string') return { error: 'No project given' };
  const byPath = projects.find(p => p.path === ref);
  if (byPath) return { project: byPath };
  const byName = projects.filter(p => p.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return { project: byName[0] };
  if (byName.length > 1) return { error: `"${ref}" matches several projects; pass the path instead: ${byName.map(p => p.path).join(', ')}` };
  return { error: `No tracked project named or located at "${ref}".` };
}

function executeGlobalTool(name, input, projects) {
  try {
    if (name === 'search_all_projects') return searchAllProjects(projects, input.pattern, input.glob);
    const resolved = resolveProject(projects, input.project);
    if (resolved.error) return { error: resolved.error };
    return dispatchTool(name, input, resolved.project.path);
  } catch (err) {
    return { error: `${name} failed: ${err.message}` };
  }
}

async function* globalChat(projects, userMessage, allLinks = []) {
  const session = getSession('global');
  session.messages.push({ role: 'user', content: userMessage });

  const systemPrompt = buildGlobalSystemPrompt(projects, allLinks);

  while (true) {
    const stream = getClient().messages.stream({
      model: MODEL,
      // 32768: thinking counts toward max_tokens, and a fleet-wide counting
      // question over ~450 projects burns tens of thousands of tokens reasoning
      // before writing a word. 16384 still came back empty against the real
      // system prompt. Streaming, so the large ceiling costs nothing when unused.
      max_tokens: 32768,
      system: systemPrompt,
      tools: GLOBAL_TOOLS,
      messages: session.messages,
    });

    let sawText = false;
    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield { type: 'tool_start', name: event.content_block.name };
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        sawText = true;
        yield { type: 'text', text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    session.messages.push({ role: 'assistant', content: finalMessage.content });

    const notice = truncationNotice(finalMessage, sawText);
    if (notice) yield { type: 'text', text: notice };

    if (finalMessage.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of finalMessage.content) {
      if (block.type !== 'tool_use') continue;
      yield { type: 'tool_exec', name: block.name, input: block.input };
      const result = executeGlobalTool(block.name, block.input, projects);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    session.messages.push({ role: 'user', content: toolResults });
  }

  yield { type: 'done' };
}

// TOOLS and executeTool are shared with the doc generator, which runs the same
// read-only tool loop outside a chat session.
module.exports = { chat, globalChat, clearSession, condenseSession, getSession, TOOLS, executeTool };

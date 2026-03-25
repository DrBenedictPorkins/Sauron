const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { MODEL } = require('../models');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
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
  if (!full.startsWith(projectRoot)) return null;
  return full;
}

function executeTool(toolName, input, projectRoot) {
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
- You can ONLY read files within this project directory. No modifications, no writes, no deletes.
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
      max_tokens: 1024,
      messages: [{ role: 'user', content: condensationPrompt }],
    });

    const condensed = response.content[0].text.trim();

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
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages: session.messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          yield { type: 'tool_start', name: event.content_block.name };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', text: event.delta.text };
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    session.messages.push({ role: 'assistant', content: finalMessage.content });

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

module.exports = { chat, clearSession, condenseSession, getSession };

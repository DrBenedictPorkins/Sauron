const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MODEL, PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN } = require('../models');
const { TOOLS, executeTool } = require('../chat');

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Drafts never touch the project. They live in a per-project scratch directory
// under the OS temp dir, are served read-only for download, and are deleted when
// the user closes the dialog. Writing into the repo stays a human action.
const DRAFT_ROOT = path.join(os.tmpdir(), 'sauron-drafts');

const KINDS = {
  'CLAUDE.md': `Write a CLAUDE.md for this project: guidance for an AI coding assistant working in this repository.

Cover, only where the code actually supports it: the commands to run, build and test; the architecture and module layout; the data flow; and any non-obvious design decisions a newcomer would get wrong. Be concrete and specific to this repository — no filler, no generic advice, no invented features.

Output the file contents as markdown and nothing else: no preamble, no explanation, no code fence around the whole document.`,

  'README.md': `Write a README.md for this project, aimed at a developer seeing it for the first time.

Cover, only where the code actually supports it: what it does and why, how to install and configure it, how to run it, and the key concepts needed to use it. Be concrete and specific to this repository — no filler, no badges, no invented features, no roadmap you cannot evidence from the code.

Output the file contents as markdown and nothing else: no preamble, no explanation, no code fence around the whole document.`,
};

function draftDir(projectId) {
  return path.join(DRAFT_ROOT, projectId);
}

function listDrafts(projectId) {
  const dir = draftDir(projectId);
  try {
    return fs.readdirSync(dir)
      .filter(name => KINDS[name])
      .map(name => ({ name, bytes: fs.statSync(path.join(dir, name)).size }));
  } catch {
    return [];
  }
}

function readDraft(projectId, name) {
  // Only the exact filenames this module generates are readable — the name comes
  // from a URL, so nothing else may be resolved against the draft directory.
  if (!KINDS[name]) return null;
  try {
    return fs.readFileSync(path.join(draftDir(projectId), name), 'utf8');
  } catch {
    return null;
  }
}

function discardDrafts(projectId) {
  fs.rmSync(draftDir(projectId), { recursive: true, force: true });
}

function buildSystemPrompt(project) {
  return `You are documenting the software project "${project.name}" at ${project.path}.

Use the tools to read the code before you write anything. Look at the entry point, the directory structure, the dependency manifest, the configuration, and enough of the source to describe what the project genuinely does. Do not guess, and do not describe features you have not seen in the code.

Project type: ${project.type}
Languages: ${(JSON.parse(project.languages || '[]')).join(', ') || 'unknown'}
Detected integrations: ${(JSON.parse(project.integrations || '[]')).join(', ') || 'none'}`;
}

// One-shot: a fresh message list per document, with no chat session involved, so
// a generation can't be contaminated by (or leak into) the project's chat.
async function generateOne(project, filename) {
  const messages = [{ role: 'user', content: KINDS[filename] }];
  const system = buildSystemPrompt(project);
  let inputTokens = 0;
  let outputTokens = 0;
  const toolsUsed = [];

  for (let turn = 0; turn < 16; turn++) {
    const stream = getClient().messages.stream({
      model: MODEL,
      max_tokens: 16384,
      system,
      tools: TOOLS,
      messages,
    });
    for await (const _ of stream) { /* drain; the final message is what matters */ }
    const final = await stream.finalMessage();

    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;
    messages.push({ role: 'assistant', content: final.content });

    if (final.stop_reason !== 'tool_use') {
      const text = final.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (!text) {
        throw new Error(`The model returned no text for ${filename} (stop_reason: ${final.stop_reason}).`);
      }
      return { text, inputTokens, outputTokens, toolsUsed };
    }

    const results = [];
    for (const block of final.content) {
      if (block.type !== 'tool_use') continue;
      toolsUsed.push(block.name);
      const result = executeTool(block.name, block.input, project.path);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  throw new Error(`Gave up generating ${filename} after 16 tool-use turns.`);
}

async function generateDocs(project, filenames) {
  const wanted = filenames.filter(f => KINDS[f]);
  if (wanted.length === 0) throw new Error('Nothing to generate.');

  const dir = draftDir(project.id);
  fs.mkdirSync(dir, { recursive: true });

  const files = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const toolsUsed = [];

  for (const filename of wanted) {
    const one = await generateOne(project, filename);
    fs.writeFileSync(path.join(dir, filename), one.text, 'utf8');
    files.push({ name: filename, bytes: Buffer.byteLength(one.text, 'utf8') });
    inputTokens += one.inputTokens;
    outputTokens += one.outputTokens;
    toolsUsed.push(...one.toolsUsed);
  }

  return {
    dir,
    files,
    inputTokens,
    outputTokens,
    toolsUsed,
    cost: inputTokens * PRICE_PER_INPUT_TOKEN + outputTokens * PRICE_PER_OUTPUT_TOKEN,
  };
}

module.exports = { generateDocs, listDrafts, readDraft, discardDrafts, draftDir, KINDS };

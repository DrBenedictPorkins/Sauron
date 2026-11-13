const Anthropic = require('@anthropic-ai/sdk');
const { updateSummary } = require('../db');
const { MODEL, PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN } = require('../models');

let client = null;

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function buildPrompt(project, transient) {
  // Docs live under transient.context (analyzer nests them there); recentCommits
  // is top-level. Reading them off transient directly left readme/claudeMd
  // undefined, so the AI never actually saw the project docs.
  const { context = {}, recentCommits = [] } = transient;
  const { readme, claudeMd } = context;
  const languages = JSON.parse(project.languages || '[]').join(', ');
  const integrations = JSON.parse(project.integrations || '[]').join(', ') || 'none';
  const commits = recentCommits.length > 0
    ? recentCommits.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : 'none';

  return `You are analyzing a software project for a developer's project dashboard.

Project: ${project.name}
Type: ${project.type}
Languages: ${languages}
Integrations: ${integrations}

${readme ? `README:\n${readme}\n` : ''}
${claudeMd ? `CLAUDE.md:\n${claudeMd}\n` : ''}
Recent commits:
${commits}

Write a concise project summary in 2-3 sentences (under 80 words). Be specific about what the project does, not generic. Just the summary as plain text — no headings, titles, labels, or markdown.`;
}

async function summarize(project, transient) {
  const prompt = buildPrompt(project, transient);

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      // 600, not 200: thinking tokens count toward max_tokens, and at 200 the
      // 5.x models truncated 3 of 10 real summaries mid-sentence. Measured
      // ceiling across those 10 was 291 output tokens.
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    // Not content[0]: on models with thinking on by default the first block is a
    // thinking block, and .text is undefined.
    const summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!summary) {
      console.error(`Summarizer returned no text for ${project.name} (stop_reason: ${response.stop_reason})`);
      return null;
    }
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const cost = inputTokens * PRICE_PER_INPUT_TOKEN + outputTokens * PRICE_PER_OUTPUT_TOKEN;

    updateSummary(project.id, summary, transient.commitHash);
    return { summary, inputTokens, outputTokens, cost };
  } catch (err) {
    console.error(`Summarizer error for ${project.name}:`, err.message);
    return null;
  }
}

function needsSummaryRefresh(dbProject, currentCommitHash, force = false) {
  // Manual scans (user-requested) always regenerate.
  if (force) return true;
  // Never summarized yet — must generate once.
  if (!dbProject || !dbProject.summary) return true;
  // No commit hash (no git, or git with no commits): there's no version signal
  // to detect modification, so don't auto-regenerate — only a manual scan will.
  if (!currentCommitHash) return false;
  // Otherwise regenerate only when the project actually changed (new commit).
  // No time-based staleness: unmodified projects keep their summary indefinitely.
  return currentCommitHash !== dbProject.summary_commit_hash;
}

module.exports = { summarize, needsSummaryRefresh };

const Anthropic = require('@anthropic-ai/sdk');
const { updateSummary } = require('../db');
const { MODEL, PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN } = require('../models');

let client = null;

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function buildPrompt(project, transient) {
  const { readme, claudeMd, recentCommits } = transient;
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
Branch: ${project.branch || 'unknown'}
Commits in last 30 days: ${project.commit_count_30d || 0}
Has uncommitted changes: ${project.has_uncommitted ? 'yes' : 'no'}

${readme ? `README:\n${readme}\n` : ''}
${claudeMd ? `CLAUDE.md:\n${claudeMd}\n` : ''}
Recent commits:
${commits}

Write a concise project summary in 2-3 sentences. Do NOT use headings, titles, or labels like "Project Summary:". Just write the summary directly as plain text.

Then on a new line starting with "STATUS:", write one of: Active, Stale, Abandoned, Early Stage — and a brief reason (one sentence).

Keep the whole response under 120 words. Be specific about what the project does, not generic. No markdown headings.`;
}

async function summarize(project, transient) {
  const prompt = buildPrompt(project, transient);

  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = response.content[0].text.trim();
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

function needsSummaryRefresh(dbProject, currentCommitHash) {
  if (!dbProject || !dbProject.summary) return true;
  if (!dbProject.summary_commit_hash) return true;
  if (currentCommitHash && currentCommitHash !== dbProject.summary_commit_hash) return true;
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  if (!dbProject.summary_generated_at || Date.now() - dbProject.summary_generated_at > sevenDays) return true;
  return false;
}

module.exports = { summarize, needsSummaryRefresh };

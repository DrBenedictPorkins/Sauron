const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { MODEL, PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN } = require('../models');
const { TOOLS, executeTool } = require('../chat');

// Cross-project link finding, run as an optional Deep Scan phase.
//
// Two halves, deliberately unequal in cost:
//   1. AI (one project at a time): read this project's code and report the
//      distinctive identifiers it consumes and provides — hostnames, routes,
//      cloud resource IDs. Billed.
//   2. Local (whole fleet): ripgrep every tracked project for those exact
//      identifiers. Free. This is why a scan of one project still finds its
//      counterpart in a project that has never been deep-scanned.

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const KINDS = ['domain', 'url', 'route', 'cloud_resource', 'database', 'queue', 'storage', 'package', 'other'];

const REPORT_TOOL = {
  name: 'report_links',
  description: 'Report what this project consumes from and provides to other software. Call exactly once, when you are done reading.',
  input_schema: {
    type: 'object',
    properties: {
      consumes: {
        type: 'array',
        description: 'Things this project calls or depends on that live outside it.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            value: { type: 'string', description: 'The identifier exactly as it appears in the code.' },
            evidence: { type: 'string', description: 'relative/path:line where it appears.' },
          },
          required: ['kind', 'value', 'evidence'],
        },
      },
      provides: {
        type: 'array',
        description: 'Things this project serves, deploys or defines that other software could use.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            value: { type: 'string', description: 'The identifier exactly as it appears in the code.' },
            evidence: { type: 'string', description: 'relative/path:line where it appears.' },
          },
          required: ['kind', 'value', 'evidence'],
        },
      },
    },
    required: ['consumes', 'provides'],
  },
};

const PROMPT = `Find this project's connections to the user's other projects: what it consumes from them and what it provides to them.

Read the code. Look at network clients, configuration, deployment and infrastructure files (CDK, Terraform, serverless, docker-compose, CI workflows), and route definitions. Collect:
- Hostnames and base URLs it calls, and the API routes it calls on them.
- Domains it is deployed on, and the API routes it serves.
- Cloud resource identifiers it creates or references: hosted zone IDs, certificate ARNs, bucket, table, queue and topic names, Lambda function names, SSM parameter paths, secret names.
- Database names, Docker image names, and packages it publishes or consumes by local path.

Report only identifiers distinctive enough to appear verbatim in another of the user's projects. A full hostname, a specific route name, a resource ID or ARN, a named bucket. Skip:
- Generic values: localhost, 127.0.0.1, ports, "api", "auth", "/files", "/health", "index".
- Account-wide values that every project in the same cloud account shares: AWS account IDs, regions, organization IDs. Report the specific resource (its full ARN, zone ID or name) instead.
- Public third-party services the user does not own: api.anthropic.com, api.openai.com, github.com, googleapis.com, amazonaws.com service endpoints, CDNs, package registries.
- Anything that is a secret: keys, tokens, passwords. Never report a credential value.

Give evidence as relative/path:line for each. Then call report_links once. Empty lists are a valid answer.`;

// .env files hold credentials. The chat can read them; this unattended pass
// must not, because the Deep Scan dialog promises they are never sent.
function isSecretFile(relativePath) {
  const base = path.basename(relativePath || '');
  return /^\.env(\..+)?$/i.test(base) && base.toLowerCase() !== '.env.example';
}

function runTool(name, input, projectRoot) {
  if ((name === 'read_file' || name === 'get_file_info') && isSecretFile(input.relative_path)) {
    return { error: '.env files are not readable during link finding.' };
  }
  return executeTool(name, input, projectRoot);
}

const MIN_IDENTIFIER_LENGTH = 6;

function cleanEntries(list) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e.value !== 'string') continue;
    const value = e.value.trim();
    if (value.length < MIN_IDENTIFIER_LENGTH) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: KINDS.includes(e.kind) ? e.kind : 'other', value, evidence: String(e.evidence || '') });
    if (out.length >= 30) break;
  }
  return out;
}

// Tokens spent before a failure are still billed, so the error carries them.
function failure(message, inputTokens, outputTokens) {
  const err = new Error(message);
  err.inputTokens = inputTokens;
  err.outputTokens = outputTokens;
  return err;
}

async function extractFacts(project) {
  const messages = [{ role: 'user', content: PROMPT }];
  const system = `You are mapping the software project "${project.name}" at ${project.path}. Every tool is read-only.`;
  let inputTokens = 0;
  let outputTokens = 0;
  let nudged = false;

  for (let turn = 0; turn < 20; turn++) {
    const stream = getClient().messages.stream({
      model: MODEL,
      max_tokens: 16384,
      system,
      tools: [...TOOLS, REPORT_TOOL],
      messages,
    });
    for await (const _ of stream) { /* drain */ }
    const final = await stream.finalMessage();
    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;
    messages.push({ role: 'assistant', content: final.content });

    const report = final.content.find(b => b.type === 'tool_use' && b.name === 'report_links');
    if (report) {
      return {
        facts: { consumes: cleanEntries(report.input.consumes), provides: cleanEntries(report.input.provides) },
        inputTokens,
        outputTokens,
      };
    }
    if (final.stop_reason !== 'tool_use') {
      // Seen in practice: the model writes its findings as prose and ends the
      // turn. Ask once for the structured report before giving up.
      if (final.stop_reason === 'end_turn' && !nudged) {
        nudged = true;
        messages.push({ role: 'user', content: 'Now call report_links with your findings. Empty lists are fine.' });
        continue;
      }
      throw failure(`Model stopped without reporting links (stop_reason: ${final.stop_reason}).`, inputTokens, outputTokens);
    }

    const results = [];
    for (const block of final.content) {
      if (block.type !== 'tool_use') continue;
      const result = runTool(block.name, block.input, project.path);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  throw failure('Gave up after 20 tool-use turns without a report.', inputTokens, outputTokens);
}

const RG_EXCLUDES = ['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next',
  'coverage', '.cache', 'DerivedData', 'Pods', '.build', '*.xcassets', '*.lock', 'package-lock.json'];

// An identifier found in more projects than this is shared boilerplate, not a link.
const MAX_PROJECTS_PER_IDENTIFIER = 15;

function matchFleet(project, facts, fleet) {
  const entries = [
    ...facts.consumes.map(e => ({ ...e, direction: 'consumes' })),
    ...facts.provides.map(e => ({ ...e, direction: 'provides' })),
  ];
  const others = fleet.filter(p => p.id !== project.id && fs.existsSync(p.path));
  if (entries.length === 0 || others.length === 0) return { edges: [], tooCommon: [] };

  const args = ['-F', '-i', '-n', '--no-heading', '--max-count', '3', '--max-filesize', '512K', '--max-columns', '300'];
  for (const d of RG_EXCLUDES) args.push('-g', `!${d}`);
  for (const e of entries) args.push('-e', e.value);
  args.push('--', ...others.map(p => p.path));

  let out = '';
  try {
    out = execFileSync('rg', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 * 16, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('ripgrep (rg) is required for link finding and is not installed.');
    if (err.status === 1) return { edges: [], tooCommon: [] };
    if (err.stdout) out = err.stdout;
    else throw new Error(`ripgrep failed: ${(err.stderr || err.message).slice(0, 300)}`);
  }

  // Longest root first so a nested project owns its own files; a match that
  // resolves to the scanned project itself (a nested parent) is dropped.
  const roots = [...others, project].sort((a, b) => b.path.length - a.path.length);
  const hits = new Map(); // entry index -> Map(otherId -> [file:line])
  for (const line of out.split('\n')) {
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const owner = roots.find(p => m[1] === p.path || m[1].startsWith(p.path + path.sep));
    if (!owner || owner.id === project.id) continue;
    const text = m[3].toLowerCase();
    entries.forEach((e, i) => {
      if (!text.includes(e.value.toLowerCase())) return;
      if (!hits.has(i)) hits.set(i, new Map());
      const byOther = hits.get(i);
      if (!byOther.has(owner.id)) byOther.set(owner.id, []);
      const refs = byOther.get(owner.id);
      if (refs.length < 3) refs.push(`${path.relative(owner.path, m[1])}:${m[2]}`);
    });
  }

  const byId = new Map(others.map(p => [p.id, p]));
  const edges = [];
  const tooCommon = [];
  for (const [i, byOther] of hits) {
    const e = entries[i];
    if (byOther.size > MAX_PROJECTS_PER_IDENTIFIER) {
      tooCommon.push({ value: e.value, projects: byOther.size });
      continue;
    }
    for (const [otherId, refs] of byOther) {
      edges.push({
        other_id: otherId,
        direction: e.direction,
        kind: e.kind,
        identifier: e.value,
        evidence: e.evidence,
        other_evidence: refs,
        other_commit: byId.get(otherId).commit_hash || null,
      });
    }
  }
  // Route names recur across unrelated APIs (two "upload-complete" endpoints
  // need not be the same one). Keep a project's route matches only when it also
  // matched a non-route identifier — a domain or resource ID.
  const perOther = new Map();
  for (const e of edges) {
    if (!perOther.has(e.other_id)) perOther.set(e.other_id, []);
    perOther.get(e.other_id).push(e);
  }
  const kept = [];
  for (const list of perOther.values()) {
    const routes = list.filter(e => e.kind === 'route');
    if (routes.length === list.length) continue;
    kept.push(...list);
  }
  return { edges: kept, tooCommon };
}

async function findLinks(project, fleet) {
  if (!fs.existsSync(project.path)) {
    throw failure(`${project.path} no longer exists — run a Quick Scan to pick up moves and renames.`, 0, 0);
  }
  const { facts, inputTokens, outputTokens } = await extractFacts(project);
  const { edges, tooCommon } = matchFleet(project, facts, fleet);
  return {
    facts: { ...facts, tooCommon },
    edges,
    inputTokens,
    outputTokens,
    cost: inputTokens * PRICE_PER_INPUT_TOKEN + outputTokens * PRICE_PER_OUTPUT_TOKEN,
  };
}

function needsLinksRefresh(dbProject, currentCommitHash, force = false) {
  if (force) return true;
  if (!dbProject || !dbProject.links_checked_at) return true;
  if (!currentCommitHash) return false;
  return currentCommitHash !== dbProject.links_commit_hash;
}

// --- Reading links back, from one project's point of view ---

function parseFacts(p) {
  try { return p && p.link_facts ? JSON.parse(p.link_facts) : null; } catch { return null; }
}

function roleIn(facts, identifier) {
  if (!facts) return null;
  const v = identifier.toLowerCase();
  if ((facts.provides || []).some(e => e.value.toLowerCase() === v)) return 'provides';
  if ((facts.consumes || []).some(e => e.value.toLowerCase() === v)) return 'consumes';
  return null;
}

const RELATION = {
  'consumes|provides': 'Provided by',
  'provides|consumes': 'Used by',
  'consumes|consumes': 'Also used by',
  'provides|provides': 'Also provided by',
  'consumes|null': 'Found in',
  'provides|null': 'Referenced by',
  'null|consumes': 'Used by',
  'null|provides': 'Provided by',
  'null|null': 'Shared with',
};

// Edges are stored from the scanned project's side. A project sees both the
// edges its own scans produced and the ones other projects' scans found in it.
function linksFor(projectId, allEdges, projectsById) {
  const me = projectsById.get(projectId);
  const myFacts = parseFacts(me);
  const out = [];
  for (const e of allEdges) {
    let otherId, myEvidence, otherEvidence, otherIsScanner;
    if (e.project_id === projectId) {
      otherId = e.other_id; myEvidence = [e.evidence]; otherEvidence = JSON.parse(e.other_evidence || '[]'); otherIsScanner = false;
    } else if (e.other_id === projectId) {
      otherId = e.project_id; myEvidence = JSON.parse(e.other_evidence || '[]'); otherEvidence = [e.evidence]; otherIsScanner = true;
    } else continue;
    const other = projectsById.get(otherId);
    // Moved or deleted since the link was found; the index row lingers until pruned.
    if (!other || !fs.existsSync(other.path)) continue;

    const myRole = otherIsScanner ? roleIn(myFacts, e.identifier) : e.direction;
    const otherRole = otherIsScanner ? e.direction : roleIn(parseFacts(other), e.identifier);
    const scanner = otherIsScanner ? other : me;
    const counterpart = otherIsScanner ? me : other;
    const stale = (scanner.commit_hash && scanner.commit_hash !== scanner.links_commit_hash)
      || (e.other_commit && counterpart.commit_hash && e.other_commit !== counterpart.commit_hash);

    out.push({
      relation: RELATION[`${myRole}|${otherRole}`],
      otherId,
      otherName: other.user_label || other.name,
      otherPath: other.path,
      kind: e.kind,
      identifier: e.identifier,
      myEvidence: myEvidence.filter(Boolean),
      otherEvidence: otherEvidence.filter(Boolean),
      stale: !!stale,
    });
  }
  // The same pair can be found from both sides; keep one row per pair+identifier.
  const seen = new Set();
  return out.filter(l => {
    const k = `${l.otherId}|${l.identifier.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { findLinks, needsLinksRefresh, linksFor, parseFacts };

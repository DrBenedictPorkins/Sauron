// Model and pricing — pricing is not exposed by the Anthropic API (models.retrieve
// returns capabilities and limits, no price), so the table below is maintained by
// hand. Keyed off CLAUDE_MODEL so changing the model can't silently leave stale
// prices behind. Source: https://www.anthropic.com/pricing (checked 2026-10-09).
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';

// Per-million-token prices: [input, output]. Haiku 5.5 is the model this app
// runs on, so it's the only one listed. Any other model needs PRICE_INPUT_MTOK
// and PRICE_OUTPUT_MTOK in .env, or the server refuses to start — which is the
// point: an unpriced model would make the cost meter report a false number.
const PRICING = {
  'claude-haiku-5-5': [0.10, 0.50],
};

// A missing or unparseable price would make the cost meter report a number that
// is simply false, so refuse to start instead. Env vars win, so an unlisted or
// repriced model is corrected in .env without touching this file.
function resolvePrice(envVar, tableValue, label) {
  const raw = process.env[envVar];
  if (raw !== undefined && raw !== '') {
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${envVar}="${raw}" is not a valid price. Set it to the ${label} price per million tokens for ${MODEL}.`);
    }
    return parsed;
  }
  if (tableValue === undefined) {
    throw new Error(
      `No ${label} price on record for CLAUDE_MODEL="${MODEL}". ` +
      `Set PRICE_INPUT_MTOK and PRICE_OUTPUT_MTOK in .env (per million tokens, from https://www.anthropic.com/pricing), ` +
      `or add ${MODEL} to the PRICING table in src/models.js.`
    );
  }
  return tableValue;
}

const [tableInput, tableOutput] = PRICING[MODEL] || [];
const PRICE_PER_INPUT_TOKEN = resolvePrice('PRICE_INPUT_MTOK', tableInput, 'input') / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN = resolvePrice('PRICE_OUTPUT_MTOK', tableOutput, 'output') / 1_000_000;

module.exports = { MODEL, PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN };

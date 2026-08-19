// ── HOSTED MODEL PROXY (Vercel serverless function) ──────────────────
// Only used by PUBLISHED copies of the app. Locally the browser talks to
// Ollama directly and this file never runs.
//
// Why it exists: a published site needs an API key to reach a hosted
// model, and a key in the repo is a key on GitHub — scrapers find those
// within hours. So the key lives in a Vercel environment variable, the
// browser only ever calls same-origin /api, and the key stays server-side.
// Same-origin also means no CORS setup for visitors, ever.
//
// Set on Vercel → Settings → Environment Variables:
//   MODEL_API_KEY   (required)  your OWN provider key, e.g. a free Groq key.
//                               Every visitor's message spends your allowance.
//   MODEL_API_BASE  (optional)  defaults to Groq
//   MODEL_NAME      (optional)  which model(s) to offer, comma-separated.
//                               Unset = every chat model the key can reach,
//                               and visitors choose from the picker. Set =
//                               only these, in this order; one name pins the
//                               site to one model.
// The one-variable path is the taught one: set MODEL_API_KEY, redeploy, done.
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_BASE = 'https://api.groq.com/openai/v1';

// Deliberately NOT a hardcoded model to serve. A pinned name is a dead site
// the day the provider retires it — Groq shut down llama-3.1-8b-instant on
// 2026-08-16 and every published copy pinned to it began answering 404 with a
// perfectly good key. The real list comes from the provider at request time
// (see liveModels); this is only the last resort for preselecting something
// when that list cannot be read at all.
const FALLBACK_MODEL = 'openai/gpt-oss-20b';

// /models lists speech, embedding, and safety models beside the chat ones,
// and every one of them either 400s or answers nonsense when handed a
// conversation. The picker should only ever offer what can actually chat.
const NON_CHAT = /whisper|tts|embedding|embed|rerank|guard|moderation/i;

// The list changes on the order of weeks, and a serverless instance is reused
// across many requests, so a short in-process cache keeps page loads from
// spending a round trip each to learn the same thing.
const MODELS_TTL_MS = 5 * 60 * 1000;
let _modelCache = { at: 0, ids: null };

// This endpoint is public and unauthenticated — anyone with the URL can
// spend the owner's own quota. The key is theirs, created on their own
// provider account; visitors never see it and never pay for it. The client
// cannot ask for a huge completion, cannot send an enormous prompt, and
// cannot name a model the provider does not actually serve.
const MAX_TOKENS_CAP = 512;
const MAX_BODY_BYTES = 128 * 1024;

function config() {
  return {
    base: (process.env.MODEL_API_BASE || DEFAULT_BASE).replace(/\/+$/, ''),
    key: process.env.MODEL_API_KEY || '',
    // MODEL_NAME is optional and means "offer exactly these". Unset is a
    // first-class state, not a missing setting: leave it out and visitors get
    // every chat model the key can reach. Comma-separated for a shortlist;
    // one name pins the site to one model, which is the old behaviour for
    // anyone who wants it. Order is kept — the app preselects the first.
    pinned: (process.env.MODEL_NAME || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

// The owner's list wins, but only over models that actually exist. Naming
// nothing but retired models would otherwise reproduce the exact outage this
// file exists to prevent, so an allowlist that matches nothing live is
// treated as no allowlist at all: a site with an out-of-date MODEL_NAME
// degrades to "more models than the owner picked", never to a dead site.
function applyPin(ids, pinned) {
  const kept = pinned.filter(n => ids.includes(n));
  if (kept.length) return kept;
  // No allowlist, or none of it survives: offer everything, but lead with the
  // small fast model when it is on offer. The app preselects the head of the
  // list, and a visitor who never opens the picker should land on the cheap
  // one rather than on whichever the provider happened to list first.
  return ids.includes(FALLBACK_MODEL)
    ? [FALLBACK_MODEL, ...ids.filter(id => id !== FALLBACK_MODEL)]
    : ids;
}

// Ask the provider what this key can actually reach. Throws with .status
// attached so an auth failure can be forwarded rather than disguised as an
// empty model list.
async function liveModels(cfg) {
  const now = Date.now();
  if (_modelCache.ids && now - _modelCache.at < MODELS_TTL_MS) return _modelCache.ids;

  const res = await fetch(`${cfg.base}/models`, {
    headers: { 'Authorization': `Bearer ${cfg.key}` },
  });
  if (!res.ok) {
    const err = new Error(`models list unavailable (HTTP ${res.status})`);
    err.status = res.status;
    err.body = await res.text();
    throw err;
  }
  const data = await res.json();
  const ids = (data.data || data.models || [])
    .map(m => m && (m.id || m.name))
    .filter(id => typeof id === 'string' && id && !NON_CHAT.test(id));

  const offered = applyPin(ids, cfg.pinned);
  _modelCache = { at: now, ids: offered };
  return offered;
}

// Whatever happens, the picker gets at least one name to show — a site whose
// /models is momentarily unreachable is still worth trying to chat with.
function degradedIds(cfg) {
  return [cfg.pinned[0] || FALLBACK_MODEL];
}

// Reported to the app as an ordinary /v1/models response so the existing
// discovery code (app/models.js) needs no special case: the visitor's picker
// lists exactly what the owner's key can reach, and the first entry is the
// one the app preselects.
async function sendModels(res, cfg) {
  let ids;
  try {
    ids = await liveModels(cfg);
  } catch (err) {
    // A rejected key is worth telling the truth about — the app turns this
    // into "the owner needs to replace the key", which no amount of retrying
    // would have discovered on its own.
    if (err.status === 401 || err.status === 403) {
      res.status(err.status);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(err.body || JSON.stringify({ error: { message: 'The provider rejected this key.' } }));
      return;
    }
    ids = degradedIds(cfg);
  }
  if (!ids.length) ids = degradedIds(cfg);
  res.status(200).json({
    object: 'list',
    data: ids.map(id => ({ id, object: 'model', owned_by: 'published' })),
  });
}

// Numeric knobs the app exposes in Settings → Model that every
// OpenAI-compatible provider accepts. Anything not named here never reaches
// upstream — see buildPayload.
const PASSTHROUGH_NUMBERS = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed'];

// role + content only. Extra per-message fields are dropped on purpose:
// `messages[].name`, for one, is a documented 400 on Groq.
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const m of input) {
    if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// The client may choose, but only from the list this same proxy just handed
// it — which is the pinned list when MODEL_NAME is set, so a restriction the
// owner made in an env var cannot be undone from the browser. Anything else —
// a stale cached copy of the app, a visitor on an older deploy, someone poking
// /api directly with an expensive model name — loses to that list rather than
// reaching the provider. When the list could not be read at all the client's
// choice is not honoured either: unvalidated is exactly the case where
// trusting a public endpoint is worst.
function pickModel(requested, ids, cfg) {
  if (ids.length && typeof requested === 'string' && ids.includes(requested)) return requested;
  return ids[0] || cfg.pinned[0] || FALLBACK_MODEL;
}

// The client body is advisory, and on a published site it is also untrusted.
// Forwarding it verbatim is what broke published chat once before — the app
// used to attach chat_template_kwargs, an Ollama-only field, and providers
// answer 400 Bad Request for fields they do not recognise. So the upstream
// request is rebuilt from an allowlist rather than spread from input, which
// also means a future client-side option cannot silently break every
// published site until it is added here deliberately.
function buildPayload(body, model) {
  const requested = Number(body.max_tokens);
  const payload = {
    model,
    messages: sanitizeMessages(body.messages),
    // The owner's ceiling, not the client's.
    max_tokens: Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), MAX_TOKENS_CAP))
      : MAX_TOKENS_CAP,
  };
  for (const k of PASSTHROUGH_NUMBERS) {
    const n = Number(body[k]);
    if (body[k] !== undefined && body[k] !== null && Number.isFinite(n)) payload[k] = n;
  }
  if (body.stream === true) {
    payload.stream = true;
    if (body.stream_options && typeof body.stream_options === 'object') {
      payload.stream_options = { include_usage: body.stream_options.include_usage === true };
    }
  }
  if (typeof body.stop === 'string') payload.stop = body.stop;
  else if (Array.isArray(body.stop)) {
    const stops = body.stop.filter(s => typeof s === 'string').slice(0, 4);
    if (stops.length) payload.stop = stops;
  }
  return payload;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) return resolve(req.body);   // already parsed by the runtime
    let size = 0;
    const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const cfg = config();
  const what = (req.query && req.query.p) || 'chat';

  // Unconfigured is the single most likely state for a fresh deploy (the
  // student pushed before adding the key), so it gets a message the app
  // can show a human rather than a raw network failure.
  if (!cfg.key) {
    res.status(503).json({
      error: {
        message: 'This AI has no model connected yet. The owner needs to add a MODEL_API_KEY environment variable on Vercel and redeploy.',
        code: 'model_not_configured',
      },
    });
    return;
  }

  if (what === 'models') {
    await sendModels(res, cfg);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.status(413).json({ error: { message: 'Request too large' } });
    return;
  }

  // A failure here is not fatal to the request: pickModel falls back to the
  // owner's preference instead of honouring the client's choice.
  let ids = [];
  try { ids = await liveModels(cfg); } catch (e) {}

  const payload = buildPayload(body, pickModel(body.model, ids, cfg));

  // Catch this here rather than letting the provider answer 400 — upstream's
  // wording would surface to the visitor as an unexplained failure.
  if (!payload.messages.length) {
    res.status(400).json({
      error: { message: 'No messages to send.', code: 'no_messages' },
    });
    return;
  }

  try {
    const upstream = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.key}`,
      },
      body: JSON.stringify(payload),
    });

    res.status(upstream.status);
    const type = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');

    if (!upstream.body) {
      res.end(await upstream.text());
      return;
    }

    // Pass the SSE stream straight through, unbuffered, so replies appear
    // word by word exactly as they do against a local Ollama — the client
    // parser in app/chat.js sees the same shape either way.
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.status(502).json({
      error: { message: 'Could not reach the model provider. Check the key and try again.', detail: String(err && err.message || err) },
    });
  }
};

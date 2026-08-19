// ── PUBLISH / VISITOR MODE ────────────────────────────────────────────
// The camp's real deliverable is the private AI running on the student's
// own machine. This file adds the epilogue: a way to hand that same AI to
// other people as a link.
//
// The problem it solves: everything Settings saves lives in the browser's
// own SQLite/IndexedDB (see db.js), so `git push` would deploy the stock
// app — none of the student's work travels. Publishing exports that state
// to `my-ai.json`, which IS committed. When the app boots and finds that
// file on a non-localhost host, it runs in VISITOR MODE: the owner's AI,
// usable by anyone, changeable by no one.
//
// Deliberately NOT in the exported file: API keys of any kind. The file is
// committed to a public fork, and committed keys get scraped. The hosted
// model's key lives in a Vercel environment variable and is only ever seen
// by api/proxy.js on the server.
// ─────────────────────────────────────────────────────────────────────

const PUBLISH_FILE = 'my-ai.json';

// Loaded once at boot by init.js; null when this is an unpublished copy.
window.PUBLISHED_CONFIG = null;
window.IS_VISITOR = false;

function isLocalHost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '';
}

// `?visitor=1` lets the owner preview exactly what the world will see
// without deploying. It only does anything when a published config exists,
// so it can't put an unpublished copy into a half-configured locked state.
function wantsVisitorPreview() {
  try { return new URLSearchParams(location.search).get('visitor') === '1'; }
  catch { return false; }
}

// Missing file = not published; that's the normal case for every fresh
// clone, so a 404 here is expected and must stay silent. A server that
// answers 404s with index.html would hand us HTML instead of JSON — the
// parse fails, and an unpublished copy is still the right answer.
async function loadPublishedConfig() {
  try {
    const res = await fetch(PUBLISH_FILE, { cache: 'no-cache' });
    if (!res.ok) return null;
    const cfg = JSON.parse(await res.text());
    if (!cfg || typeof cfg !== 'object' || !cfg.settings) return null;
    return cfg;
  } catch {
    return null;
  }
}

// Published + not on the student's own machine → locked. The host check is
// what keeps the owner's local copy fully editable after they publish:
// they keep customizing on localhost and republish, which is exactly the
// git loop the camp is teaching.
function isVisitorMode(cfg) {
  if (!cfg) return false;
  return !isLocalHost() || wantsVisitorPreview();
}

// Turn the published file back into the settings object applySettings()
// already knows how to consume (app/settings.js). Chunks are recomputed
// rather than stored so the committed file stays small and diffable.
function hydratePublishedSettings(cfg) {
  const s = Object.assign({}, cfg.settings || {});
  s.training_files = (cfg.sources || []).map(f => ({
    name: f.name,
    size: f.size || (f.content || '').length,
    content: f.content || '',
    chunks: window.BarangayRAG ? window.BarangayRAG.chunkText(f.content || '') : [],
    addedAt: f.addedAt || Date.now(),
  }));
  // A visitor must never inherit the owner's keys or spend their quota.
  delete s.tavily_api_key;
  s.web_search_enabled = false;
  return s;
}

// ── VISITOR LOCKDOWN ──────────────────────────────────────────────────
// Owner-only chrome is REMOVED from the DOM, not just hidden. Hiding with
// CSS leaves the buttons one devtools toggle away from working, which is
// not what "visitors can't personalize it" should mean. The body class
// stays too, so anything rendered later (the welcome screen re-renders on
// every new chat) is covered by the stylesheet rule as well.
function lockVisitorUI() {
  document.body.classList.add('visitor-mode');
  // data-visitor-ok is the opt-back-in: the model picker is owner-only in
  // spirit but a published site now serves a real list of models through
  // /api, and a list nobody can open is not a list. The owner-only controls
  // INSIDE it (the "+" that opens Add Models) keep the plain attribute and
  // are still removed by this same sweep.
  document.querySelectorAll('[data-owner-only]:not([data-visitor-ok])').forEach(el => el.remove());

  // Conversation titles stay renameable in spirit — but an editable H1 on
  // someone else's AI reads as "you can change this thing", so it goes.
  const title = document.getElementById('chat-title');
  if (title) {
    title.removeAttribute('contenteditable');
    title.removeAttribute('title');
  }

  // The markup ships "100% local, no cloud" hardcoded. On a published site
  // that is a false claim — fix the copy that's already on screen; the
  // re-rendered welcome screen gets it from welcomeBriefText() directly.
  const brief = document.getElementById('welcome-brief');
  if (brief) brief.textContent = welcomeBriefText();

  renderPublishedCredit();
}

// The partner-pitch strip under the composer ("To be pitched to target
// partners" + the AWS/Alibaba/Sui badges) is camp-internal material. It is
// already owner-only, so visitor mode removes it — but a deployed fork that
// hasn't published my-ai.json yet isn't in visitor mode, and would still show
// it to the whole internet. Anything hosted, published or not, drops it.
function hideOwnerPitchFooter() {
  if (isLocalHost()) return;
  const tip = document.getElementById('input-tip');
  if (tip) tip.remove();
}

// The camp's whole claim is "free, private, no cloud" — and on a published
// site that is FALSE: replies come from a hosted model through /api. Saying
// so plainly is the difference between the demo proving the lesson and
// quietly contradicting it.
function welcomeBriefText() {
  const cfg = window.PUBLISHED_CONFIG;
  if (!window.IS_VISITOR || !cfg) return 'Built by Filipino developers · 100% local, no cloud';
  const who = (cfg.creator_name || '').trim();
  return who
    ? `Built by ${who} at a DEVCON Barangay AI Code Camp · public demo, hosted model`
    : 'Built at a DEVCON Barangay AI Code Camp · public demo, hosted model';
}

function renderPublishedCredit() {
  const host = document.getElementById('input-area');
  const cfg = window.PUBLISHED_CONFIG;
  if (!host || !cfg || document.getElementById('published-credit')) return;

  const name = (cfg.settings && cfg.settings.ai_name) || AI_NAME;
  const who = (cfg.creator_name || '').trim();
  const el = document.createElement('div');
  el.className = 'published-credit';
  el.id = 'published-credit';
  el.innerHTML = `
    <div class="published-credit-main">${escHtml(name)} — built by ${escHtml(who || 'a student')} at a DEVCON Barangay AI Code Camp</div>
    <div class="published-credit-note">This public demo answers using a hosted model. The real one runs offline on ${escHtml(who || 'their')}${who ? "'s" : ''} own computer — free, private, no cloud. <a href="https://github.com/Spod101/barangayAI" target="_blank" rel="noopener">Build your own →</a></div>`;
  host.appendChild(el);
}

// ── EXPORT (the Publish button) ───────────────────────────────────────
// Everything the student tuned, minus every secret. Disabled sources are
// left out on purpose: the Sources panel checkbox is the student saying
// "my AI shouldn't use this", and publishing should honour that.
function buildPublishConfig() {
  const s = loadSettings() || {};
  const master = (window._TRAINING_FILES_MASTER && window._TRAINING_FILES_MASTER.length)
    ? window._TRAINING_FILES_MASTER
    : (Array.isArray(s.training_files) ? s.training_files : []);
  const sources = master
    .filter(f => !_KB_DISABLED.has(f.name))
    .map(f => ({ name: f.name, size: f.size || 0, content: f.content || '' }));

  return {
    publishedAt: new Date().toISOString().slice(0, 10),
    creator_name: (s.creator_name || '').trim(),
    settings: {
      ai_name:          s.ai_name || AI_NAME,
      ai_tone:          s.ai_tone || '',
      ai_knowledge:     s.ai_knowledge || '',
      brand_color:      s.brand_color || BRAND_COLOR,
      welcome_greeting: s.welcome_greeting || '',
      reply_language:   s.reply_language || 'english',
      training_notes:   s.training_notes || '',
      prompt_prefix:    s.prompt_prefix || '',
      prompt_suffix:    s.prompt_suffix || '',
      temperature:      (typeof s.temperature === 'number') ? s.temperature : 0.3,
      max_tokens:       (s.max_tokens === null || typeof s.max_tokens === 'number') ? s.max_tokens : 1024,
      personas:         Array.isArray(s.personas) ? s.personas : [],
      active_persona:   s.active_persona || '',
      thinking_enabled: s.thinking_enabled === true,
      // Carried so the owner's choice applies to their published site too.
      // Absent from an older published file means false, which is the safe
      // default: visitors don't spend a second call per message by accident.
      followups_enabled: s.followups_enabled === true,
    },
    sources,
    // The live model is decided by the MODEL_NAME env var on Vercel and
    // reported back through /api/models — this is only the label shown
    // before that request lands.
    model: { base: '/api', label: 'cloud model' },
  };
}

function exportPublishConfig() {
  const cfg = buildPublishConfig();
  // The published site credits its builder by name. Shipping one credited to
  // "a student" defeats the point, and the file is the last place to catch it
  // — once it's committed, the byline is what the world sees.
  if (!cfg.creator_name) {
    showToast('Add your name in Settings → Personalize first — it gets credited on your published AI.');
    const input = document.getElementById('settings-creator-name');
    if (input) { input.focus(); input.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return;
  }
  const json = JSON.stringify(cfg, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = PUBLISH_FILE;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  const kb = Math.max(1, Math.round(json.length / 1024));
  showToast(`${PUBLISH_FILE} downloaded · ${cfg.sources.length} source${cfg.sources.length === 1 ? '' : 's'} · ${kb} KB`);
  updatePublishSummary();
}

// Shows what would actually ship, so "Publish" is never a leap of faith.
function updatePublishSummary() {
  const el = document.getElementById('publish-summary');
  if (!el) return;
  const cfg = buildPublishConfig();
  const rows = [
    ['Name', cfg.settings.ai_name],
    ['Language', cfg.settings.reply_language],
    ['Personality', cfg.settings.ai_tone ? 'custom prompt' : 'default'],
    ['Sources', cfg.sources.length ? `${cfg.sources.length} file${cfg.sources.length === 1 ? '' : 's'}` : 'none'],
    ['Your name', cfg.creator_name || '⚠ required — set it in Personalize'],
  ];
  el.innerHTML = rows.map(([k, v]) =>
    `<div class="publish-row"><b>${escHtml(k)}</b><span>${escHtml(String(v))}</span></div>`).join('')
    + `<div class="publish-row"><b>Your API keys</b><span>never included — they stay on Vercel</span></div>`;
}

function previewAsVisitor() {
  if (!window.PUBLISHED_CONFIG) {
    showToast(`Add ${PUBLISH_FILE} to the project folder first`);
    return;
  }
  location.href = location.pathname + '?visitor=1';
}

window.loadPublishedConfig    = loadPublishedConfig;
window.isVisitorMode          = isVisitorMode;
window.isLocalHost            = isLocalHost;
window.hydratePublishedSettings = hydratePublishedSettings;
window.lockVisitorUI          = lockVisitorUI;
window.hideOwnerPitchFooter   = hideOwnerPitchFooter;
window.welcomeBriefText       = welcomeBriefText;
window.exportPublishConfig    = exportPublishConfig;
window.updatePublishSummary   = updatePublishSummary;
window.previewAsVisitor       = previewAsVisitor;

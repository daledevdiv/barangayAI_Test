// ── MODEL SELECTOR ────────────────────────────────────────────────────
// host:port shown in the picker for the default local endpoint
const MODEL_ENDPOINT = (() => {
  try { const u = new URL(API_BASE); return u.host; } catch { return '127.0.0.1:11434'; }
})();
// Data-driven model registry. Each entry carries its own endpoint base + key,
// so models added via the "Add Models" dialog (local or cloud) work too.
// Nothing is seeded — real local models are discovered live from the endpoint
// on startup (see initModelRegistry), and user-added endpoints are restored
// from the DB. A spec-fit default is auto-selected once discovery finishes
// (see initModelRegistry); the user can switch models at any time.
let MODEL_LIST = [];
let _modelSeq = 0;

// First-run guidance only — shown in the picker when NO endpoint has been
// added/discovered yet, so a fresh install isn't just a blank "no models"
// dead end. Purely illustrative: not installed, not selectable as an active
// model, and gone the moment a real endpoint/model shows up in MODEL_LIST.
const DEMO_SUGGESTED_MODELS = [
  { model: 'qwen2.5:3b', badge: 'Recommended', cls: 'rec' },
  { model: 'gemma3:1b' },
  { model: 'llama3.2:1b' },
];

// Enable/disable + deletion state for the endpoint manager (persisted in the DB).
let _DISABLED_MODELS = new Set();    // keys "base||model" that are turned off
let _REMOVED_ENDPOINTS = new Set();  // base URLs the user deleted (skipped on discovery)
const _EXPANDED_ENDPOINTS = new Set(); // bases whose model list is expanded in the UI (view-only)

function modelKey(m) { return `${m.base}||${m.model}`; }

function loadModelPrefs() {
  if (!(window.BarangayDB && window.BarangayDB.dbGetItem)) return;
  _DISABLED_MODELS  = new Set(window.BarangayDB.dbGetItem('disabled_models', []) || []);
  _REMOVED_ENDPOINTS = new Set(window.BarangayDB.dbGetItem('removed_endpoints', []) || []);
}
function persistDisabledModels() {
  if (window.BarangayDB && window.BarangayDB.dbSetItem) window.BarangayDB.dbSetItem('disabled_models', [..._DISABLED_MODELS]);
}
function persistRemovedEndpoints() {
  if (window.BarangayDB && window.BarangayDB.dbSetItem) window.BarangayDB.dbSetItem('removed_endpoints', [..._REMOVED_ENDPOINTS]);
}

const modelIcon = '<svg class="model-dd-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M9 15h6"/></svg>';

// Real vendor marks for the model families we ship logos for — matched against
// the model tag (e.g. "qwen2.5:3b", "llama3.2:1b", "gemma3:1b"). Anything we
// don't recognize falls back to the Ollama logo (DEFAULT_MODEL_LOGO below),
// since every model in the picker is served through an Ollama-compatible
// endpoint one way or another.
const MODEL_LOGOS = [
  { test: /qwen/i,              src: 'assets/logos/Qwen_logo.webp',        alt: 'Qwen' },
  { test: /llama|meta-?llama/i, src: 'assets/logos/Meta_logo.png',         alt: 'Meta' },
  { test: /gemma/i,             src: 'assets/logos/gemma_logo.png',        alt: 'Gemma' },
  { test: /granite/i,           src: 'assets/logos/IBM_granite_logo.webp', alt: 'IBM Granite' },
  { test: /deepseek/i,          src: 'assets/logos/deepseek_logo.png',     alt: 'DeepSeek' },
  { test: /mistral|mixtral/i,   src: 'assets/logos/Mistral_logo.webp',     alt: 'Mistral' },
  { test: /phi/i,                src: 'assets/logos/microsoft_logo.png',    alt: 'Microsoft Phi' },
];
const DEFAULT_MODEL_LOGO = { src: 'assets/logos/ollama_logo.png', alt: 'Ollama' };

// Icon markup for a model row/button: a real vendor logo when we recognize the
// family, otherwise the default Ollama mark — both sized to `size` px.
function modelIconHtml(modelName, size) {
  const hit = MODEL_LOGOS.find(l => l.test.test(modelName || '')) || DEFAULT_MODEL_LOGO;
  return `<img class="model-dd-icon" width="${size}" height="${size}" src="${hit.src}" alt="${hit.alt}">`;
}

// ── PER-ENDPOINT LIVE STATUS ──────────────────────────────────────────
// Each model dot reflects the reachability of ITS endpoint, not a single
// global flag: green = online, red = offline, orange = checking / loading.
const ENDPOINT_STATUS = new Map();   // base -> 'online' | 'offline' | 'checking'

// Dot state for a model row:
//   green  = endpoint online AND this is the model in use (active)
//   orange = endpoint reachable but idle (not selected) OR still checking
//   red    = endpoint offline
function modelDotClass(m) {
  const s = ENDPOINT_STATUS.get(m.base);
  if (s === 'offline') return 'offline';
  const inUse = window.ACTIVE_MODEL === m.model && (window.ACTIVE_BASE || API_BASE) === m.base;
  if (s === 'online') return inUse ? 'online' : 'idle';
  return 'checking';
}
function modelDotLabel(m) {
  const s = ENDPOINT_STATUS.get(m.base);
  if (s === 'offline') return 'Offline';
  const inUse = window.ACTIVE_MODEL === m.model && (window.ACTIVE_BASE || API_BASE) === m.base;
  if (s === 'online') return inUse ? 'Online · in use' : 'Idle · not in use';
  return 'Checking…';
}

// ── MODEL PICKER BADGES + SPEC-BASED DEFAULT ─────────────────────────
// Parse the parameter count (in billions) out of a model tag, e.g.
// "qwen2.5:3b" → 3, "llama3.1:8b-instruct-q4" → 8. null when unknown.
function modelParamsB(tag) {
  const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(tag || '');
  return m ? parseFloat(m[1]) : null;
}

// Does this model understand /think and /no_think? They are chat-template
// tokens of Qwen's hybrid-reasoning line — Qwen3 onwards, plus QwQ — and not a
// general Ollama feature. Gemma, Llama, Mistral, Phi and Qwen 2.5 all run on
// Ollama and none of them parse the tokens: they arrive as literal text glued
// to the end of the user's question. Being wrong in the permissive direction
// corrupts every prompt, so an unrecognised tag answers false.
//   "qwen3:4b" → true | "qwq:32b" → true | "qwen2.5:3b" → false | "gemma3:1b" → false
function supportsThinkingTokens(tag) {
  const t = (tag || '').toLowerCase();
  if (t.includes('qwq')) return true;
  const m = /qwen-?(\d+)/.exec(t);
  return !!m && parseInt(m[1], 10) >= 3;
}

// Rough memory need for a Q4 model: ~0.75 GB per B of params + 1 GB overhead
// (same heuristic family as the onboarding recommender's needGB column).
function modelNeedGB(tag) {
  const p = modelParamsB(tag);
  return p == null ? null : p * 0.75 + 1;
}

// The largest model that fits this machine's memory budget.
// navigator.deviceMemory is capped at 8 by Chrome, which is fine — it keeps
// the default conservative. Falls back to the smallest model when nothing fits.
function pickDefaultModelForSpecs(rows) {
  const pool = (rows || MODEL_LIST).filter(m => m.enabled !== false);
  if (!pool.length) return null;
  const sized = pool.filter(m => modelParamsB(m.model) != null)
    .sort((a, b) => modelParamsB(a.model) - modelParamsB(b.model));
  if (!sized.length) return pool[0];
  const budget = (navigator.deviceMemory || 8) * 0.6;
  const fits = sized.filter(m => modelNeedGB(m.model) <= budget);
  return fits.length ? fits[fits.length - 1] : sized[0];
}

// Badges for the model picker: Recommended (best spec fit), Fastest
// (smallest), Smartest (biggest). One badge per model — Recommended wins.
function computeModelBadges(rows) {
  const badges = new Map();   // id -> {label, cls}
  const sized = rows.filter(m => modelParamsB(m.model) != null);
  if (!sized.length) return badges;
  const bySize = [...sized].sort((a, b) => modelParamsB(a.model) - modelParamsB(b.model));
  const fastest = bySize[0];
  const smartest = bySize[bySize.length - 1];
  const recommended = pickDefaultModelForSpecs(sized) || fastest;
  badges.set(recommended.id, { label: 'Recommended', cls: 'rec' });
  if (!badges.has(fastest.id)) badges.set(fastest.id, { label: 'Fastest', cls: 'fast' });
  if (smartest.id !== fastest.id && !badges.has(smartest.id)) {
    badges.set(smartest.id, { label: 'Smartest', cls: 'smart' });
  }
  return badges;
}

// ── IS THIS ENDPOINT OLLAMA? ──────────────────────────────────────────
// Ollama accepts request fields no other provider does (see applyThinkingSwitch
// in app/thinking.js), so something has to decide where those may be sent. The
// `kind` field can't: it records which box the user typed the URL into, and
// someone adding an Ollama that runs on another machine reasonably picks "API".
// So ask the endpoint instead — Ollama serves its native API alongside the
// OpenAI-compatible one, with /v1/models and /api/version on the same root.
//   true    = answered Ollama's /api/version
//   false   = answered, but isn't Ollama
//   absent  = not asked yet, or asked and got nothing back → callers fall back
//             to `kind`, which is how this behaved before the probe existed
const OLLAMA_ENDPOINTS = new Map();   // base -> boolean

async function probeOllama(base) {
  if (!base) return;
  const root = base.replace(/\/v1$/, '');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${root}/api/version`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) { OLLAMA_ENDPOINTS.set(base, false); return; }   // e.g. Groq answers 401 here
    const data = await res.json();
    OLLAMA_ENDPOINTS.set(base, typeof data?.version === 'string');
  } catch (e) {
    // Unreachable, blocked, or not JSON. Leave it unrecorded rather than
    // storing a "not Ollama" we aren't sure of — a local Ollama that simply
    // wasn't running yet must not lose its thinking controls for the session.
    // refreshEndpointStatuses retries any base that isn't recorded.
    OLLAMA_ENDPOINTS.delete(base);
  }
}

// Answers the question above for one endpoint, falling back to how it was added
// while the probe is unknown. Read live rather than cached on window, so a probe
// that resolves after a model was selected still counts.
function isOllamaEndpoint(base, kind) {
  const probed = OLLAMA_ENDPOINTS.get(base);
  return (probed === undefined) ? (kind || 'local') === 'local' : probed;
}

// Probe one endpoint's /models and record whether it's reachable.
async function probeEndpoint(base, key) {
  if (!base) return;
  if (!ENDPOINT_STATUS.has(base)) ENDPOINT_STATUS.set(base, 'checking');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${base}/models`, {
      headers: key ? { 'Authorization': `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    ENDPOINT_STATUS.set(base, res.ok ? 'online' : 'offline');
  } catch {
    ENDPOINT_STATUS.set(base, 'offline');
  }
  // Repaint the dots if the picker is currently open.
  const dd = document.getElementById('model-dropdown');
  if (dd && dd.classList.contains('open')) {
    renderModelList(document.getElementById('model-dd-search')?.value || '');
  }
}

// Probe every unique endpoint referenced by the model list.
function refreshEndpointStatuses() {
  const seen = new Map();   // base -> a representative key
  for (const m of MODEL_LIST) {
    if (m.base && !seen.has(m.base)) seen.set(m.base, m.key);
  }
  seen.forEach((key, base) => {
    probeEndpoint(base, key);
    // Once per base, not once per tick — and retried on the next tick for any
    // endpoint that was unreachable when we last asked.
    if (!OLLAMA_ENDPOINTS.has(base)) probeOllama(base);
  });
}

function renderModelList(filter) {
  const list = document.getElementById('model-dd-list');
  if (!list) return;
  const q = (filter || '').trim().toLowerCase();
  const rows = MODEL_LIST.filter(m =>
    m.enabled !== false && (!q || m.model.toLowerCase().includes(q) || m.endpoint.toLowerCase().includes(q))
  );
  if (!rows.length) {
    const hasAny = MODEL_LIST.length > 0;
    if (!hasAny) {
      const demo = DEMO_SUGGESTED_MODELS.filter(m => !q || m.model.toLowerCase().includes(q));
      if (demo.length) {
        list.innerHTML = `
          <div class="model-dd-demo-note">No models detected yet — commonly recommended for this camp:</div>
          ${demo.map(m => `
            <button class="model-dropdown-opt demo" onclick="showToast('Not installed yet — run: ollama pull ${escHtml(m.model)}')">
              ${modelIconHtml(m.model, 16)}
              <span class="model-dd-meta">
                <span class="model-dd-name">${escHtml(m.model)}</span>
                <span class="model-dd-endpoint">ollama pull ${escHtml(m.model)}</span>
              </span>
              ${m.badge ? `<span class="model-dd-badge ${m.cls}">${m.badge}</span>` : ''}
            </button>`).join('')}
        `;
        return;
      }
    }
    list.innerHTML = `<div class="model-dd-empty">${hasAny ? 'No models enabled — turn some on in “Add Models”' : 'No models found'}</div>`;
    return;
  }
  // Badges are computed over ALL enabled models (not the filtered rows) so
  // "Recommended" doesn't jump around while the user types in the search box.
  const badges = computeModelBadges(MODEL_LIST.filter(m => m.enabled !== false));
  list.innerHTML = rows.map(m => {
    const b = badges.get(m.id);
    return `
    <button class="model-dropdown-opt${window.ACTIVE_MODEL === m.model ? ' active' : ''}" onclick="selectModelFromDropdown('${m.id}')">
      ${modelIconHtml(m.model, 16)}
      <span class="model-dd-meta">
        <span class="model-dd-name">${escHtml(m.model)}</span>
        <span class="model-dd-endpoint">${escHtml(m.endpoint)}</span>
      </span>
      ${b ? `<span class="model-dd-badge ${b.cls}">${b.label}</span>` : ''}
      <span class="model-dd-dot ${modelDotClass(m)}" title="${modelDotLabel(m)}"></span>
    </button>`;
  }).join('');
}

function filterModels(value) {
  renderModelList(value);
}

function selectModel(id, opts = {}) {
  const m = MODEL_LIST.find(x => x.id === id);
  if (!m) return;
  window.ACTIVE_MODEL = m.model;
  window.ACTIVE_BASE  = m.base || API_BASE;
  window.ACTIVE_KEY   = m.key  || API_KEY;
  window.ACTIVE_KIND  = m.kind || 'local';

  // Update composer trigger label + icon (real vendor logo when recognized)
  const labelEl = document.getElementById('model-select-label');
  if (labelEl) labelEl.textContent = m.model;
  const iconEl = document.getElementById('model-select-icon');
  if (iconEl) iconEl.innerHTML = modelIconHtml(m.model, 13);
  const labelElMobile = document.getElementById('model-select-label-mobile');
  if (labelElMobile) labelElMobile.textContent = m.model;
  const iconElMobile = document.getElementById('model-select-icon-mobile');
  if (iconElMobile) iconElMobile.innerHTML = modelIconHtml(m.model, 15);

  // Re-render picker rows to reflect active state
  renderModelList(document.getElementById('model-dd-search')?.value || '');

  // The new model's status is unknown until it's probed. Without this the chip
  // kept showing the *previous* model's verdict — usually "Offline" — until the
  // 15s poll came around, so a perfectly good model looked broken for up to a
  // quarter of a minute. Probe now, and say "Checking…" while we wait.
  checkConnectivity({ announce: true });

  if (!opts.silent) showToast(`Switched to ${m.model}`);
}

// Clear the active model (e.g. after it was disabled or its endpoint deleted).
function deselectModel() {
  window.ACTIVE_MODEL = null;
  window.ACTIVE_KIND  = 'local';   // back to the default local endpoint's rules
  const labelEl = document.getElementById('model-select-label');
  if (labelEl) labelEl.textContent = 'Select model';
  const iconEl = document.getElementById('model-select-icon');
  if (iconEl) iconEl.innerHTML = modelIcon.replace(/width="16" height="16"/, 'width="13" height="13"');
  const labelElMobile = document.getElementById('model-select-label-mobile');
  if (labelElMobile) labelElMobile.textContent = 'Select model';
  const iconElMobile = document.getElementById('model-select-icon-mobile');
  if (iconElMobile) iconElMobile.innerHTML = modelIcon.replace(/width="16" height="16"/, 'width="15" height="15"');
}

// ── ENDPOINT MANAGER (Added Models) ───────────────────────────────────
const _epIconLocal = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const _epIconApi = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
const _epChevron = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 12,15 18,9"/></svg>';
const _epCopyIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function renderAddedEndpoints() {
  const host = document.getElementById('added-endpoints-list');
  if (!host) return;
  if (!MODEL_LIST.length) {
    host.innerHTML = '<div class="added-endpoints-empty">No endpoints yet — add a local or cloud endpoint above.</div>';
    return;
  }
  // Group models by endpoint base, preserving insertion order.
  const groups = [];
  const byBase = new Map();
  for (const m of MODEL_LIST) {
    if (!byBase.has(m.base)) {
      const g = { base: m.base, endpoint: m.endpoint, kind: m.kind, models: [] };
      byBase.set(m.base, g);
      groups.push(g);
    }
    byBase.get(m.base).models.push(m);
  }
  window._ENDPOINT_GROUPS = groups;

  host.innerHTML = groups.map((g, gi) => {
    const total   = g.models.length;
    const enabled = g.models.filter(m => m.enabled !== false).length;
    const anyOn   = enabled > 0;
    const expanded = _EXPANDED_ENDPOINTS.has(g.base);
    const kindLabel = g.kind === 'local' ? 'LOCAL' : 'API';
    const kindIcon  = g.kind === 'local' ? _epIconLocal : _epIconApi;
    const modelsHtml = expanded ? `
          <div class="ep-models">
            ${g.models.map((m, mi) => `
            <div class="ep-model-row">
              <span class="ep-model-name${m.enabled === false ? ' disabled' : ''}">${escHtml(m.model)}</span>
              <button class="ep-toggle${m.enabled !== false ? ' on' : ''}" title="${m.enabled !== false ? 'Disable' : 'Enable'} this model" onclick="toggleModelEnabled(${gi}, ${mi})"></button>
            </div>`).join('')}
          </div>` : '';
    return `
      <div class="ep-group">
        <div class="ep-group-label">${kindIcon}<span>${kindLabel}</span></div>
        <div class="ep-card">
          <div class="ep-card-main">
            <span class="ep-card-name">${escHtml(g.endpoint)}</span>
            <span class="ep-badge${anyOn ? '' : ' off'}">${enabled}/${total} models enabled</span>
            <span class="ep-manage-hint" onclick="toggleEndpointExpand(${gi})">${expanded ? 'Hide models' : 'Click to manage models'}</span>
            <div class="ep-card-actions">
              <button class="ep-mini-btn" onclick="toggleEndpointEnabled(${gi})">${anyOn ? 'Disable' : 'Enable'}</button>
              <button class="ep-mini-btn danger" onclick="deleteEndpoint(${gi})">Delete</button>
              <button class="ep-chevron${expanded ? ' open' : ''}" onclick="toggleEndpointExpand(${gi})" aria-label="Expand models">${_epChevron}</button>
            </div>
          </div>
          <div class="ep-url-row">
            <span>${escHtml(g.base)}</span>
            <button class="ep-url-copy" title="Copy endpoint URL" onclick="copyEndpointUrl(${gi})">${_epCopyIcon}</button>
          </div>
          ${modelsHtml}
        </div>
      </div>`;
  }).join('');
}

function _epGroup(gi) { return (window._ENDPOINT_GROUPS || [])[gi] || null; }

function setModelEnabled(m, on) {
  m.enabled = on;
  const k = modelKey(m);
  if (on) _DISABLED_MODELS.delete(k); else _DISABLED_MODELS.add(k);
}

// Re-sync picker + header after enabling/disabling/removing models.
function afterModelAvailabilityChange() {
  if (window.ACTIVE_MODEL) {
    const stillUsable = MODEL_LIST.find(m => m.model === window.ACTIVE_MODEL && m.enabled !== false);
    if (!stillUsable) deselectModel();
  }
  renderModelList(document.getElementById('model-dd-search')?.value || '');
  renderAddedEndpoints();
}

function toggleEndpointExpand(gi) {
  const g = _epGroup(gi);
  if (!g) return;
  if (_EXPANDED_ENDPOINTS.has(g.base)) _EXPANDED_ENDPOINTS.delete(g.base);
  else _EXPANDED_ENDPOINTS.add(g.base);
  renderAddedEndpoints();
}

function toggleEndpointEnabled(gi) {
  const g = _epGroup(gi);
  if (!g) return;
  const anyOn = g.models.some(m => m.enabled !== false);
  g.models.forEach(m => setModelEnabled(m, !anyOn));   // all off → enable all; otherwise disable all
  persistDisabledModels();
  afterModelAvailabilityChange();
}

function toggleModelEnabled(gi, mi) {
  const g = _epGroup(gi);
  if (!g) return;
  const m = g.models[mi];
  if (!m) return;
  setModelEnabled(m, m.enabled === false);   // flip
  persistDisabledModels();
  afterModelAvailabilityChange();
}

function deleteEndpoint(gi) {
  const g = _epGroup(gi);
  if (!g) return;
  if (!confirm(`Delete endpoint "${g.endpoint}"? Its ${g.models.length} model(s) will be removed from the picker.`)) return;
  g.models.forEach(m => _DISABLED_MODELS.delete(modelKey(m)));
  MODEL_LIST = MODEL_LIST.filter(m => m.base !== g.base);
  _EXPANDED_ENDPOINTS.delete(g.base);
  OLLAMA_ENDPOINTS.delete(g.base);           // re-ask if it's ever added back
  _REMOVED_ENDPOINTS.add(g.base);            // skip on next discovery until re-added
  persistRemovedEndpoints();
  persistDisabledModels();
  saveModels();                               // rewrite persisted user endpoints without these
  afterModelAvailabilityChange();
  showToast('Endpoint removed');
}

function copyEndpointUrl(gi) {
  const g = _epGroup(gi);
  if (!g) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(g.base).then(() => showToast('Endpoint URL copied')).catch(() => showToast('Copy failed'));
  } else {
    showToast(g.base);
  }
}

function toggleModelDropdown() {
  const dd = document.getElementById('model-dropdown');
  const btn = document.getElementById('model-select-btn');
  if (!dd) return;
  const isOpen = dd.classList.contains('open');
  dd.classList.toggle('open');
  if (btn) btn.classList.toggle('open', !isOpen);
  if (!isOpen) {
    renderModelList('');
    refreshEndpointStatuses();   // re-probe so the dots reflect live status
    const search = document.getElementById('model-dd-search');
    if (search) { search.value = ''; setTimeout(() => search.focus(), 0); }
  }
}

function selectModelFromDropdown(id) {
  selectModel(id);
  const dd = document.getElementById('model-dropdown');
  const btn = document.getElementById('model-select-btn');
  if (dd) dd.classList.remove('open');
  if (btn) btn.classList.remove('open');
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  const dd = document.getElementById('model-dropdown');
  const btn = document.getElementById('model-select-btn');
  const mobileBtn = document.getElementById('model-select-mobile-btn');
  if (!dd || !btn) return;
  const clickedTrigger = btn.contains(e.target) || (mobileBtn && mobileBtn.contains(e.target));
  if (!dd.contains(e.target) && !clickedTrigger) {
    dd.classList.remove('open');
    btn.classList.remove('open');
  }
});

// ── TOOLS MENU (Gemini "+" style) — sources / deep thinking / web search ──
function toggleToolsDropdown() {
  const dd = document.getElementById('tools-dropdown');
  const btn = document.getElementById('tools-btn');
  if (!dd) return;
  const isOpen = dd.classList.contains('open');
  dd.classList.toggle('open', !isOpen);
  if (btn) { btn.classList.toggle('open', !isOpen); btn.setAttribute('aria-expanded', String(!isOpen)); }
}

function closeToolsDropdown() {
  const dd = document.getElementById('tools-dropdown');
  const btn = document.getElementById('tools-btn');
  if (dd) dd.classList.remove('open');
  if (btn) { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
}

document.addEventListener('click', function(e) {
  const dd = document.getElementById('tools-dropdown');
  const btn = document.getElementById('tools-btn');
  if (dd && btn && !dd.contains(e.target) && !btn.contains(e.target)) {
    dd.classList.remove('open');
    btn.classList.remove('open');
  }
});

// ── ADD MODELS DIALOG (endpoints — local or cloud) ────────────────────
function openAddModels() {
  // Close the model picker if it's open
  const dd = document.getElementById('model-dropdown');
  const sbtn = document.getElementById('model-select-btn');
  if (dd) dd.classList.remove('open');
  if (sbtn) sbtn.classList.remove('open');
  document.getElementById('add-models-modal').style.display = 'flex';
  renderAddedEndpoints();
}
function closeAddModels() {
  document.getElementById('add-models-modal').style.display = 'none';
}
function handleAddModelsBackdrop(e) {
  if (e.target === document.getElementById('add-models-modal')) closeAddModels();
}
function toggleQuickstart() {
  const body = document.getElementById('quickstart-body');
  const row  = document.getElementById('quickstart-row');
  if (!body) return;
  const open = body.hasAttribute('hidden') ? false : true;
  if (open) { body.setAttribute('hidden', ''); row.classList.remove('open'); }
  else      { body.removeAttribute('hidden');  row.classList.add('open'); }
}

const PROVIDER_ENDPOINTS = {
  DeepSeek: 'https://api.deepseek.com/v1',
  OpenAI:   'https://api.openai.com/v1',
  Together: 'https://api.together.xyz/v1',
  Groq:     'https://api.groq.com/openai/v1',
  Custom:   '',
};
function onProviderChange(provider) {
  const input = document.getElementById('api-endpoint');
  if (input && provider in PROVIDER_ENDPOINTS) input.value = PROVIDER_ENDPOINTS[provider];
}

// Normalise a base URL (ensure it ends without trailing slash, has /v1 for cloud is user's job)
function normaliseBase(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

async function testEndpoint(kind) {
  const base = normaliseBase(document.getElementById(kind + '-endpoint').value);
  const key  = (document.getElementById(kind + '-key')?.value || '').trim() || (kind === 'local' ? API_KEY : '');
  if (!base) { showToast('Enter an endpoint URL first'); return; }
  const btn = document.getElementById(kind + '-test-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${base}/models`, {
      headers: key ? { 'Authorization': `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) showToast('✓ Endpoint reachable');
    else showToast(`Endpoint responded ${res.status}`);
  } catch {
    showToast('Could not reach endpoint');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Test'; }
  }
}

// Query an OpenAI-compatible /models endpoint and return the list of model ids.
async function discoverModels(base, key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${base}/models`, {
      headers: key ? { 'Authorization': `Bearer ${key}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
  } catch {
    return [];
  }
}

// Persist user-added endpoints so they survive reloads.
function saveModels() {
  if (!(window.BarangayDB && window.BarangayDB.dbSaveModels)) return;
  const userModels = MODEL_LIST
    .filter(m => m.source === 'user')
    .map(({ model, endpoint, base, key, kind }) => ({ model, endpoint, base, key, kind, source: 'user' }));
  window.BarangayDB.dbSaveModels(userModels);
}

function addModelEntry({ model, base, key, kind, source = 'user', endpoint: label }) {
  // A published entry's base is the relative '/api', which has no host to pull
  // a name out of — the caller passes a label instead, so the picker reads as
  // a place the model comes from rather than as a path.
  const endpoint = label || (() => { try { return new URL(base).host; } catch { return base; } })();
  // Avoid duplicates (same model + endpoint)
  const existing = MODEL_LIST.find(m => m.model === model && m.base === base);
  if (existing) return existing;
  const id = 'm' + (++_modelSeq);
  const entry = { id, model, endpoint, base, key, kind, source, enabled: !_DISABLED_MODELS.has(`${base}||${model}`) };
  MODEL_LIST.push(entry);
  renderModelList(document.getElementById('model-dd-search')?.value || '');
  renderAddedEndpoints();
  if (source === 'user') saveModels();
  return entry;
}

// On startup: restore persisted user endpoints, then discover live local models.
async function initModelRegistry() {
  loadModelPrefs();   // disabled models + removed endpoints

  // Published site: every model runs through the same-origin /api proxy, so
  // the key never reaches the browser. No local discovery (127.0.0.1 is the
  // VISITOR's machine, which has no Ollama) and no saved endpoints — but the
  // picker itself stays, because the proxy answers /models with the real list
  // the owner's key can reach. Asking beats trusting a name baked into
  // my-ai.json: the day a provider retires a model, discovery routes around
  // it instead of the whole site going quiet.
  if (window.IS_VISITOR) {
    // /api is the owner's proxy in front of a cloud provider, never Ollama.
    // Recorded outright so no page load spends a request asking.
    OLLAMA_ENDPOINTS.set('/api', false);
    const ids = await discoverModels('/api', '');
    // The proxy puts the owner's preferred model first, so the head of the
    // list is the default and the tail is what else that key can reach. An
    // empty list means /models itself failed — carry on with one placeholder
    // name so the composer has something to show while chat reports why.
    const names = ids.length
      ? ids
      : [(window.PUBLISHED_CONFIG?.model?.label) || 'cloud model'];
    const entries = names.map(name => addModelEntry({
      model: name, base: '/api', key: '', kind: 'api',
      source: 'published', endpoint: 'hosted',
    }));
    // selectModel() re-probes on its own now, which is what rescues the visitor
    // view: the module-level check ran against the default local endpoint and
    // failed (127.0.0.1 is the visitor's own machine), so without a re-probe
    // against /api a working site sits on "Offline" until the 15s tick.
    selectModel(entries[0].id, { silent: true });
    refreshEndpointStatuses();
    return;
  }

  if (window.BarangayDB && window.BarangayDB.dbLoadModels) {
    for (const m of window.BarangayDB.dbLoadModels()) {
      if (_REMOVED_ENDPOINTS.has(m.base)) continue;
      addModelEntry({ model: m.model, base: m.base, key: m.key, kind: m.kind, source: 'user' });
    }
  }
  // Discover models actually available on the default local endpoint (unless the user deleted it).
  if (!_REMOVED_ENDPOINTS.has(API_BASE)) {
    const ids = await discoverModels(API_BASE, API_KEY);
    for (const id of ids) {
      addModelEntry({ model: id, base: API_BASE, key: API_KEY, kind: 'local', source: 'discovered' });
    }
  }
  renderModelList(document.getElementById('model-dd-search')?.value || '');
  renderAddedEndpoints();
  refreshEndpointStatuses();   // seed the live status dots

  // Default model — auto-select the best fit for this machine's specs so
  // chat works out of the box. The user can still switch any time.
  if (!window.ACTIVE_MODEL) {
    const pick = pickDefaultModelForSpecs();
    if (pick) {
      selectModel(pick.id, { silent: true });
      showToast(`Auto-selected ${pick.model} for your PC — change it any time below`);
    } else {
      const labelEl = document.getElementById('model-select-label');
      if (labelEl) labelEl.textContent = 'Select model';
      const labelElMobile = document.getElementById('model-select-label-mobile');
      if (labelElMobile) labelElMobile.textContent = 'Select model';
    }
  }
}

async function addEndpoint(kind) {
  const base = normaliseBase(document.getElementById(kind + '-endpoint').value);
  const key  = (document.getElementById(kind + '-key')?.value || '').trim() || (kind === 'local' ? API_KEY : '');
  if (!base) { showToast('Enter an endpoint URL first'); return; }

  // Re-adding an endpoint the user previously deleted clears its removed flag.
  if (_REMOVED_ENDPOINTS.delete(base)) persistRemovedEndpoints();

  const btn = document.getElementById(kind + '-add-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

  let added = 0;
  let first = null;

  // Try to discover models from the endpoint. Ask what it is at the same time,
  // so the answer is in before the user can send to the model we select below.
  const [ids] = await Promise.all([discoverModels(base, key), probeOllama(base)]);
  ids.forEach(id => { const e = addModelEntry({ model: id, base, key, kind, source: 'user' }); if (!first) first = e; added++; });

  // Cloud providers usually don't expose /models without scopes — fall back to provider default
  if (!added) {
    const fallback = kind === 'api'
      ? (document.getElementById('api-provider')?.value === 'OpenAI' ? 'gpt-4o-mini' : 'deepseek-chat')
      : 'custom-model';
    first = addModelEntry({ model: fallback, base, key, kind, source: 'user' });
    added = 1;
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
  showToast(added > 1 ? `Added ${added} models` : `Added ${first.model}`);
  if (first) selectModel(first.id);
  closeAddModels();
}

// ── CONNECTIVITY CHECK ────────────────────────────────────────────────
// Every check gets a ticket. Switching models fires a fresh check while the
// previous model's probe may still be in flight, and that older probe must not
// be allowed to stamp its verdict on the new model when it finally lands.
let _connCheckId = 0;

async function checkConnectivity(opts = {}) {
  const id   = ++_connCheckId;
  const base = window.ACTIVE_BASE || API_BASE;
  const key  = window.ACTIVE_KEY  || API_KEY;

  // Announce only where a person is waiting on the answer (first load, model
  // switch). The 15s background poll stays silent — flashing "Checking…" four
  // times a minute would be noise, not information.
  if (opts.announce) renderConnState('checking');

  const settle = (ok) => { if (id === _connCheckId) setConnected(ok); };

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${key}` },
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    // A response is not the same as a working endpoint: a 404 (or the 503
    // a published site returns before its key is set) used to read as
    // "connected", so the header claimed the model was online while every
    // message failed. Fall through to the chat probe instead.
    if (res.ok) { settle(true); return; }
  } catch {}

  // Only probe chat completions if a model is actually selected (otherwise the
  // GET /models check above is what tells us whether the endpoint is reachable).
  if (window.ACTIVE_MODEL) {
    try {
      const ctrl2 = new AbortController();
      const timeout2 = setTimeout(() => ctrl2.abort(), 8000);
      const res2 = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: window.ACTIVE_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
        signal: ctrl2.signal
      });
      clearTimeout(timeout2);
      if (res2.ok) { settle(true); return; }
    } catch {}
  }

  settle(false);
}

function setConnected(ok) {
  isConnected = ok;
  // A verdict — including the ones thinking.js reports from a real stream —
  // retires any probe still in flight. An actual reply is better evidence than
  // a probe, and shouldn't be undone a second later by a slow one.
  _connCheckId++;
  renderConnState(ok ? 'online' : 'offline');
}

// Three states, not two: 'checking' | 'online' | 'offline'. "Not yet verified"
// and "verified dead" look nothing alike to a student staring at the header.
function renderConnState(state) {
  const label    = window.ACTIVE_MODEL || 'Ollama';
  const checking = state === 'checking';
  const ok       = state === 'online';

  // Published so the thinking panel can tell a verified-live model from one we
  // haven't reached yet — a "Process" trace next to an Offline chip reads as if
  // work is happening when nothing is.
  window._CONN_STATE = state;

  const chip = document.getElementById('header-status-chip');
  const text = document.getElementById('header-status-text');
  if (chip) {
    chip.classList.toggle('checking', checking);
    chip.classList.toggle('disconnected', state === 'offline');
  }
  if (text) text.textContent = checking ? `Checking ${label}…` : (ok ? label : 'Offline');

  const card = document.getElementById('sidebar-wifi');
  const status = document.getElementById('sidebar-wifi-status');
  const statusText = document.getElementById('sidebar-wifi-text');
  if (card)   card.className   = 'sidebar-wifi ' + (checking ? 'checking' : ok ? 'connected' : 'disconnected');
  if (status) status.className = 'sidebar-wifi-status ' + (checking ? 'checking' : ok ? 'ok' : 'err');
  if (statusText) statusText.textContent = checking
    ? `Checking ${label}…`
    : ok ? 'Connected · Model online' : `${label} not detected`;

  const railDot = document.getElementById('rail-dot');
  if (railDot) railDot.className = 'rail-dot ' + (checking ? 'checking' : ok ? 'ok' : 'err');

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = false;
  const input = document.getElementById('message-input');
  if (input) input.placeholder = checking
    ? `Checking ${label}…`
    : ok ? 'What\'s on your mind?' : `${label} not detected — is it running?`;
}

checkConnectivity({ announce: true });
setInterval(() => { checkConnectivity(); refreshEndpointStatuses(); }, 15000);


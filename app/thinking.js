// ── THINKING TOGGLE ───────────────────────────────────────────────────
function syncThinkingUI() {
  const on = !!window._THINKING_ENABLED;
  const btn = document.getElementById('thinking-btn');
  if (!btn) return;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Deep thinking is ON — click to disable' : 'Deep thinking is OFF — click to enable';
}

function toggleThinkingQuick() {
  const next = !window._THINKING_ENABLED;
  window._THINKING_ENABLED = next;
  const s = loadSettings();
  s.thinking_enabled = next;
  saveSettings(s);
  syncThinkingUI();
  showToast(
    next ? 'Deep thinking enabled' : 'Thinking off — faster replies',
    next ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5 5 0 0 0-5 5c0 1.5.5 2.5 1 3.5.5 1 1 2 1 3.5h6c0-1.5.5-2.5 1-3.5.5-1 1-2 1-3.5a5 5 0 0 0-5-5z"/><path d="M9 21h6"/><path d="M10 18h4"/></svg>' : null
  );
}

// Applies thinking on/off to the request payload for Qwen3-family models.
// The two signals are gated separately, because they are specific to different
// things — the endpoint and the model:
//   - chat_template_kwargs is not an OpenAI field. Ollama ignores unknown fields,
//     but cloud providers validate the body strictly and answer 400 Bad Request,
//     which killed every message sent to an added API endpoint. So it goes only
//     to endpoints that identified themselves as Ollama (isOllamaEndpoint).
//   - /think and /no_think are Qwen chat-template tokens, and "runs on Ollama"
//     does not imply "is a Qwen3". Gemma, Llama, Mistral, Phi and Qwen 2.5 pass
//     the endpoint check and would receive the token as stray text appended to
//     the user's question, so this half is gated on the model tag as well
//     (supportsThinkingTokens, also in app/models.js).
function applyThinkingSwitch(payload) {
  if (!isOllamaEndpoint(window.ACTIVE_BASE, window.ACTIVE_KIND)) return;
  const on = !!window._THINKING_ENABLED;
  payload.chat_template_kwargs = { enable_thinking: on };
  if (!supportsThinkingTokens(window.ACTIVE_MODEL)) return;
  const msgs = payload.messages;
  if (msgs && msgs.length) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') {
      last.content += on ? '\n\n/think' : '\n\n/no_think';
    }
  }
}

// Query Tavily and return its JSON ({ answer, results } on success, { error } on failure).
async function performWebSearch(query) {
  const key = (window._TAVILY_KEY || '').trim();
  if (!key) return { error: 'no-key' };
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        // Only the top 3 are fed to the model (see buildWebSearchBlock) — the
        // rest are fetched so the trace can honestly say how much was found and
        // offer the remainder as links the student can follow themselves.
        max_results: 10,
        search_depth: 'basic',
        include_answer: true
      })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    console.error('[web search] failed:', e);
    return { error: e.message || 'request-failed' };
  }
}

// Turn a Tavily response into a grounding block injected just before the user's
// question. Wording is deliberately forceful so even small models trust the
// results over their (possibly stale) memory. Returns '' if nothing usable.
function buildWebSearchBlock(sr) {
  if (!sr || !Array.isArray(sr.results) || !sr.results.length) return '';
  const results = sr.results.slice(0, 3);
  let block = 'IMPORTANT: Answer using ONLY the web search results below. They were fetched just now and are current and authoritative. '
    + 'They OVERRIDE your own prior knowledge — if a result contradicts what you remember, the result is correct and your memory is outdated. '
    + 'Do NOT answer from memory. Cite sources inline like [1]. If the results do not contain the answer, say so plainly instead of guessing.\n\n'
    + '=== WEB SEARCH RESULTS ===\n';
  if (sr.answer) block += `Summary: ${sr.answer}\n\n`;
  results.forEach((r, i) => {
    block += `[${i + 1}] ${r.title || 'Untitled'} (${r.url || ''})\n${(r.content || '').trim()}\n\n`;
  });
  block += '=== END WEB SEARCH RESULTS ===';
  return block;
}

// ── FOLLOW-UP SUGGESTIONS ─────────────────────────────────────────────
// A second, deliberately tiny call to the same model, fired only after the
// answer is already on screen so it never delays the reply. Anything the model
// returns that doesn't parse cleanly just means no suggestions — a failure here
// must never surface as an error to the student.
const FOLLOWUP_SYSTEM = "You suggest what the user might ask next. Reply with exactly two short follow-up questions, one per line. No numbering, no bullets, no quotes, no preamble, no explanation. Each question must be under 12 words, written in the user's voice, and answerable from the same topic as the exchange below. Write them in the same language the assistant answered in.";

async function generateFollowUps(question, answer) {
  if (!window._FOLLOWUPS_ENABLED) return [];
  if (!window.ACTIVE_BASE || !window.ACTIVE_MODEL) return [];
  try {
    const payload = {
      model: window.ACTIVE_MODEL,
      messages: [
        { role: 'system', content: FOLLOWUP_SYSTEM },
        { role: 'user', content: `Question: ${question}\n\nAnswer: ${answer.slice(0, 1200)}` }
      ],
      temperature: 0.6,
      max_tokens: 96,
      stream: false
    };
    // A reasoning model would burn the whole 96-token budget thinking and
    // return nothing usable, so thinking is explicitly off for this call.
    if (isOllamaEndpoint(window.ACTIVE_BASE, window.ACTIVE_KIND)) {
      payload.chat_template_kwargs = { enable_thinking: false };
      payload.messages[1].content += '\n\n/no_think';
    }
    const resp = await fetch(`${window.ACTIVE_BASE}/chat/completions`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${window.ACTIVE_KEY}` },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const raw = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    return raw
      .split('\n')
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'“”]+|["'“”]+$/g, '').trim())
      .filter(line => line.length > 6 && line.length <= 120)
      .slice(0, 2);
  } catch (e) {
    console.warn('[follow-ups] skipped:', e.message);
    return [];
  }
}

async function attachFollowUps(bubble, msgObj, question, answer) {
  const items = await generateFollowUps(question, answer);
  if (!items.length) return;
  if (msgObj) {
    msgObj.followUps = items;
    // Persisted here rather than left for whatever saves next. These arrive after
    // the answer was already written, so without this they only reached storage
    // if the student happened to send another message — close the tab first and
    // reopening the conversation showed an answer with no follow-ups under it.
    saveSessionsToStorage();
  }
  // The user may have sent another message or switched sessions while this was
  // in flight — only render if the bubble it belongs to is still on screen.
  if (!bubble || !document.body.contains(bubble) || isStreaming) return;
  const el = buildFollowUpsEl(items);
  if (el) { bubble.appendChild(el); autoScroll(); }
}

async function sendMessage() {
  if (isStreaming) return;
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;

  // No model selected → teach the user what to do (keeps their typed message).
  if (!ensureModelSelected()) return;

  input.value = '';
  syncComposer();   // collapse back to the one-row layout and reset the height
  clearFollowUps();   // suggestions from the previous turn are stale now
  _userCancelled = false;
  _streamAbort = new AbortController();
  setSendMode(true);   // button becomes a Stop button
  isStreaming = true;

  // Ensure a session exists
  if (!currentSessionId) createSession();
  const session = getCurrentSession();

  const userTime = getTime();
  appendUserMessage(text);
  messages.push({ role: 'user', content: text });
  if (session) session.displayMessages.push({ role: 'user', content: text, time: userTime });

  appendTypingIndicator();
  const _tCtx = Date.now();
  updateThinkingStep('context', 'active', 'Reading your message');
  if (window._setEduCard) window._setEduCard('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>', 'Assembling your conversation history and system instructions into a single prompt for the model...');

  const _runtimeName      = window._AI_NAME_ACTIVE || AI_NAME;
  const _runtimeTone      = (window._AI_TONE_ACTIVE !== undefined ? window._AI_TONE_ACTIVE : AI_TONE);
  const _runtimeKnowledge = window._AI_KNOWLEDGE_ACTIVE || '';
  const _basePrompt = _runtimeTone ||
    `You are ${_runtimeName} — an open source AI assistant built by the Filipino developer community. You run locally via Ollama and Qwen on school lab hardware. Help with programming, open source, AI/ML, local LLM setup, and Filipino tech topics. Be friendly and practical. You may use Filipino/Taglish warmth but stay clear and technical when needed.`;
  const _focusRule = `\n\n## Answer Scope Rule (strict)\nAnswer ONLY what the user explicitly asked for. Do not add adjacent, related, or "bonus" information unless the user asked for it.\n- If the user says "list my projects only", return ONLY projects — no education, no skills, no certifications, no closing offers to add more.\n- If the user asks "what is X", define X — do not also explain Y and Z.\n- If the user asks for a list of N items, return exactly that list — no preamble like "Sure, here's a summary…" and no trailing "If you want, I can also…".\n- Treat words like "only", "just", "specifically" as hard filters. Everything outside that filter must be excluded even if it seems helpful.\n- When information is missing from the provided reference material to answer the exact question, say so briefly instead of substituting related information.\n- Prefer short, direct answers over comprehensive ones. Brevity = accuracy here.`;
  const _languageChoice = window._REPLY_LANG_ACTIVE || 'english';
  const _languageRule = buildLanguageRule(_languageChoice);
  let systemPrompt = _runtimeKnowledge
    ? `${_basePrompt}${_focusRule}${_languageRule}\n\n## Your Knowledge & Abilities\n${_runtimeKnowledge}`
    : `${_basePrompt}${_focusRule}${_languageRule}`;

  // ── Prompt breakdown ────────────────────────────────────────────────
  // Recorded as the prompt is assembled, so the inspector can explain a 7,000
  // character prompt as a handful of labelled parts instead of a wall of text.
  // Each part says where it came from in plain language, because the useful
  // question a beginner has is not "what does this say" but "which switch of
  // mine put it there".
  const _promptParts = [];
  // Takes the text itself, or a character count when the text is spread across
  // several messages and there is nothing to hand over as one string.
  const _part = (label, text, source) => {
    const chars = (typeof text === 'number') ? text : (text || '').length;
    if (chars > 0) _promptParts.push({ label, chars, source });
  };
  _part(`Who ${_runtimeName} is`, _basePrompt,
    _runtimeTone ? 'your custom prompt — Settings › Personalize' : 'the built-in default personality');
  _part('Answer rules', _focusRule, 'built in — keeps replies short and on-topic');
  _part(`Reply language: ${_languageChoice.charAt(0).toUpperCase() + _languageChoice.slice(1)}`,
    _languageRule, 'Settings › Personalize › Reply language');
  _part('Extra knowledge you wrote', _runtimeKnowledge, 'Settings › Personalize › Knowledge');

  const _trainingFiles = Array.isArray(window._TRAINING_FILES_ACTIVE) ? window._TRAINING_FILES_ACTIVE : [];
  const _trainingNotes = window._TRAINING_NOTES_ACTIVE || '';
  let _retrievedCount = 0, _totalChunkCount = 0;
  // What retrieval actually pulled, kept for the citation strip under the answer
  // and stored with the message so reopening the chat shows the same provenance.
  let _kbSources = [];
  const _tKb = Date.now();
  if (_trainingFiles.length || _trainingNotes) {
    updateThinkingStep('files', 'active', 'Searching your knowledge base');
    let trainingBlock = '\n\n## Training Reference Material\nThe user has provided the following reference material. Use it as authoritative background knowledge when relevant.\n';
    if (_trainingNotes) trainingBlock += `\n### Instructions\n${_trainingNotes}\n`;

    // Retrieval: score every chunk against the user's message via TF-IDF +
    // cosine similarity (plain JS, no embedding model/network call) and keep
    // only the top-K most relevant, instead of dumping whole files.
    const allChunks = window.BarangayRAG.buildChunkIndex(_trainingFiles);
    _totalChunkCount = allChunks.length;

    if (allChunks.length) {
      const top = window.BarangayRAG.retrieveTopChunks(text, allChunks);
      _retrievedCount = top.length;
      _kbSources = top.map((c, i) => ({
        n: i + 1, file: c.file, index: c.index, total: c.total,
        score: c.score, text: c.text,
      }));
      // Numbered [K1], [K2]… so a claim can point at the chunk it came from.
      // Distinct from the web results' [1] on purpose — both can appear in one
      // answer, and the chip renderers must not fight over the same marker.
      for (const c of _kbSources) {
        trainingBlock += `\n### [K${c.n}] From: ${c.file} (chunk ${c.index} of ${c.total})\n${c.text}\n`;
      }
      trainingBlock += '\nWhen a statement comes from the reference material above, cite it inline with its marker, e.g. [K1]. Do not cite material you did not use.';
    }
    systemPrompt += trainingBlock;
    _part(_retrievedCount ? `${_retrievedCount} matching chunk${_retrievedCount !== 1 ? 's' : ''} of your sources` : 'Your source instructions',
      trainingBlock,
      _retrievedCount ? `pulled from ${_totalChunkCount} chunks across your uploaded files` : 'Sources panel');
  }

  if (_trainingFiles.length || _trainingNotes) {
    const fileCount = _trainingFiles.length;
    const noteLabel = _trainingNotes ? ' + notes' : '';
    const chunkLabel = _totalChunkCount ? `${_retrievedCount}/${_totalChunkCount} chunks · ` : '';
    updateThinkingStep('files', 'done', 'Knowledge base',
      `${fileCount} file${fileCount !== 1 ? 's' : ''}${noteLabel} · ${chunkLabel}${fmtDur(Date.now() - _tKb)}`);
    // Each retrieved chunk becomes its own trace row, with the score that earned
    // it the slot — the trace already shows web results this way, and there is no
    // reason the student's own documents should be the vaguer half of the record.
    //
    // When every chunk came out of the same file, the rows say "chunk 2 of 3"
    // and name the file once above them. Repeating the filename on every row
    // made three chunks of one PDF look like three separate documents.
    const _kbFileNames = [...new Set(_kbSources.map(c => c.file))];
    if (_kbFileNames.length === 1) {
      addTraceRow('kb-file', 'srcfile', _kbFileNames[0],
        { meta: `${_retrievedCount} of ${_kbSources[0].total} chunks used` });
    }
    _kbSources.forEach(c => addTraceRow(`kb-src-${c.n}`,
      _kbFileNames.length === 1 ? 'chunk' : 'srcfile',
      _kbFileNames.length === 1 ? `chunk ${c.index} of ${c.total}` : `${c.file} · chunk ${c.index}/${c.total}`,
      { meta: `match ${c.score.toFixed(2)}` }));
    if (_totalChunkCount && !_retrievedCount) {
      addTraceRow('kb-none', 'more', 'nothing matched — answering without your sources');
    }
    if (window._setEduCard) window._setEduCard('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>', _retrievedCount
      ? `${fileCount} knowledge file${fileCount !== 1 ? 's' : ''}${noteLabel} loaded — retrieved the ${_retrievedCount} most relevant chunk${_retrievedCount !== 1 ? 's' : ''} (of ${_totalChunkCount}) via keyword matching for this question.`
      : `${fileCount} knowledge file${fileCount !== 1 ? 's' : ''}${noteLabel} loaded, but none of the ${_totalChunkCount} chunks share keywords with this question — the model is answering from its own knowledge.`);
  }
  // The size shown is what will actually be sent, estimated at the usual ~4
  // characters per token — the exact count only comes back with the response.
  const _promptChars = systemPrompt.length + messages.reduce((n, m) => n + (m.content || '').length, 0);
  updateThinkingStep('context', 'done', 'Context ready',
    `${messages.length} msg${messages.length !== 1 ? 's' : ''} · ~${fmtCount(Math.round(_promptChars / 4))} tok · ${fmtDur(Date.now() - _tCtx)}`);

  // ── Web search augmentation (Tavily) ─────────────────────────────────
  let _webSources = [];   // populated when a search returns results → rendered under the answer
  let _webContext = '';   // grounding block injected just before the user's question
  if (window._WEB_SEARCH_ENABLED && (window._TAVILY_KEY || '').trim()) {
    window._thinkingLabelOverride = 'Searching the web';   // pin the rotating loading label
    const _tWeb = Date.now();
    updateThinkingStep('websearch', 'active', 'Searching the web');
    // The query row goes up before the request leaves, so the student can read
    // exactly what was asked on their behalf while the results are still coming.
    addTraceRow('ws-query', 'query', text);
    if (window._setEduCard) window._setEduCard('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18"/></svg>', 'Web search is on — querying Tavily for fresh information, then feeding the top results to the model as context.');
    const sr = await performWebSearch(text);
    window._thinkingLabelOverride = null;   // back to the normal phrases for generation
    const webBlock = buildWebSearchBlock(sr);
    const _webDur = fmtDur(Date.now() - _tWeb);
    if (webBlock) {
      _webContext = webBlock;
      _webSources = sr.results.slice(0, 3).map(r => ({ title: r.title, url: r.url }));
      updateThinkingStep('websearch', 'done', 'Searched the web',
        `${_webSources.length} of ${sr.results.length} used · ${_webDur}`);
      _webSources.forEach((s, i) => addTraceRow(`ws-src-${i}`, 'source', s.title || s.url || 'Untitled', {
        meta: hostOf(s.url), href: s.url
      }));
      // Everything Tavily returned past the three the model was given. They're
      // real results, so they're offered rather than quietly dropped.
      const extra = sr.results.length - _webSources.length;
      if (extra > 0) addTraceRow('ws-more', 'more', `+${extra} more`);
    } else if (sr && sr.error) {
      updateThinkingStep('websearch', 'error', sr.error === 'no-key' ? 'Web search skipped — no API key' : 'Web search failed — answering without it', _webDur);
    } else {
      updateThinkingStep('websearch', 'done', 'Searched the web', `no results · ${_webDur}`);
    }
  }

  // The edu card explains the wait that's about to happen; the matching step is
  // only claimed once the endpoint has actually answered, further down.
  if (_modelWarm) {
    if (window._setEduCard) window._setEduCard('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', `${window.ACTIVE_MODEL} is already loaded in memory. Sending your prompt and streaming tokens back to the browser now...`);
  } else {
    if (window._setEduCard) window._setEduCard('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>', `First request — loading ${window.ACTIVE_MODEL} from disk into RAM. This takes a few seconds the first time. After this, all replies will be much faster.`);
  }

  // Apply prefix / suffix to the message sent to the model (history stays clean)
  const _prefix = window._PROMPT_PREFIX_ACTIVE || '';
  const _suffix = window._PROMPT_SUFFIX_ACTIVE || '';
  let _outgoing = messages;
  if (_prefix || _suffix || _webContext) {
    _outgoing = messages.slice();
    const lastUser = _outgoing.length - 1;
    if (lastUser >= 0 && _outgoing[lastUser].role === 'user') {
      // Web context goes first (strongest grounding), then prefix, then the question.
      _outgoing[lastUser] = {
        ..._outgoing[lastUser],
        content: `${_webContext ? _webContext + '\n\n' : ''}${_prefix ? _prefix + '\n\n' : ''}${_outgoing[lastUser].content}${_suffix ? '\n\n' + _suffix : ''}`
      };
    }
  }

  const _temperature = (typeof window._TEMPERATURE_ACTIVE === 'number') ? window._TEMPERATURE_ACTIVE : 0.3;
  const payload = {
    model: window.ACTIVE_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ..._outgoing],
    temperature: _temperature
  };
  // _MAX_TOKENS_ACTIVE === null means "No limit" → omit the cap entirely
  if (window._MAX_TOKENS_ACTIVE !== null) {
    payload.max_tokens = (typeof window._MAX_TOKENS_ACTIVE === 'number') ? window._MAX_TOKENS_ACTIVE : 1024;
  }
  applyThinkingSwitch(payload);

  // Snapshot for the prompt inspector, taken AFTER applyThinkingSwitch because
  // that appends /think or /no_think to the last user turn. The inspector
  // promises the exact bytes that go on the wire, so it has to be the last word.
  // The parts above cover the system prompt; these cover the user turn, in the
  // order they are actually concatenated. Recorded last so the tail of the list
  // ends on the student's own words — which is the point being made: of
  // everything the model just read, this small piece was yours.
  _part('Live web results', _webContext, 'web search was on for this message');
  _part('Text added before your message', _prefix, 'Settings › Personalize › Prompt prefix');
  _part('What you typed', text, 'the message box');
  _part('Text added after your message', _suffix, 'Settings › Personalize › Prompt suffix');
  if (payload.messages.length > 2) {
    // Everything except the system prompt and the current question.
    const historyChars = payload.messages.slice(1, -1)
      .reduce((n, m) => n + (m.content || '').length, 0);
    _part('Earlier messages in this chat', historyChars,
      `${payload.messages.length - 2} previous message${payload.messages.length - 2 !== 1 ? 's' : ''} — the model has no memory, so they are re-sent every time`);
  }

  const _promptSnapshot = {
    model: payload.model,
    temperature: payload.temperature,
    maxTokens: payload.max_tokens ?? null,
    typedChars: text.length,
    parts: _promptParts,
    messages: payload.messages.map(m => ({ role: m.role, content: m.content })),
  };

  const startTime = Date.now();
  const _endpointHost = hostOf(window.ACTIVE_BASE) || 'the model endpoint';

  // ── Streaming attempt ────────────────────────────────────────────────
  try {
    updateThinkingStep('connect', 'active', `Contacting ${_endpointHost}`,
      window.ACTIVE_KIND === 'api' ? 'cloud' : 'local');
    const response = await fetch(`${window.ACTIVE_BASE}/chat/completions`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${window.ACTIVE_KEY}`,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
      signal: _streamAbort.signal
    });

    if (!response.ok) {
      updateThinkingStep('connect', 'error', `${_endpointHost} refused the request`, `HTTP ${response.status}`);
      throw new Error(`HTTP ${response.status}`);
    }

    // The endpoint answered, so the trace is describing real work now — show it
    // even if the header still said Offline when this message was sent (a probe
    // can time out against a model that's busy loading and answer fine after).
    if (window._revealThinkingSteps) window._revealThinkingSteps();

    // Headers back. Whatever the server spent getting here — queueing, prompt
    // eval, pulling weights off disk — is real elapsed time, so it's reported
    // as one measured number rather than split into stages we can't observe.
    updateThinkingStep('connect', 'done', `Connected to ${_endpointHost}`, fmtDur(Date.now() - startTime));
    updateThinkingStep('model', 'active',
      _modelWarm ? 'Waking the model' : 'Loading model from disk', window.ACTIVE_MODEL);

    const chatArea = document.getElementById('chat-area');
    const row = document.createElement('div');
    row.className = 'message-row';
    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'avatar ai';
    avatarDiv.textContent = getAIAvatar();
    const bubble = document.createElement('div');
    bubble.className = 'bubble ai';
    const msgBody = document.createElement('div');
    msgBody.className = 'msg-body';
    bubble.appendChild(msgBody);
    row.appendChild(avatarDiv);
    row.appendChild(bubble);

    // Headers arriving doesn't mean the model has produced anything yet — for a big
    // model, prompt-eval + first-token latency can be several seconds. Keep the
    // "Thinking…" indicator up until the first real token streams in, instead of
    // swapping to an empty bubble that just looks like the app went quiet.
    let _revealed = false;
    const revealBubble = () => {
      if (_revealed) return;
      _revealed = true;
      // The trace moves into the answer rather than being thrown away — it keeps
      // updating as the reply streams, then settles above it.
      chatArea.appendChild(row);
      promoteTrace(bubble);
      autoScroll();
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let firstTokenAt = null;   // timestamp of first streamed token → prep/TTFT
    let completionTokens = null;
    let promptTokens = null;
    let finishReason = null;
    let _usingReasoningField = false; // true if model sends reasoning_content separately
    let _dbgChunk = 0;
    let _lastRenderAt = 0;
    // Floor on the repaint rate, not a pace. Only the trailing block is rebuilt
    // (see streamRender), so a repaint is cheap and this can sit near a frame —
    // text lands as good as the moment its token does. The cap only exists to
    // stop a very fast endpoint from repainting several times per frame.
    const RENDER_THROTTLE_MS = 16;

    let cancelled = false;
    try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data);
          if (_dbgChunk++ < 3) console.log('[stream delta]', JSON.stringify(parsed.choices?.[0]?.delta));
          if (parsed.usage) {
            completionTokens = parsed.usage.completion_tokens ?? completionTokens;
            promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          }
          if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
          const rc = parsed.choices?.[0]?.delta?.reasoning_content;
          const cc = parsed.choices?.[0]?.delta?.content;
          let delta = '';
          if (rc) {
            _usingReasoningField = true;
            if (!fullText.includes('<think>')) fullText += '<think>';
            delta = rc;
          } else if (cc) {
            // Only auto-close if WE synthesized the <think> tag via reasoning_content
            if (_usingReasoningField && fullText.includes('<think>') && !fullText.includes('</think>')) {
              fullText += '</think>';
            }
            delta = cc;
          }
          if (delta) {
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              revealBubble();
              updateThinkingStep('model', 'done', 'Model ready',
                `first token at ${fmtDur(firstTokenAt - startTime)}`);
              updateThinkingStep('stream', 'active', 'Writing the answer');
            }
            fullText += delta;
            // Full markdown re-parse is O(current length) — reformatting on every single
            // token turns a long stream into O(n^2) work and stalls the main thread until
            // the whole reply "dumps" at once. Cap how often we actually repaint.
            const now = Date.now();
            if (now - _lastRenderAt >= RENDER_THROTTLE_MS) {
              _lastRenderAt = now;
              const tp = parseThinkDisplay(fullText);
              if (tp.think) {
                renderThinkInBubble(bubble, tp.think, tp.display, tp.partial ?? true);
              } else {
                streamRender(msgBody, fullText);
              }
              setStreamCaret(bubble, true);
              // A live count, estimated from characters until the usage record
              // arrives at the end of the stream and replaces it with the real one.
              updateThinkingStep('stream', 'active', 'Writing the answer',
                `~${fmtCount(Math.round(fullText.length / 4))} tok`);
              autoScroll();
            }
          }
        } catch (e) { if (_dbgChunk++ < 6) console.error('[stream parse error]', e.message, data?.slice(0, 120)); }
      }
    }
    } catch (readErr) {
      // Stop button aborts the reader — handle gracefully; rethrow real errors.
      if (_userCancelled || readErr.name === 'AbortError') cancelled = true;
      else throw readErr;
    }

    // Guarantee the indicator is cleared and the bubble is on-screen even if the
    // model never emitted a single token (empty response, or cancelled that early).
    revealBubble();

    // If model used reasoning_content but never closed <think>, force-close so the block renders
    if (fullText.includes('<think>') && !fullText.includes('</think>')) {
      fullText += '</think>';
    }

    // Render is throttled during streaming, so the last chunk (and the think-closed
    // state) may not have painted yet — always do one final unthrottled render here.
    if (fullText) {
      const tpFinal = parseThinkDisplay(fullText);
      // `true` releases the trailing word held back mid-stream; the caret comes
      // off now that nothing more is being written.
      if (tpFinal.think) {
        renderThinkInBubble(bubble, tpFinal.think, tpFinal.display, false);
      } else {
        streamRender(msgBody, fullText);
      }
      setStreamCaret(bubble, false);
    }

    // True when the model spent its whole turn on reasoning_content and never emitted
    // any real content — e.g. a reasoning model whose max_tokens cap ran out mid-think.
    const thinkOnly = fullText.includes('<think>') && !parseThinkDisplay(fullText).display;

    // Close the last step on whatever actually happened. Token counts are exact
    // when the endpoint sent a usage record and marked "~" when it didn't.
    const _streamMs = (firstTokenAt != null) ? (Date.now() - firstTokenAt) : 0;
    const _outTok = completionTokens ?? (fullText ? Math.round(fullText.length / 4) : 0);
    const _speed = (_streamMs > 0 && _outTok) ? ` · ${(_outTok / (_streamMs / 1000)).toFixed(1)} tok/s` : '';
    const _tokMeta = `${completionTokens == null ? '~' : ''}${fmtCount(_outTok)} tok${_speed}`;
    if (firstTokenAt === null) {
      // Not a single token arrived, so the model step never got its completion
      // signal — leaving it ticked would claim work that never happened.
      updateThinkingStep('model', 'error',
        cancelled ? 'Stopped before the model replied' : 'Model returned nothing',
        finishReason || '');
    } else if (cancelled) {
      updateThinkingStep('stream', 'error', 'Stopped by you', _tokMeta);
    } else if (thinkOnly) {
      updateThinkingStep('stream', 'error', 'Thought but never answered',
        finishReason === 'length' ? 'hit the token limit' : _tokMeta);
    } else {
      updateThinkingStep('stream', 'done', 'Wrote the answer', _tokMeta);
    }

    if (!fullText && !cancelled) {
      msgBody.innerHTML = '<em style="color:var(--text-muted)">No response received.</em>';
      // Remove the user message so this failed turn doesn't poison history
      messages.pop();
      if (session && session.displayMessages.length) session.displayMessages.pop();
    } else if (thinkOnly && !cancelled) {
      // Popping the answerless turn happens below (savedContent is empty, so the
      // existing "model only generated thinking" branch at the bottom handles it).
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-muted);font-style:italic;margin-top:6px;font-size:13px';
      note.textContent = (finishReason === 'length')
        ? `The model used its entire${window._MAX_TOKENS_ACTIVE ? ` ${window._MAX_TOKENS_ACTIVE}-token` : ''} limit thinking and didn't get to answer. Try raising the token limit or setting it to "No limit".`
        : "The model finished thinking but didn't produce an answer.";
      bubble.appendChild(note);
    }

    // Show the cancellation note (after any partial answer the model managed to stream).
    if (cancelled) bubble.appendChild(cancelledNoteEl());

    // Provenance: which of the student's own chunks were used (with the score
    // that earned each its place), which web results, and the literal prompt.
    // The inspector attaches even when the turn produced nothing — "what did it
    // actually send?" is most worth answering on the turns that went wrong.
    const _provenance = {
      sources: _webSources.length ? _webSources : undefined,
      kbSources: _kbSources.length ? _kbSources : undefined,
      prompt: _promptSnapshot,
    };
    attachProvenance(bubble, fullText ? _provenance : { prompt: _promptSnapshot });

    // Work is over: the header stops shimmering, states the total, and folds
    // away. `traceData` is what gets stored so reopening this chat replays it.
    const traceData = settleTrace(bubble);
    if (traceData) traceData.model = window.ACTIVE_MODEL;

    const aiTime = getTime();
    const timeDiv = document.createElement('div');
    timeDiv.className = 'message-time';
    timeDiv.textContent = aiTime;
    chatArea.appendChild(timeDiv);
    const prepMs = (firstTokenAt != null) ? (firstTokenAt - startTime) : null;
    const stats = appendMsgMeta(chatArea, Date.now() - startTime, completionTokens, fullText, promptTokens, prepMs);

    const savedContent = fullText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (cancelled) {
      // Cancelled turns stay visible but are excluded from the model's context.
      messages.pop();   // remove the unanswered user turn we pushed at send start
      if (session) session.displayMessages.push({ role: 'assistant', content: savedContent + CANCEL_MARK, time: aiTime, stats, cancelled: true, trace: traceData });
    } else if (savedContent) {
      messages.push({ role: 'assistant', content: savedContent });
      const msgObj = { role: 'assistant', content: savedContent, time: aiTime, stats,
        sources: _provenance.sources, kbSources: _provenance.kbSources,
        prompt: _promptSnapshot, trace: traceData };
      if (session) session.displayMessages.push(msgObj);
      // Fire-and-forget: the answer is already rendered, so this resolves in
      // the background and appends underneath if it comes back in time.
      attachFollowUps(bubble, msgObj, text, savedContent);
    } else if (fullText) {
      // model only generated thinking — pop the user message so history stays consistent
      messages.pop();
      if (session && session.displayMessages.length) session.displayMessages.pop();
    }
    updateHistory(text);
    setConnected(true);
    _modelWarm = true;

  } catch (streamErr) {
    // Say what went wrong in the trace before it's frozen — a turn that failed
    // is exactly the one worth being able to reopen and read. Which step gets
    // the blame depends on how far we actually got: a request that never came
    // back has no streaming to fail.
    const _aborted = _userCancelled || streamErr.name === 'AbortError';
    if (traceStatus('model') !== null) {
      updateThinkingStep('stream', 'error',
        _aborted ? 'Stopped by you' : 'Streaming failed',
        _aborted ? '' : (streamErr.message || 'connection error'));
    } else if (traceStatus('connect') !== 'error') {
      updateThinkingStep('connect', 'error', `Couldn't reach ${_endpointHost}`,
        _aborted ? 'stopped' : (streamErr.message || 'connection error'));
    }
    removeTypingIndicator();
    const failTrace = captureTrace();
    if (failTrace) failTrace.model = window.ACTIVE_MODEL;

    // User pressed Stop before any tokens streamed → show the note, skip fallback.
    if (_aborted) {
      const ca = document.getElementById('chat-area');
      const row = document.createElement('div');
      row.className = 'message-row';
      row.innerHTML = `<div class="avatar ai">${getAIAvatar()}</div><div class="bubble ai"></div>`;
      const cancelBubble = row.querySelector('.bubble');
      attachTrace(cancelBubble, failTrace);
      cancelBubble.appendChild(cancelledNoteEl());
      ca.appendChild(row);
      messages.pop();   // drop the unanswered user turn from API context
      if (session) session.displayMessages.push({ role: 'assistant', content: CANCEL_MARK, time: getTime(), cancelled: true, trace: failTrace });
      autoScroll();
      return;
    }

    // ── Non-streaming fallback ───────────────────────────────────────
    try {
      // Reopen the same recorder so the retry appends to the failed attempt's
      // history rather than pretending the turn started over.
      _trace = { startMs: (failTrace ? failTrace.startMs : startTime), rows: (failTrace ? failTrace.rows : []) };
      updateThinkingStep('fallback', 'active', 'Retrying without streaming');
      const res2 = await fetch(`${window.ACTIVE_BASE}/chat/completions`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${window.ACTIVE_KEY}` },
        body: JSON.stringify({ ...payload, stream: false })
      });

      if (!res2.ok) throw new Error(`HTTP ${res2.status}: ${await res2.text()}`);

      const data = await res2.json();
      const aiText = data.choices?.[0]?.message?.content || 'No response.';
      const aiTime = getTime();
      const fallbackTokens = data.usage?.completion_tokens ?? data.usage?.total_tokens ?? null;
      updateThinkingStep('fallback', 'done', 'Answered without streaming',
        `${fallbackTokens == null ? '~' : ''}${fmtCount(fallbackTokens ?? Math.round(aiText.length / 4))} tok · ${fmtDur(Date.now() - startTime)}`);
      const okTrace = captureTrace();
      if (okTrace) okTrace.model = window.ACTIVE_MODEL;
      _trace = null;
      const fallbackBubble = appendAIMessage(aiText, okTrace);
      const stats = appendMsgMeta(document.getElementById('chat-area'), Date.now() - startTime, fallbackTokens, aiText, data.usage?.prompt_tokens ?? null);
      messages.push({ role: 'assistant', content: aiText });
      const msgObj = { role: 'assistant', content: aiText, time: aiTime, stats, trace: okTrace,
        sources: _webSources.length ? _webSources : undefined,
        kbSources: _kbSources.length ? _kbSources : undefined,
        prompt: _promptSnapshot };
      // Same answer, same provenance — a turn that fell back to non-streaming is
      // no less entitled to show its sources than one that streamed cleanly.
      attachProvenance(fallbackBubble, msgObj);
      if (session) session.displayMessages.push(msgObj);
      attachFollowUps(fallbackBubble, msgObj, text, aiText);
      updateHistory(text);
      setConnected(true);
      _modelWarm = true;

    } catch (fetchErr) {
      // ── XHR last resort ─────────────────────────────────────────
      const msg = fetchErr.message || '';
      let errorData = {};

      // Every diagnosis below tells the reader to open a terminal and
      // restart Ollama — correct for a student on their own machine, and
      // useless to a visitor on someone's published link, who has neither.
      // Visitors get one honest message aimed at the only person who can
      // actually fix it: the owner.
      if (window.IS_VISITOR) {
        // Each state names the one person who can fix it and what they must
        // do. The catch-all stays vague on purpose — a visitor cannot act on
        // a stack trace — but anything the provider explained gets its own
        // branch, because "try again later" is wrong advice for a dead key
        // and sends the owner waiting on a reset that is never coming.
        const _vh = parseHttpError(msg);
        const unconfigured = msg.includes('model_not_configured') || msg.includes('503');
        // A retired model name answers 404 with the key working fine, so
        // "overloaded, try again" would send the owner hunting a new key for
        // days. Providers rename and shut down models on a schedule; say so.
        const retiredModel = _vh.status === 404 || msg.includes('model_not_found');
        // Out of allowance. On a free tier this resets on a clock, so it is a
        // "wait" for the visitor and a "check your usage" for the owner.
        const outOfQuota = _vh.status === 429;
        // The key itself was refused: revoked, deleted, or regenerated on the
        // provider dashboard without Vercel being told. Waiting cannot fix it.
        const keyRejected = _vh.status === 401 || _vh.status === 403;
        if (unconfigured) {
          errorData = {
            title: 'This AI has no model connected yet',
            desc: 'Everything about this AI — its name, personality, and knowledge — is set up and ready. It just hasn\'t been given a model to think with, so it can\'t reply yet. Only its owner can finish that step.',
            steps: [
              { text: 'If this is your AI: on Vercel, open Settings → Environment Variables' },
              { text: 'Add MODEL_API_KEY with your own key from console.groq.com (free, no card), then redeploy' },
              { text: 'If it isn\'t yours: let whoever shared the link know — it\'s a two-minute fix' },
            ],
          };
        } else if (retiredModel) {
          errorData = {
            title: 'This AI is pointed at a model that no longer exists',
            desc: 'The key works and the provider answered — it just doesn\'t serve the model this site asks for any more. Providers retire model names on a schedule, and a site pinned to an old one stops replying the day it shuts down.',
            steps: [
              { text: 'If this is your AI: check your provider\'s model list for a current name (on Groq, console.groq.com/docs/models)' },
              { text: 'On Vercel, set MODEL_NAME to that name under Settings → Environment Variables, then redeploy' },
              ...(_vh.detail ? [{ text: 'The provider said:', code: _vh.detail }] : []),
              { text: 'If it isn\'t yours: let whoever shared the link know — it\'s a one-variable fix' },
            ],
          };
        } else if (outOfQuota) {
          errorData = {
            title: 'This AI has used up its allowance for now',
            desc: 'Nothing is broken — the model provider is holding requests back because this AI has asked for too many, too fast, or too many today. Free allowances refill on a clock, so this usually fixes itself.',
            steps: [
              { text: 'Wait a minute and send your message again — per-minute limits refill quickly' },
              { text: 'If this is your AI: check your usage on console.groq.com — daily limits reset every 24 hours' },
              { text: 'To lift the ceiling, upgrade the account or put a fresh key in MODEL_API_KEY on Vercel and redeploy' },
              ...(_vh.detail ? [{ text: 'The provider said:', code: _vh.detail }] : []),
              { text: 'If it isn\'t yours: let whoever shared this link know their AI has hit its limit' },
            ],
          };
        } else if (keyRejected) {
          errorData = {
            title: 'This AI\'s key is no longer accepted',
            desc: 'The model provider refused the key this site is using. Keys don\'t run out on their own, so this means it was deleted, regenerated, or revoked on the provider\'s side — waiting won\'t bring it back. Only the owner can replace it.',
            steps: [
              { text: 'If this is your AI: create a new key at console.groq.com (free, no card)' },
              { text: 'On Vercel, replace MODEL_API_KEY under Settings → Environment Variables, then redeploy' },
              ...(_vh.detail ? [{ text: 'The provider said:', code: _vh.detail }] : []),
              { text: 'If it isn\'t yours: let whoever shared this link know their key needs renewing — it\'s a two-minute fix' },
            ],
          };
        } else {
          errorData = {
            title: 'The AI couldn\'t be reached',
            desc: 'The request to this AI\'s model didn\'t come back. It may be briefly overloaded, or something on the way there is having a bad moment.',
            steps: [
              { text: 'Wait a few seconds and send your message again' },
              { text: 'If it keeps failing, let whoever shared this link know' },
              ...(_vh.detail ? [{ text: 'The provider said:', code: _vh.detail }] : []),
            ],
          };
        }
        removeTypingIndicator();
        renderErrorBubble(errorData);
        setConnected(false);
        return;
      }

      // Which endpoint just failed decides which advice is true. Everything
      // below the cloud branch assumes a local Ollama the reader can restart.
      const _isCloud = window.ACTIVE_KIND === 'api';
      const _http = parseHttpError(msg);

      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS') || msg.includes('Load failed')) {
        try {
          const xhrResult = await xhrFallback(payload);
          removeTypingIndicator();
          const xhrTime = getTime();
          updateThinkingStep('fallback', 'done', 'Answered over XHR',
            `fetch was blocked · ${fmtDur(Date.now() - startTime)}`);
          const xhrTrace = captureTrace();
          if (xhrTrace) xhrTrace.model = window.ACTIVE_MODEL;
          _trace = null;
          appendAIMessage(xhrResult, xhrTrace);
          const stats = appendMsgMeta(document.getElementById('chat-area'), Date.now() - startTime, null, xhrResult);
          messages.push({ role: 'assistant', content: xhrResult });
          if (session) session.displayMessages.push({ role: 'assistant', content: xhrResult, time: xhrTime, stats, trace: xhrTrace });
          updateHistory(text);
          setConnected(true);
          _modelWarm = true;
          isStreaming = false;
          setSendMode(false);
          document.getElementById('message-input').focus();
          return;
        } catch {
          errorData = _isCloud ? cloudErrorCard(null, '') : {
            title: "Ollama isn't allowing browser requests",
            desc: "The AI model is running but your browser can't reach it because of a security setting. This is a one-line fix.",
            steps: [
              { text: 'In a terminal, from the project folder, run:', code: OLLAMA_SCRIPT_CMD },
              { text: 'That stops and restarts Ollama correctly. Or do it by hand in one line:', code: OLLAMA_RESTART_CMD },
              { text: 'Wait a few seconds, then try sending your message again' },
            ],
            cta: true,
            guidePage: 4,   // Run it locally — start Ollama + connect
            ctaLabel: 'Open the setup guide',
          };
        }
      } else if (_isCloud) {
        errorData = cloudErrorCard(_http.status, _http.detail);
      } else if (msg.includes('401')) {
        errorData = {
          title: "Ollama rejected the connection",
          desc: "Authorization error. Restart Ollama with the correct settings.",
          steps: [
            { text: 'Open a terminal and run:', code: OLLAMA_START_CMD },
            { text: 'Refresh this page and try again' }
          ],
          cta: true,
          guidePage: 4,   // Run it locally — start Ollama + connect
          ctaLabel: 'Open the setup guide',
        };
      } else if (msg.includes('404')) {
        errorData = {
          title: "Model not found",
          desc: "Ollama is running but can't find the Qwen model.",
          steps: [
            { text: 'Open a terminal and run:', code: 'ollama list' },
            { text: 'If qwen2.5:3b is missing, pull it:', code: 'ollama pull qwen2.5:3b' },
            { text: 'Try again once the model finishes loading' }
          ],
          cta: true,
          guidePage: 2,   // Pre-install — install Ollama + pull a model
          ctaLabel: 'How to install a model',
        };
      } else if (msg.includes('500') || msg.includes('502') || msg.includes('503')) {
        errorData = {
          title: "The AI model crashed or is overloaded",
          desc: "Ollama returned a server error — the model may still be loading or your machine ran out of memory.",
          steps: [
            { text: 'Wait 10–15 seconds and try again' },
            { text: 'Try the lighter model:', code: 'ollama run qwen3.5:0.8b' },
            { text: 'Restart Ollama:', code: OLLAMA_START_CMD }
          ],
          cta: true,
          guidePage: 1,   // Models 101 — pick a lighter model that fits
          ctaLabel: 'Find a lighter model',
        };
      } else if (msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ECONNREFUSED')) {
        errorData = {
          title: "Ollama is not running",
          desc: "Nothing is listening at the AI address. Start Ollama first.",
          steps: [
            { text: 'In a terminal, from the project folder, run:', code: OLLAMA_SCRIPT_CMD },
            { text: 'Or start it by hand:', code: OLLAMA_START_CMD },
            { text: 'Leave that window open, then try again' },
            { text: 'If it says the port is already in use, free it first:', code: OLLAMA_STOP_CMD },
          ],
          cta: true,
          guidePage: 4,   // Run it locally — start Ollama + connect
          ctaLabel: 'Open the setup guide',
        };
      } else {
        errorData = {
          title: "Something went wrong",
          desc: "The AI couldn't be reached. Try these fixes one by one.",
          steps: [
            { text: 'Make sure Ollama is running:', code: OLLAMA_START_CMD },
            { text: 'Check the model is installed:', code: 'ollama list' },
            { text: 'Try the API directly in your browser:', code: 'localhost:11434/v1/models' },
            { text: 'If nothing works, raise your hand — your facilitator can help' }
          ],
          cta: true,
          guidePage: 4,   // Run it locally — start Ollama + connect
          ctaLabel: 'Open the setup guide',
        };
      }

      removeTypingIndicator();
      renderErrorBubble(errorData);
      setConnected(false);
    }
  } finally {
    // A setup card explains the failure better than a trace would, so the error
    // paths drop theirs — but the recorder must not leak into the next turn.
    _trace = null;
    isStreaming = false;
    _streamAbort = null;
    setSendMode(false);
    document.getElementById('message-input').focus();
  }
}


# Barangay AI

A polished, fully client-side AI chat app by **DEVCON.PH** — built to run on top of a **local** large language model so anyone can have a private, offline-capable AI assistant. No accounts, no cloud, no server. Just a handful of files and your browser.

Built for DEVCON camps and barangay-level digital literacy: open one HTML file, point it at a local model, and start chatting — in English, Filipino, Taglish, or your own regional language.

**Repository:** [github.com/Spod101/barangayAI](https://github.com/Spod101/barangayAI)

---

## Features

- **Local-first AI chat** — talks to any OpenAI-compatible endpoint (designed for [Ollama](https://ollama.com) running on your own machine).
- **Conversation history** — multiple sessions, saved durably in your browser via SQLite (sql.js + IndexedDB). Your chats never leave your device.
- **Filipino language support** — reply in **English, Filipino (Tagalog), Taglish, Bisaya, Hiligaynon, or Ilocano**, with grammar rules tuned to keep responses natural and free of Indonesian/Malay contamination.
- **Customizable persona** — name your AI, pick a tone (friendly, formal, teacher, strict), or write your own system prompt. There's even an AI-assisted prompt expander.
- **Ground it on your docs** — upload `.txt`, `.md`, `.json`, `.csv`, `.log`, `.pdf`, or `.docx` files as knowledge the AI can draw on. Ships pre-loaded with the DEVCON 17 brand kit so answers are grounded from the first run (removable like any other source).
- **Shows its receipts** — every answer can show exactly which chunk of which of your files it used, the similarity score that earned each one its place in the prompt, and the **literal prompt that was sent to the model**. Retrieval is a mechanism you can inspect and tune, not a black box.
- **Works with the internet unplugged** — libraries and fonts are vendored, and a service worker precaches the whole app on first visit. After that the only thing that has to be reachable is your model, which is on your own machine.
- **Web search** — optional live web results via [Tavily](https://tavily.com) (bring your own API key).
- **Onboarding flow + Camp Guidebook** — a friendly first-run experience and an in-app guide.
- **Dark mode**, markdown rendering, streaming responses, context-usage stats, and a collapsible sidebar.

> **On "training":** nothing is fine-tuned. Your files are chunked, and the chunks most relevant to each question are retrieved and pasted into the prompt (classic TF-IDF, no embedding model). That's retrieval-augmented generation — the model is *grounded* on your documents, not trained on them. The Sources panel under each answer shows precisely what got pulled in.

---

## Quick start

### 1. Install Ollama and pull a model

Download Ollama from [ollama.com](https://ollama.com), then pull the default model:

```bash
ollama pull qwen2.5:3b
```

### 2. Start Ollama so the browser can reach it

Opening the Ollama app is **not enough**. Browsers refuse to talk to a local server that hasn't declared the page allowed, and that permission is the `OLLAMA_ORIGINS` environment variable. Without it the app loads but every message fails with a CORS error.

**Easiest — run the included script** from the project folder:

```powershell
.\start-ollama.cmd     # Windows (PowerShell) — the leading .\ is required
```
```bash
./start-ollama.sh      # macOS / Linux  (chmod +x start-ollama.sh once)
```

It frees port 11434 if something is stuck on it, then starts the server with browser access enabled. Leave that terminal open. (Double-clicking the file in Explorer/Finder does the same thing.)

**Or type it yourself** — one line, stops anything stale and starts clean:

```powershell
# Windows (PowerShell)
Stop-Process -Name "ollama*" -Force -ErrorAction SilentlyContinue; $env:OLLAMA_ORIGINS="*"; ollama serve
```

```bash
# macOS / Linux
pkill -f ollama; OLLAMA_ORIGINS=* ollama serve
```

> Note for Windows: `OLLAMA_ORIGINS=* ollama serve` is **bash** syntax. PowerShell doesn't understand it — use `$env:OLLAMA_ORIGINS="*"` as above.

Ollama now serves an OpenAI-compatible API at `http://127.0.0.1:11434/v1`.

#### Skip this step forever

Set the variable permanently instead of per-session. Run it once, restart Ollama, and the normal Ollama app (tray / menu bar) is browser-reachable on every boot — no script, no manual `ollama serve` ever again:

```powershell
# Windows (PowerShell) — then quit Ollama from the tray and reopen it
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS","*","User")
```

```bash
# macOS / Linux — then restart your terminal and Ollama
echo 'export OLLAMA_ORIGINS="*"' >> ~/.zshrc
```

> `*` means *any* page you visit can send requests to your local Ollama while it's running. That's the right trade for a camp laptop or a dev machine. If you'd rather be strict, set the exact origin instead — e.g. `http://localhost:8000` — and it will still work with the Quick start below.

### 3. Get the code

Clone the repo — or [download it as a ZIP](https://github.com/Spod101/barangayAI/archive/refs/heads/main.zip) if you don't have Git:

```bash
git clone https://github.com/Spod101/barangayAI.git
cd barangayAI
```

Planning to change anything and send it back? [Fork it](https://github.com/Spod101/barangayAI/fork) first and clone your own fork instead — see [CONTRIBUTING.md](CONTRIBUTING.md).

### 4. Open the app

Because the app loads its CSS and JS as separate files (`styles.css`, `db.js`, `rag.js`, `app/*.js`), open it through a local web server rather than `file://` (browsers block script loading from `file://`):

```bash
# from the project folder — pick whichever you have
python -m http.server 8000
# then visit http://localhost:8000

# or, with Node installed:
npx serve .
```

Then open the served URL and **pick a model** when prompted. That's it.

> No model is selected by default — choose one from the model picker after the app discovers what Ollama has available.

---

## Configuration

All defaults live in the **CONFIG block at the top of [`app/config.js`](app/config.js)** — edit it to customize your build:

```js
const API_BASE     = 'http://127.0.0.1:11434/v1';  // your local model endpoint
const API_KEY      = 'ollama';                       // any value works for Ollama
const MODEL        = 'qwen2.5:3b';                   // default model id
const AI_NAME      = 'DEVCON';                        // display name
const AI_AVATAR    = 'DV';                            // avatar initials
const BRAND_COLOR  = '#4F46E5';
const ACCENT_COLOR = '#00A8E8';
const AI_TONE      = null;   // set a string to override the default system prompt
const SUGGESTIONS  = null;   // set an array of suggestion cards to override defaults
const CONTEXT_WINDOW = 32768; // model context window, used for the "context used" stat
```

Most settings (tone, language, max tokens, web search key, training files, custom system prompt) can also be changed at runtime in **Settings** inside the app — those are saved to your browser.

### Publishing your AI (optional)

Everything you customize is saved **in your browser**, not in the code — that's what makes it private, and it means `git push` alone would deploy the blank starter app rather than *your* AI. To share yours as a link:

1. **Settings → Publish → Download `my-ai.json`**, then drop that file into the project folder (beside `index.html`).
2. Commit and push it, then import the repo on [Vercel](https://vercel.com) (Add New → Project → Deploy).
3. Add a model for your visitors. They can't reach the Ollama on *your* machine, so the deployed copy proxies to a hosted model through `/api`. On Vercel: **Settings → Environment Variables** → add `MODEL_API_KEY` → Redeploy.

```
MODEL_API_KEY    required — your own free key from console.groq.com (no card)
MODEL_API_BASE   optional — defaults to https://api.groq.com/openai/v1
MODEL_NAME       optional — which model(s) to offer, comma-separated.
                 Unset = all of them, and visitors pick.
```

The key is **yours** — you create it on your own provider account, and every message a visitor sends draws on your allowance, not anyone else's. It stays in Vercel and is only ever read server-side by [`api/proxy.js`](api/proxy.js). **Never commit one** — public repos get scraped for keys within hours. `my-ai.json` is written without any key by design.

**What visitors get:** your AI's name, personality, reply language, brand color, greeting, and uploaded sources — plus their own private chat history in their own browser. **What they can't do:** open Settings, change the personality or language, add or remove sources, or change what the AI *is*. They **can** switch models, from the picker under the composer — by default the picker offers every chat model your key can reach. Set `MODEL_NAME` to restrict that to one model (or a comma-separated few) and the picker offers only those. Either way the deployed `/api` asks your provider for the live list at request time rather than trusting a name baked into the code, so a model your provider retires drops out of the picker instead of taking the site down.

To see exactly what they'll see, open your local copy at `?visitor=1` once `my-ai.json` is in the folder.

> The published copy answers using a **hosted** model, so it is not the private, offline AI — and it says so on the page. The copy on your own machine is still the free, local, no-cloud one. Anyone with the link spends your key's quota. On a free tier that just means your demo goes quiet until the allowance resets — which is why you should start there rather than on a paid key.

### Using a different backend

Any OpenAI-compatible server works. Point `API_BASE` at it and set `API_KEY` appropriately (e.g. LM Studio, llama.cpp server, or a remote OpenAI-compatible gateway).

### Enabling web search

Web search is off until you add a key. Get one from [Tavily](https://tavily.com), then paste it into **Settings → Model → Tavily API key**.

---

## Project structure

```
barangayAI/
├── start-ollama.cmd    # one-click: free port 11434, then serve with browser access (Windows)
├── start-ollama.sh     # same, for macOS / Linux
├── index.html          # markup only
├── styles.css          # all CSS
├── sw.js               # service worker — precaches the app so it opens offline
├── my-ai.json          # (optional) your published AI — created by Settings → Publish
├── vercel.json         # routes /api/* to the model proxy when deployed
├── api/
│   └── proxy.js        # serverless proxy — holds the hosted model key server-side
├── app/                # app logic, split by feature — loaded in this order via <script> tags
│   ├── config.js       # CONFIG block, tone presets, in-memory state
│   ├── sessions.js     # session list — create/load/switch/persist
│   ├── settings.js     # settings modal — personalization, personas, language picker
│   ├── training.js     # training tab + sidebar sources panel (RAG knowledge sources)
│   ├── onboarding.js   # welcome modal + Camp Guidebook
│   ├── models.js       # model selector, endpoint manager, connectivity checks
│   ├── chat.js         # send/stream, markdown rendering, message rendering, history
│   ├── thinking.js     # deep-thinking toggle + display
│   ├── publish.js      # export my-ai.json + visitor-mode lockdown
│   └── init.js         # welcome screen, chat actions, app bootstrap (window 'load')
├── db.js               # SQLite persistence layer (sql.js + IndexedDB)
├── rag.js              # local knowledge retrieval — chunking + TF-IDF similarity, no embedding model
├── vendor/             # sql.js, pdf.js, mammoth.js, fonts — committed, not CDN (see vendor/README.md)
├── assets/
│   ├── logos/          # vendor + brand logos shown in the model picker and welcome screen
│   └── DEVCON-17-Brand-Kit-Aug-6-2026.md   # seeded as the default Source on first run (app/training.js)
└── README.md
```

### Changing the pre-loaded Source

The app ships one Source already loaded so answers are grounded on first run. To swap in your own document, replace `assets/DEVCON-17-Brand-Kit-Aug-6-2026.md` and update the name in `SEED_SOURCE` near the top of the seed block in `app/training.js`. The markdown is read at runtime, so your edit shows up on the next reload — nothing to rebuild.

The seed only ever applies to a library that is empty or still holds the untouched default; it never injects itself into sources you added. It also needs the app served over `http://` (see Quick start) — `fetch()` is blocked at the `file://` origin.

No build step. No framework. No bundler. Just more files instead of one — open any of them, edit, refresh. Script tags load in dependency order (`config.js` first, `init.js` last); if you add a file, add its `<script>` tag in `index.html` in the right spot.

### External libraries (vendored, not fetched)

- [sql.js](https://sql.js.org) — SQLite compiled to WASM, for chat persistence
- [pdf.js](https://mozilla.github.io/pdf.js/) — extracting text from uploaded PDFs
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — extracting text from `.docx` files
- Plus Jakarta Sans + JetBrains Mono — the interface fonts

All of these live in [`vendor/`](vendor/) and are served from the same origin as the app. Nothing is fetched from a CDN, so the app needs **no internet at all** — not even on the first run. See [`vendor/README.md`](vendor/README.md) for versions, licenses, and how to update one.

### Offline

[`sw.js`](sw.js) precaches the app shell on the first visit. After that you can pull the network cable and the page still opens, loads its fonts, restores your conversations, and talks to Ollama on `127.0.0.1`.

Two caveats: a service worker needs a secure context, so this only kicks in on `localhost` or `https://` — the app still works without it, just not offline. And **web search** obviously needs the internet.

When you change an app file, bump `CACHE_VERSION` in `sw.js` so returning users get your version instead of the cached one.

---

## Privacy

Everything stays on your device. Conversations are stored in your browser's IndexedDB, and prompts go only to your local model. The one network call that can leave your machine is **web search**, and only if you explicitly enable it and add a Tavily key.

---

## Troubleshooting

- **"Port already in use" / "address already in use" when starting Ollama** — an Ollama started quietly in the background is already holding port 11434, and it does *not* have `OLLAMA_ORIGINS` set. It has to be stopped before a new one can take the port:

  ```powershell
  Stop-Process -Name "ollama*" -Force    # Windows
  ```
  ```bash
  pkill -f ollama                        # macOS / Linux
  ```

  Then start it again (step 2 above). `start-ollama.cmd` / `start-ollama.sh` already do both.

- **"Ollama isn't allowing browser requests" / CORS error, but Ollama is clearly running** — same cause as above: the running instance is a stale one without `OLLAMA_ORIGINS`. Stop it, start it again with the script or the one-liner.

- **The `OLLAMA_ORIGINS=* ollama serve` command does nothing on Windows** — that's bash syntax. In PowerShell use `$env:OLLAMA_ORIGINS="*"; ollama serve`.

- **"Can't connect" / no models found** — make sure Ollama is running and you've pulled a model (`ollama list`). Test the API directly in your browser: `http://localhost:11434/v1/models`.
- **Blank page / scripts not loading** — you opened `index.html` via `file://`. Serve it over a local web server instead (see Quick start).
- **Responses are slow** — small models like `qwen2.5:3b` are chosen for low-end hardware. Larger models are smarter but need more RAM/GPU.

---

## Contributing

Pull requests are welcome — especially ones that make the app lighter on low-end laptops or better in Filipino languages. `main` is protected, so every change lands through a PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, how to test a change without a test suite, and what never belongs in a commit.

---

## License

Released under the [MIT License](LICENSE) — free to use, modify, fork, and share. Perfect for camps and classrooms.

---

Made with 💙 by [DEVCON.PH](https://devcon.ph)

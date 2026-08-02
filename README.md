# LitCopilot · 生物医学文献研究助手

A Chinese-first, bilingual (中文/English) natural-language search tool for
biomedical researchers. Ask a question in Chinese or English and get a
**synthesized, cited answer** — in your language — grounded in **real**
literature from PubMed and Semantic Scholar (no hallucinated summaries).

> MVP scope: biomedicine only. The retrieval + synthesis core is designed to
> extend to other fields (e.g. energy) later, but no multi-field routing is
> built yet.

---

## What works today (end-to-end)

`detect language → expand query to English medical terms → retrieve (PubMed +
Semantic Scholar, concurrent) → dedupe → DeepSeek synthesis with strict
citations → two-panel bilingual UI`

- **Chinese-first UI** — every string in a translation table, Chinese by
  default, English toggle. Not a bolt-on.
- **Language auto-detection** — Chinese in → Chinese out.
- **Real retrieval** — PubMed E-utilities (esearch + efetch) + Semantic Scholar
  Graph API. Official APIs only, no scraping.
- **Citation-strict synthesis** — DeepSeek answers only from retrieved abstracts,
  cites every claim as `[Author, Year]`, and says so explicitly when the
  abstracts don't support an answer.
- **Clickable citations** — clicking `[Author, Year]` in the answer scrolls to
  and highlights the matching source card.
- **Guardrails** — abstracts are held in memory only for synthesis and never
  stored or displayed verbatim; source cards carry metadata + our own Chinese
  paraphrase only. PubMed calls are rate-limited per NCBI policy.

---

## Project layout

```
litcopilot/
├── backend/                    FastAPI (Python)
│   ├── app/
│   │   ├── main.py             API + /api/search pipeline
│   │   ├── config.py           env-based config (keys never hardcoded)
│   │   ├── schemas.py          request/response models
│   │   ├── db.py               SQLite: saved papers, tags, search history
│   │   ├── routers/library.py  /api/library, /api/history endpoints
│   │   └── services/
│   │       ├── pubmed.py           PubMed esearch + efetch
│   │       ├── semantic_scholar.py Semantic Scholar Graph API (fail-soft)
│   │       ├── retrieval.py        concurrent fetch + dedupe/merge
│   │       ├── llm_service.py      detect / expand / synthesize
│   │       ├── models.py           Paper model + display-safe projection
│   │       └── ratelimit.py        async NCBI rate limiter
│   ├── requirements.txt
│   └── .env.example            copy to .env and add your key
└── frontend/                   React + Vite + Tailwind + react-i18next
    └── src/
        ├── App.jsx             two-panel layout
        ├── i18n/index.js       zh/en translation tables (Chinese-first)
        ├── lib/api.js          backend client
        └── components/
            ├── AnswerText.jsx  clickable-citation renderer
            └── SourceCard.jsx  bilingual source card
```

---

## Running it locally

### 1. Backend (FastAPI, port 8000)

```bash
cd litcopilot/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then put your DeepSeek key in .env
uvicorn app.main:app --reload --port 8000
```

Required env var: `DEEPSEEK_API_KEY`. Optional: `NCBI_API_KEY` (raises the
PubMed rate limit from 3/sec to 10/sec), `DEEPSEEK_MODEL` (default
`deepseek-chat`), `MAX_RESULTS` (default 18).

Health check: `curl http://localhost:8000/api/health`

### 2. Frontend (Vite, port 5173)

```bash
cd litcopilot/frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to the backend.

Without a DeepSeek key the app still retrieves and displays real papers, and
shows a clear banner that no synthesized answer was generated (it never fakes
one).

### 3. Single-service mode (one URL — for sharing / deploy)

Instead of running two dev servers, build the frontend once and let FastAPI
serve it from the same origin as the API:

```bash
cd litcopilot/frontend && npm run build       # emits frontend/dist
cd ../backend && source .venv/bin/activate
uvicorn app.main:app --port 8000               # serves the app AND the API
```

Then open **http://localhost:8000** — one port, no CORS, nothing else running.
FastAPI serves `frontend/dist` (client-side routes fall back to `index.html`)
and keeps `/api/*` for the backend. The static block is inactive until a build
exists, so the two-server dev workflow above still works unchanged. Override the
build location with the `FRONTEND_DIST` env var if needed (useful in Docker).

This is the form to expose via a tunnel (Cloudflare Tunnel / ngrok) or deploy as
a single container. Rotate your `DEEPSEEK_API_KEY` and set a spend cap before any
public exposure, and add auth before real multi-user use.

---

## API

`POST /api/search`

```json
{ "query": "CRISPR递送方法治疗囊性纤维化的最新研究", "lang": null }
```

Returns `original_query`, `detected_lang`, `english_query` (what was actually
searched), `answer` (cited, in the user's language), `sources[]` (metadata-only
cards with `title_zh` / `relevance_zh`), and an optional `warning`.

### Library & history

- `POST   /api/library/save` — save a paper (idempotent; merges tags)
- `GET    /api/library[?tag=]` — list saved papers, optionally filtered by tag
- `DELETE /api/library/{id}` — remove a saved paper (cascades its tags)
- `POST   /api/library/{id}/tags` — add a tag `{ "tag": "..." }`
- `DELETE /api/library/{id}/tags/{tag}` — remove a tag
- `GET    /api/library/tags` — all tags with counts
- `GET    /api/history` — recent searches (auto-recorded on each `/api/search`)
- `DELETE /api/history` — clear history

---

## Data-source notes

| Source | Status |
|--------|--------|
| PubMed / NCBI E-utilities | ✅ integrated |
| Semantic Scholar Graph API | ✅ integrated (fail-soft) |
| ClinicalTrials.gov | ⏳ nice-to-have, has a free API |
| CNKI (中国知网) / 万方 | ❌ no free API; scraping violates ToS → future paid institutional API |
| ChiCTR (中国临床试验注册中心) | ❌ no documented public API → manual/future integration |

---

## Not yet built (next steps)

- Export answer + citations (Markdown / PDF)
- "查找相关试验" → ClinicalTrials.gov
- Follow-up / chat-style questions with context

## Done

- ✅ DeepSeek synthesis (live, needs `DEEPSEEK_API_KEY` in `backend/.env`)
- ✅ Save & organize: 保存 per source card + 我的文库 (My Library) with per-paper
  tagging and tag filtering (SQLite) + revisitable search history

---

## Guardrails (by design)

- Never fabricate citations; if unsupported, the answer says so.
- Never store or display full abstract/article text verbatim — metadata +
  paraphrase only; link out to the source.
- PubMed rate-limited (3/sec anonymous, 10/sec with key).
- All keys in environment variables; `.env` is gitignored.
- For literature-search assistance only — not medical advice.

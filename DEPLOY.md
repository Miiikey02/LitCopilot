# Deploying LitCopilot

The whole app ships as **one Docker image**: a build stage compiles the React
frontend, and the FastAPI backend serves both that frontend and the `/api`
routes on a single port. See [`Dockerfile`](Dockerfile).

## Before you deploy (do these first)

1. **Rotate your DeepSeek key.** The key used in development has been exposed in
   chat/`.env`. Create a fresh one at <https://platform.deepseek.com> and
   **set a monthly spend cap** — a public, login-free app can burn credits.
2. **Never commit `.env`.** It's gitignored, and `.dockerignore` keeps it out of
   the image. The key is provided at runtime as a platform **secret** instead.
3. **Add auth before real multi-user use.** Until then, treat any public link as
   semi-private and keep the spend cap as your safety net.

## Test the image locally (optional but recommended)

```bash
cd litcopilot
docker build -t litcopilot .
docker run --rm -p 8000:8000 -e DEEPSEEK_API_KEY=sk-your-fresh-key litcopilot
# open http://localhost:8000
```

## Option A — Render (simplest; free tier)

1. Push this folder to a GitHub repo (repo root = the `litcopilot/` folder, so
   `Dockerfile` and `render.yaml` sit at the top).
2. Render → **New → Blueprint** → select the repo. It reads
   [`render.yaml`](render.yaml).
3. When prompted, paste `DEEPSEEK_API_KEY` (marked `sync: false` = secret).
4. Deploy. You get a `https://litcopilot.onrender.com`-style URL.

Notes: Render injects `$PORT` (the Dockerfile respects it). The free plan sleeps
when idle (first request is slow) and has an **ephemeral disk** — saved library
and history reset on redeploy. To persist, use a paid instance and uncomment the
`disk:` block in `render.yaml`.

## Option B — Fly.io (scale-to-zero; region control)

```bash
cd litcopilot
fly launch --no-deploy --copy-config --name litcopilot   # reuses fly.toml
fly secrets set DEEPSEEK_API_KEY=sk-your-fresh-key        # secret
fly deploy
```

Notes: [`fly.toml`](fly.toml) defaults to the **Hong Kong (`hkg`)** region for
lower latency to CN/APAC users — change `primary_region` as needed.
`auto_stop_machines` scales to zero when idle. To persist library/history,
create a volume and uncomment the `[mounts]` block:

```bash
fly volumes create litcopilot_data --size 1 --region hkg
```

## Environment variables

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `DEEPSEEK_API_KEY` | ✅ (secret) | — | DeepSeek auth |
| `DEEPSEEK_MODEL` | | `deepseek-chat` | `deepseek-reasoner` also works |
| `NCBI_API_KEY` | | — | Raises PubMed limit 3→10 req/sec |
| `MAX_RESULTS` | | `18` | Default result count |
| `DB_PATH` | | image: `/app/backend/data/litcopilot.db` | SQLite location (mount a volume here to persist) |
| `FRONTEND_DIST` | | image: `/app/frontend/dist` | Built frontend location |

## Reachability from mainland China

PubMed/NCBI and Semantic Scholar are generally reachable from mainland China but
can be inconsistent. Hosting near users (e.g. Fly `hkg`) helps latency. Serving
users *inside* mainland China from a China-based host would require ICP 备案
filing — out of scope for a demo, relevant when this becomes a product.

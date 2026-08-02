# LitCopilot — single-image deploy: build the React frontend, then run the
# FastAPI backend which also serves that built frontend (one port, one service).

# ---- Stage 1: build the React frontend ----
FROM node:20-slim AS frontend
WORKDIR /app/frontend
# Install deps against the lockfile first for better layer caching.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build          # emits /app/frontend/dist

# ---- Stage 2: Python backend that serves API + built frontend ----
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    FRONTEND_DIST=/app/frontend/dist \
    DB_PATH=/app/backend/data/litcopilot.db

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/ ./
# Bring in the compiled frontend from stage 1.
COPY --from=frontend /app/frontend/dist /app/frontend/dist
# Writable dir for the SQLite DB. Mount a volume here to persist library/history
# across deploys; without a volume it still works but resets on redeploy.
RUN mkdir -p /app/backend/data

EXPOSE 8000
# Respect the platform-provided $PORT (e.g. Render); default to 8000 (Fly/local).
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]

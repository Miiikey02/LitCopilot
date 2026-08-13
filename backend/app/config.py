"""Central configuration loaded from environment variables.

Keys never hardcoded — everything comes from the process environment or the
gitignored backend/.env file (see .env.example).
"""
import os
import re

from dotenv import load_dotenv

# Load backend/.env if present. Real deployments set real env vars instead.
load_dotenv()

# --- LLM provider: DeepSeek (OpenAI-compatible API) ---
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
# Two models, split by what the work costs to get wrong.
#
# The default carries the high-volume, mechanical work: query expansion,
# translation, relevance lines, the short quick-search brief. A faster model is
# the right trade there — those calls happen on every search, and a stronger
# model would not translate a title any better.
#
# The "pro" model carries deep research and close reading: planning
# sub-questions, writing a full brief from thirty papers, appraising a single
# paper's methods, answering a question about a passage. Those are the outputs a
# researcher actually acts on, they run far less often, and a wrong one costs
# more than the token difference.
#
# Note that "deepseek-chat" and "deepseek-reasoner" are now both aliases onto
# deepseek-v4-flash — DeepSeek retired the V3/R1 names, so the alias no longer
# says which model answers. Both are named explicitly here for that reason.
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
DEEPSEEK_MODEL_PRO = os.getenv("DEEPSEEK_MODEL_PRO", "deepseek-v4-pro")
# DeepSeek's OpenAI-compatible endpoint. "/v1" also works; it is unrelated to the
# model version.
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

# --- NCBI / PubMed ---
# Optional. Without it PubMed allows 3 req/sec; with it, 10 req/sec.
NCBI_API_KEY = os.getenv("NCBI_API_KEY", "")
# NCBI asks callers to identify themselves via tool + email params.
NCBI_TOOL = os.getenv("NCBI_TOOL", "Gaze")
NCBI_EMAIL = os.getenv("NCBI_EMAIL", "")
# OpenAlex serves a "polite pool" with far higher limits to callers who identify
# themselves. Anonymous callers share one pool per IP, and on shared hosting
# that pool is exhausted by strangers — which shows up as lookups failing for
# reasons that have nothing to do with the query. Falls back to NCBI_EMAIL so
# one address configured once covers both.
OPENALEX_MAILTO = os.getenv("OPENALEX_MAILTO", "") or NCBI_EMAIL

# --- Retrieval tuning ---
MAX_RESULTS = int(os.getenv("MAX_RESULTS", "18"))  # target 15-20 abstracts

# --- Storage: Supabase Postgres ---
# Session-pooler URI from Supabase → Settings → Database → Connection string.
DATABASE_URL = os.getenv("DATABASE_URL", "")

# --- Auth: Supabase ---
# Project URL, e.g. https://abcdefgh.supabase.co — used to fetch the JWKS that
# verifies access tokens, and to check the token issuer.
SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
# Legacy HS256 projects sign tokens with this shared secret instead of JWKS.
# Optional: leave empty when the project uses asymmetric (RS256/ES256) keys.
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")

# --- File storage: Supabase Storage ---
# Uploaded PDFs are files, and a relational database is the wrong place to keep
# files: the free tier measures the database in hundreds of megabytes and a
# single paper is several of them, so a lab importing one reference library
# would exhaust it. Storage is priced and sized for exactly this.
#
# Settings → API → service_role key. It bypasses row-level security, so it is a
# server-only secret and must never reach the browser.
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "gaze-uploads")


def has_llm_key() -> bool:
    return bool(DEEPSEEK_API_KEY.strip())


def has_db() -> bool:
    return bool(DATABASE_URL.strip())


def has_auth() -> bool:
    return bool(SUPABASE_URL or SUPABASE_JWT_SECRET)


def has_blob_storage() -> bool:
    """Whether uploaded files can go to Storage instead of a database column."""
    return bool(SUPABASE_URL and SUPABASE_SERVICE_KEY)


_URL_CREDENTIALS = re.compile(r"(?i)(://[^:/@\s]+:)[^@\s]+(@)")


def redact(text: str) -> str:
    """Strip credentials from text before it reaches a log.

    psycopg echoes the connection string verbatim when it cannot parse it —
    verified: a DATABASE_URL with a bad scheme puts the password straight into
    the exception message, and from there into the deploy log, which is visible
    in the hosting dashboard and easy to paste into a chat.
    """
    text = _URL_CREDENTIALS.sub(r"\1***\2", text)
    for secret in (
        DATABASE_URL,
        DEEPSEEK_API_KEY,
        SUPABASE_JWT_SECRET,
        SUPABASE_SERVICE_KEY,
        NCBI_API_KEY,
    ):
        if secret and len(secret) > 6:
            text = text.replace(secret, "***")
    return text

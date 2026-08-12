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
# Query understanding, translation, and synthesis all use one chat model.
# deepseek-chat (DeepSeek-V3) is the default; deepseek-reasoner (R1) also works.
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
# DeepSeek's OpenAI-compatible endpoint. "/v1" also works; it is unrelated to the
# model version.
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")

# --- NCBI / PubMed ---
# Optional. Without it PubMed allows 3 req/sec; with it, 10 req/sec.
NCBI_API_KEY = os.getenv("NCBI_API_KEY", "")
# NCBI asks callers to identify themselves via tool + email params.
NCBI_TOOL = os.getenv("NCBI_TOOL", "Gaze")
NCBI_EMAIL = os.getenv("NCBI_EMAIL", "")

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


def has_llm_key() -> bool:
    return bool(DEEPSEEK_API_KEY.strip())


def has_db() -> bool:
    return bool(DATABASE_URL.strip())


def has_auth() -> bool:
    return bool(SUPABASE_URL or SUPABASE_JWT_SECRET)


_URL_CREDENTIALS = re.compile(r"(?i)(://[^:/@\s]+:)[^@\s]+(@)")


def redact(text: str) -> str:
    """Strip credentials from text before it reaches a log.

    psycopg echoes the connection string verbatim when it cannot parse it —
    verified: a DATABASE_URL with a bad scheme puts the password straight into
    the exception message, and from there into the deploy log, which is visible
    in the hosting dashboard and easy to paste into a chat.
    """
    text = _URL_CREDENTIALS.sub(r"\1***\2", text)
    for secret in (DATABASE_URL, DEEPSEEK_API_KEY, SUPABASE_JWT_SECRET, NCBI_API_KEY):
        if secret and len(secret) > 6:
            text = text.replace(secret, "***")
    return text

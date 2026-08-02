"""Central configuration loaded from environment variables.

Keys never hardcoded — everything comes from the process environment or the
gitignored backend/.env file (see .env.example).
"""
import os

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

# --- Storage ---
DB_PATH = os.getenv("DB_PATH", os.path.join(os.path.dirname(os.path.dirname(__file__)), "litcopilot.db"))


def has_llm_key() -> bool:
    return bool(DEEPSEEK_API_KEY.strip())

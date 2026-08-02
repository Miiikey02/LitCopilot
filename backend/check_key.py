"""Quick check that the configured DEEPSEEK_API_KEY is present and valid.

Usage (from backend/, venv active):  python check_key.py
Makes one tiny, cheap request so you get a clear pass/fail before running the app.
"""
import sys

from app.config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, has_llm_key


def main() -> int:
    if not has_llm_key():
        print("✗ DEEPSEEK_API_KEY is not set. Put it in backend/.env")
        return 1
    try:
        from openai import OpenAI

        client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)
        resp = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            max_tokens=5,
            messages=[{"role": "user", "content": "ping"}],
        )
        text = resp.choices[0].message.content or ""
        print(f"✓ Key works. Model '{DEEPSEEK_MODEL}' replied: {text.strip()!r}")
        return 0
    except Exception as e:  # noqa: BLE001 - surface any auth/network error clearly
        print(f"✗ Key present but the API call failed: {type(e).__name__}: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())

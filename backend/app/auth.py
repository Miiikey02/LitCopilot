"""Authentication: verify Supabase-issued access tokens.

Supabase owns the credential flow entirely — sign-up, password hashing, storage
and reset all happen in Supabase, and this app never sees a password. The
frontend signs in against Supabase, receives a signed JWT, and sends it as
`Authorization: Bearer <token>`. Here we only verify that signature and read the
user id (`sub`) from it.

Two signing schemes are supported:
  * asymmetric (RS256/ES256) — the current default; keys fetched from the
    project's JWKS endpoint and cached.
  * HS256 with the project's shared JWT secret — older projects.
"""
from __future__ import annotations

from typing import Optional

import httpx
import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

from .config import SUPABASE_JWT_SECRET, SUPABASE_URL, has_auth

_jwk_client: Optional[PyJWKClient] = None
# Cache of the project's JWKS client; PyJWKClient does its own key caching.


def _jwks() -> PyJWKClient:
    global _jwk_client
    if _jwk_client is None:
        if not SUPABASE_URL:
            raise HTTPException(status_code=500, detail="SUPABASE_URL is not configured")
        _jwk_client = PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json")
    return _jwk_client


def _decode(token: str) -> dict:
    """Verify the token's signature and return its claims."""
    # Try asymmetric verification first (current Supabase default).
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Malformed token") from exc

    alg = header.get("alg", "")
    try:
        if alg.startswith(("RS", "ES")):
            key = _jwks().get_signing_key_from_jwt(token).key
            return jwt.decode(
                token, key, algorithms=[alg], audience="authenticated"
            )
        if SUPABASE_JWT_SECRET:
            return jwt.decode(
                token,
                SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
            )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="Session expired") from exc
    except (jwt.PyJWTError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc

    raise HTTPException(status_code=401, detail="Unsupported token algorithm")


def _bearer(request: Request) -> Optional[str]:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def current_user(request: Request) -> str:
    """FastAPI dependency: the signed-in user's id, or 401.

    When auth is not configured (local development without Supabase), every
    request is attributed to a single shared local user so the app still runs.
    """
    if not has_auth():
        return LOCAL_USER_ID

    token = _bearer(request)
    if not token:
        raise HTTPException(status_code=401, detail="Sign in required")
    claims = _decode(token)
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token has no subject")
    return user_id


def optional_user(request: Request) -> Optional[str]:
    """The signed-in user's id, or None — never raises.

    Used by search, which stays usable signed-out; we simply skip recording
    history for anonymous visitors.
    """
    if not has_auth():
        return LOCAL_USER_ID
    if not _bearer(request):
        return None
    try:
        return current_user(request)
    except HTTPException:
        return None


# Stand-in owner used only when Supabase auth is not configured, so a developer
# can run the whole app locally without signing in. Any real deployment sets
# SUPABASE_URL and this is never used.
LOCAL_USER_ID = "00000000-0000-0000-0000-000000000000"

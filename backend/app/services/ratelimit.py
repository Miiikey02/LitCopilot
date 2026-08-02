"""A tiny async rate limiter to respect NCBI's usage policy.

NCBI allows 3 requests/sec without an API key and 10/sec with one. We serialize
outgoing E-utilities calls through this limiter so we never exceed the cap even
under concurrent requests.
"""
import asyncio
import time


class RateLimiter:
    def __init__(self, max_per_second: float):
        self._min_interval = 1.0 / max_per_second
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait = self._min_interval - (now - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()

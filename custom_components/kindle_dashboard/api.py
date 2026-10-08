"""Thin HTTP client for the kindledash renderer app."""

from __future__ import annotations

from typing import Any

import aiohttp


class KindleDashApiError(Exception):
    """Raised when the renderer cannot be reached or answers with an error."""


class KindleDashAuthError(KindleDashApiError):
    """Raised when the renderer rejects the app token."""


class KindleDashApi:
    """Client for GET /status, GET /kindle.png and POST /render."""

    def __init__(self, session: aiohttp.ClientSession, base_url: str, token: str | None = None) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._token = token or ""

    @property
    def base_url(self) -> str:
        """Return the renderer base URL."""
        return self._base_url

    def _headers(self) -> dict[str, str]:
        if self._token:
            return {"X-Kindle-Token": self._token}
        return {}

    async def _request(self, method: str, path: str, timeout_s: float) -> aiohttp.ClientResponse:
        try:
            resp = await self._session.request(
                method,
                f"{self._base_url}{path}",
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=timeout_s),
            )
        except (TimeoutError, aiohttp.ClientError, OSError) as err:
            raise KindleDashApiError(f"Cannot reach renderer at {self._base_url}: {err}") from err
        if resp.status == 401:
            resp.release()
            raise KindleDashAuthError("Renderer rejected the app token")
        return resp

    async def status(self) -> dict[str, Any]:
        """Return the renderer status document."""
        resp = await self._request("GET", "/status", timeout_s=15)
        async with resp:
            if resp.status != 200:
                raise KindleDashApiError(f"Renderer /status returned HTTP {resp.status}")
            data = await resp.json(content_type=None)
        if not isinstance(data, dict):
            raise KindleDashApiError("Renderer /status returned an unexpected payload")
        return data

    async def render(self) -> dict[str, Any]:
        """Force a re-render and return the resulting status."""
        resp = await self._request("POST", "/render", timeout_s=120)
        async with resp:
            data = await resp.json(content_type=None)
            if resp.status != 200:
                message = data.get("error") if isinstance(data, dict) else resp.status
                raise KindleDashApiError(f"Render failed: {message}")
        return data if isinstance(data, dict) else {}

    async def image(self, fresh: bool = False) -> tuple[bytes, dict[str, str]]:
        """Return the latest PNG and selected response headers."""
        path = "/kindle.png?render=1" if fresh else "/kindle.png"
        resp = await self._request("GET", path, timeout_s=120)
        async with resp:
            if resp.status != 200:
                raise KindleDashApiError(f"Renderer /kindle.png returned HTTP {resp.status}")
            body = await resp.read()
            headers = {
                key: resp.headers[key]
                for key in ("ETag", "Last-Modified", "X-Render-Time", "X-Image-Size", "X-Render-Error")
                if key in resp.headers
            }
        return body, headers

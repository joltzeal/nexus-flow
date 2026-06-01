from __future__ import annotations

import asyncio
from dataclasses import dataclass
from time import monotonic
from typing import Any

import httpx

from app.core.config import get_settings
from app.fingerprint_browsers.base import (
    BrowserLaunchOptions,
    BrowserLaunchResult,
    BrowserProfileCreateResult,
    FingerprintBrowserClient,
)


class BitBrowserError(RuntimeError):
    def __init__(self, message: str, response: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.response = response or {}


class BitBrowserRateLimitError(BitBrowserError):
    pass


_RATE_LIMITED_PATHS = {"/browser/update", "/browser/open"}
_RATE_LIMIT_INTERVAL_SECONDS = 0.5
_RATE_LIMIT_MAX_ATTEMPTS = 5
_rate_limit_lock = asyncio.Lock()
_last_rate_limited_request_at = 0.0


@dataclass(slots=True)
class BitBrowserClient(FingerprintBrowserClient):
    base_url: str | None = None
    timeout_seconds: float | None = None

    def __post_init__(self) -> None:
        settings = get_settings()
        self.base_url = (self.base_url or settings.bitbrowser_base_url).rstrip("/")
        self.timeout_seconds = self.timeout_seconds or settings.bitbrowser_timeout_seconds

    async def health_check(self) -> bool:
        response = await self._post("/health")
        return response.get("success") is True

    async def create_profile(self, payload: dict[str, Any]) -> BrowserProfileCreateResult:
        response = await self._post("/browser/update", payload)
        data = self._data(response)
        profile_id = data.get("id")
        if not profile_id:
            raise BitBrowserError("BitBrowser create response did not include data.id.", response)

        return BrowserProfileCreateResult(profile_id=str(profile_id), raw=data)

    async def start_profile(
        self,
        profile_id: str,
        options: BrowserLaunchOptions | None = None,
    ) -> BrowserLaunchResult:
        launch_options = options or BrowserLaunchOptions()
        payload: dict[str, Any] = {
            "id": profile_id,
            "args": launch_options.args,
            "queue": launch_options.queue,
        }

        if launch_options.ignore_default_urls:
            payload["ignoreDefaultUrls"] = True

        if launch_options.new_page_url:
            payload["newPageUrl"] = launch_options.new_page_url

        response = await self._post("/browser/open", payload)
        data = self._data(response)
        debug_address = self._normalize_debug_address(data.get("http"))

        return BrowserLaunchResult(
            profile_id=profile_id,
            debug_address=debug_address,
            websocket_url=data.get("ws"),
            driver_path=data.get("driver"),
            core_version=str(data["coreVersion"]) if data.get("coreVersion") is not None else None,
            pid=self._coerce_int(data.get("pid")),
            seq=self._coerce_int(data.get("seq")),
            raw=data,
        )

    async def stop_profile(self, profile_id: str) -> None:
        await self._post("/browser/close", {"id": profile_id})

    async def delete_profile(self, profile_id: str) -> None:
        await self._post("/browser/delete", {"id": profile_id})

    async def get_profile_detail(self, profile_id: str) -> dict[str, Any]:
        response = await self._post("/browser/detail", {"id": profile_id})
        data = self._data(response)
        return data if isinstance(data, dict) else {}

    async def get_profile_status(self, profile_id: str) -> str:
        response = await self._post("/browser/pids/alive", {"ids": [profile_id]})
        data = self._data(response)

        if isinstance(data, dict) and data.get(profile_id):
            return "running"

        return "stopped"

    async def list_open_profiles(self) -> list[dict[str, Any]]:
        response = await self._post("/browser/ports")
        data = self._data(response)
        if not isinstance(data, dict):
            return []
        return [
            {
                "profile_id": str(profile_id),
                "debug_address": self._normalize_debug_address(port),
            }
            for profile_id, port in data.items()
            if port
        ]

    async def arrange_windows(
        self,
        profile_ids: list[str],
        *,
        start_x: int = 0,
        start_y: int = 0,
        width: int = 500,
        height: int = 950,
        col: int = 3,
        space_x: int = -200,
        space_y: int = 0,
    ) -> None:
        await self._post(
            "/windowbounds",
            {
                "type": "box",
                "startX": start_x,
                "startY": start_y,
                "width": max(width, 1),
                "height": max(height, 1),
                "col": max(col, 1),
                "spaceX": space_x,
                "spaceY": space_y,
                "offsetX": 0,
                "offsetY": 50,
                "orderBy": "asc",
            },
        )

    async def get_open_ports(self) -> dict[str, str]:
        response = await self._post("/browser/ports")
        data = self._data(response)
        if not isinstance(data, dict):
            return {}
        return {str(profile_id): str(port) for profile_id, port in data.items()}

    async def reset_closing_status(self, profile_id: str) -> None:
        await self._post("/browser/closing/reset", {"id": profile_id})

    async def _post(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self.base_url is not None
        assert self.timeout_seconds is not None

        max_attempts = _RATE_LIMIT_MAX_ATTEMPTS if path in _RATE_LIMITED_PATHS else 1
        for attempt in range(1, max_attempts + 1):
            try:
                if path in _RATE_LIMITED_PATHS:
                    async with _rate_limit_lock:
                        await _wait_rate_limit_interval()
                        return await self._post_once(path, payload)
                return await self._post_once(path, payload)
            except BitBrowserRateLimitError:
                if attempt >= max_attempts:
                    raise

                await asyncio.sleep(_RATE_LIMIT_INTERVAL_SECONDS * attempt)

        raise BitBrowserError("BitBrowser API request failed after retries.")

    async def _post_once(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self.base_url is not None
        assert self.timeout_seconds is not None

        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout_seconds) as client:
                response = await client.post(path, json=payload or {})
                response.raise_for_status()
        except httpx.ConnectError as exc:
            raise BitBrowserError(
                f"Cannot connect to BitBrowser Local Server at {self.base_url}.",
            ) from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 429:
                raise BitBrowserRateLimitError(f"BitBrowser API rate limited: {exc}") from exc
            raise BitBrowserError(f"BitBrowser API request failed: {exc}") from exc
        except httpx.HTTPError as exc:
            raise BitBrowserError(f"BitBrowser API request failed: {exc}") from exc

        data = response.json()
        if data.get("success") is not True:
            raise BitBrowserError(data.get("msg") or "BitBrowser API returned success=false.", data)

        return data

    @staticmethod
    def _data(response: dict[str, Any]) -> Any:
        return response.get("data") or {}

    @staticmethod
    def _normalize_debug_address(value: Any) -> str:
        if not value:
            raise BitBrowserError("BitBrowser open response did not include data.http.")

        address = str(value).strip()
        if address.startswith("http://") or address.startswith("https://"):
            return address.removeprefix("http://").removeprefix("https://")

        return address

    @staticmethod
    def _coerce_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None


async def _wait_rate_limit_interval() -> None:
    global _last_rate_limited_request_at

    now = monotonic()
    wait_seconds = _RATE_LIMIT_INTERVAL_SECONDS - (now - _last_rate_limited_request_at)
    if wait_seconds > 0:
        await asyncio.sleep(wait_seconds)

    _last_rate_limited_request_at = monotonic()

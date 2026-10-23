"""Service monitor: check that some web services answer, like Glance's monitor widget."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from typing import Any

import httpx

from .base import Reading, Source

USER_AGENT = "Mozilla/5.0 (marianne dashboard)"


class MonitorSource(Source):
    kind = "monitor"

    def __init__(
        self,
        name: str,
        timeout: float = 5,
        verify_ssl: bool = True,
        wud: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(name)
        # What's Up Docker: which containers have a newer image (each item lists its own).
        self.wud = wud.rstrip("/") if wud else None
        # Redirects are not followed: a 3xx already means the service is up.
        self.client = httpx.AsyncClient(
            timeout=timeout, verify=verify_ssl, headers={"User-Agent": USER_AGENT}, transport=transport,
        )
        # When each url stopped answering, for alarm_after.
        self._down_since: dict[str, datetime] = {}

    def describe(self) -> str:
        return "servicios"

    async def _check(self, url: str) -> tuple[int, float]:
        """Status code and response time in ms; raises if the service doesn't answer."""
        start = time.monotonic()
        async with self.client.stream("GET", url) as response:
            return response.status_code, (time.monotonic() - start) * 1000

    async def _updates(self) -> set[str]:
        """Names of the containers What's Up Docker says can be updated; none if it can't be asked."""
        if not self.wud:
            return set()
        try:
            response = await self.client.get(f"{self.wud}/api/containers")
            response.raise_for_status()
            return {str(c.get("name")) for c in response.json() if isinstance(c, dict) and c.get("updateAvailable")}
        except (httpx.HTTPError, ValueError):
            return set()

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        checks = asyncio.gather(*(self._check(item["url"]) for item in items), return_exceptions=True)
        results, updates = await asyncio.gather(checks, self._updates())
        # A service that is down is a reading, not a failure of the source.
        self.mark_ok()
        readings = [self._reading(item, result) for item, result in zip(items, results)]
        for item, reading in zip(items, readings):
            reading.update = any(name in updates for name in containers(item))
        return readings

    def _reading(self, item: dict[str, Any], result: tuple[int, float] | BaseException) -> Reading:
        label = item.get("name", item["url"])
        if isinstance(result, BaseException):
            up, value = False, "CAÍDO"
        else:
            status, ms = result
            up = status < 400
            value = f"{ms:.0f} ms" if up else f"ERROR {status}"

        now = datetime.now()
        if up:
            self._down_since.pop(item["url"], None)
        since = self._down_since.setdefault(item["url"], now) if not up else None
        alert = not up and bool(item.get("alert", True))
        alarm = None
        if alert and since and "alarm_after" in item:
            minutes = (now - since).total_seconds() / 60
            if minutes >= float(item["alarm_after"]):
                alarm = f"{item.get('alarm_text') or f'{label} {value}'} · desde hace {int(minutes)} min"
        return Reading(label, value, switch=up, alert=alert, alarm=alarm, hidden=bool(item.get("hidden")),
                       icon=item.get("icon"), link=item.get("link", item["url"]))

    async def close(self) -> None:
        await self.client.aclose()


def containers(item: dict[str, Any]) -> list[str]:
    """The service's containers in What's Up Docker: `container:` for one, `containers:` for several."""
    names = item.get("containers", item.get("container", []))
    return [str(name) for name in (names if isinstance(names, list) else [names])]

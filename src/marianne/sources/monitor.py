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
        wud_user: str | None = None,
        wud_password: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(name)
        # What's Up Docker: which containers have a newer image (each item lists its own).
        self.wud = wud.rstrip("/") if wud else None
        # Its login, when it has one (WUD_AUTH_BASIC_…): without it, it answers 401.
        self.wud_auth = httpx.BasicAuth(wud_user, wud_password or "") if wud_user else None
        # Why it couldn't be asked last time, for the services' tooltips; "" when it answered.
        self.wud_error = ""
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
        """Names of the containers What's Up Docker says can be updated; none if it can't be asked
        (and why, in wud_error)."""
        if not self.wud:
            return set()
        try:
            response = await self.client.get(f"{self.wud}/api/containers", auth=self.wud_auth)
            if response.status_code == 401:
                self.wud_error = "What's Up Docker pide usuario y contraseña (wud_user, wud_password)"
                return set()
            response.raise_for_status()
            names = {str(c.get("name")) for c in response.json() if isinstance(c, dict) and c.get("updateAvailable")}
        except httpx.HTTPStatusError as exc:
            self.wud_error = f"What's Up Docker: error {exc.response.status_code}"
            return set()
        except (httpx.HTTPError, ValueError) as exc:
            self.wud_error = f"What's Up Docker: {failure(exc)}"
            return set()
        self.wud_error = ""
        return names

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        checks = asyncio.gather(*(self._check(item["url"]) for item in items), return_exceptions=True)
        results, updates = await asyncio.gather(checks, self._updates())
        # A service that is down is a reading, not a failure of the source.
        self.mark_ok()
        readings = [self._reading(item, result) for item, result in zip(items, results)]
        for item, reading in zip(items, readings):
            reading.update = any(name in updates for name in containers(item))
            # Not knowing about updates shouldn't look like there are none: why, on their tooltips.
            if self.wud_error and containers(item) and not reading.note:
                reading.note = self.wud_error
        return readings

    def _reading(self, item: dict[str, Any], result: tuple[int, float] | BaseException) -> Reading:
        label = item.get("name", item["url"])
        note = ""
        if isinstance(result, BaseException):
            up, value = False, "CAÍDO"
            # Why: shown on the icon's tooltip (a service up for everyone else, down only for
            # marianne, is a certificate or a network problem of marianne's own).
            note = failure(result)
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
        return Reading(label, value, switch=up, alert=alert, alarm=alarm, hidden=bool(item.get("hidden")), note=note,
                       icon=item.get("icon"), link=item.get("link", item["url"]))

    async def close(self) -> None:
        await self.client.aclose()


def failure(error: BaseException) -> str:
    """Why a service didn't answer, in a few words."""
    text = str(error)
    if isinstance(error, httpx.TimeoutException):
        return "no responde a tiempo"
    if "CERTIFICATE_VERIFY_FAILED" in text or "certificate" in text.lower():
        return "certificado no válido"
    if "SSL" in text or "TLS" in text:
        return "fallo de TLS"
    if isinstance(error, httpx.ConnectError):
        if "Name or service not known" in text or "nodename nor servname" in text or "getaddrinfo" in text:
            return "no se encuentra el nombre"
        if "refused" in text.lower():
            return "conexión rechazada"
        return "sin conexión"
    return type(error).__name__


def containers(item: dict[str, Any]) -> list[str]:
    """The service's containers in What's Up Docker: `container:` for one, `containers:` for several."""
    names = item.get("containers", item.get("container", []))
    return [str(name) for name in (names if isinstance(names, list) else [names])]

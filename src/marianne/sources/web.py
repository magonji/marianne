"""Web scraping source: download a page and extract a value with a CSS selector."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
from bs4 import BeautifulSoup

from .base import Reading, Source, check_alert, format_number, make_fraction, parse_number

USER_AGENT = "Mozilla/5.0 (marianne dashboard)"


class WebSource(Source):
    kind = "web"

    def __init__(
        self,
        name: str,
        timeout: float = 15,
        headers: dict[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(name)
        self.client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT, **(headers or {})},
            transport=transport,
        )

    def describe(self) -> str:
        return "scraping"

    async def _page(self, url: str) -> BeautifulSoup:
        response = await self.client.get(url)
        response.raise_for_status()
        return await asyncio.to_thread(BeautifulSoup, response.text, "html.parser")

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        urls = list(dict.fromkeys(item["url"] for item in items))
        pages = dict(zip(urls, await asyncio.gather(*(self._page(u) for u in urls), return_exceptions=True)))

        failures = [page for page in pages.values() if isinstance(page, BaseException)]
        if failures and len(failures) == len(pages):
            self.mark_error(failures[0])
            raise failures[0]
        self.mark_ok()
        return [self._reading(item, pages[item["url"]]) for item in items]

    def _reading(self, item: dict[str, Any], page: BeautifulSoup | BaseException) -> Reading:
        label = item.get("name", item["url"])
        if isinstance(page, BaseException):
            return Reading(label, "ERR RED", error=True)

        element = page.select_one(item["selector"])
        if element is None:
            return Reading(label, "NO ENCONTRADO", error=True)
        text = element.get(item["attr"], "") if "attr" in item else element.get_text(" ", strip=True)
        text = str(text)

        if "regex" in item:
            match = re.search(item["regex"], text)
            if match is None:
                return Reading(label, "SIN COINCIDENCIA", error=True)
            text = match.group(1) if match.groups() else match.group(0)

        unit = item.get("unit", "")
        number = parse_number(text.replace(",", ".")) if item.get("numeric") else None
        value = format_number(number, item.get("decimals")) if number is not None else text
        fraction = make_fraction(number, item, unit)
        alert = check_alert(item, number)
        return Reading(label, value, unit, fraction=fraction, alert=alert, hidden=bool(item.get("hidden")))

    async def close(self) -> None:
        await self.client.aclose()

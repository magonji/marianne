"""News feeds (RSS and Atom): the latest headlines of one or more feeds, newest first."""

from __future__ import annotations

import asyncio
import html
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .base import Reading, Source

USER_AGENT = "Mozilla/5.0 (marianne dashboard)"
ATOM = "{http://www.w3.org/2005/Atom}"
DC_DATE = "{http://purl.org/dc/elements/1.1/}date"


@dataclass
class Entry:
    title: str
    link: str | None
    published: datetime | None


class RssSource(Source):
    kind = "rss"

    def __init__(self, name: str, timeout: float = 15, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(name)
        self.client = httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, headers={"User-Agent": USER_AGENT}, transport=transport,
        )

    def describe(self) -> str:
        return "noticias"

    async def _feed(self, url: str) -> list[Entry]:
        response = await self.client.get(url)
        response.raise_for_status()
        return await asyncio.to_thread(parse_feed, response.content)

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        urls = list(dict.fromkeys(url for item in items for url in feed_urls(item)))
        results = dict(zip(urls, await asyncio.gather(*(self._feed(u) for u in urls), return_exceptions=True)))
        failures = [result for result in results.values() if isinstance(result, BaseException)]
        if failures and len(failures) == len(results):
            self.mark_error(failures[0])
            raise failures[0]
        self.mark_ok()
        readings = []
        for item in items:
            feeds = [results[url] for url in feed_urls(item)]
            entries = [entry for feed in feeds if not isinstance(feed, BaseException) for entry in feed]
            if not entries:
                readings.append(Reading(item.get("name", "Noticias"), "ERR RED" if feeds else "SIN NOTICIAS", error=True))
                continue
            # Newest first; entries without a date go after the dated ones, in feed order.
            oldest = datetime.min.replace(tzinfo=timezone.utc)
            entries.sort(key=lambda entry: entry.published or oldest, reverse=True)
            for entry in entries[: int(item.get("limit", 7))]:
                readings.append(Reading(entry.title, age(entry.published), link=entry.link))
        return readings

    async def close(self) -> None:
        await self.client.aclose()


def feed_urls(item: dict[str, Any]) -> list[str]:
    """`url:` for one feed, `feeds:` for several merged in one list."""
    return [str(url) for url in item.get("feeds", [])] or [str(item["url"])]


def parse_feed(content: bytes) -> list[Entry]:
    root = ET.fromstring(content)
    if root.tag == f"{ATOM}feed":
        return [atom_entry(entry) for entry in root.iter(f"{ATOM}entry")]
    return [rss_entry(entry) for entry in root.iter("item")]


def rss_entry(item: ET.Element) -> Entry:
    published = parse_date(item.findtext("pubDate") or item.findtext(DC_DATE))
    return Entry(clean(item.findtext("title")), safe_link(item.findtext("link")), published)


def atom_entry(entry: ET.Element) -> Entry:
    links = entry.findall(f"{ATOM}link")
    link = next((l.get("href") for l in links if l.get("rel", "alternate") == "alternate"), None)
    published = parse_date(entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated"))
    return Entry(clean(entry.findtext(f"{ATOM}title")), safe_link(link), published)


def clean(text: str | None) -> str:
    """Titles sometimes come with HTML tags or entities inside."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", text or ""))).strip() or "(sin título)"


def safe_link(link: str | None) -> str | None:
    """Only web links reach the page (never javascript: and the like)."""
    link = (link or "").strip()
    return link if link.startswith(("https://", "http://")) else None


def parse_date(text: str | None) -> datetime | None:
    if not text:
        return None
    text = text.strip()
    try:
        date = parsedate_to_datetime(text)  # RSS: "Fri, 23 Oct 2026 10:31:47 GMT"
    except (TypeError, ValueError):
        try:
            date = datetime.fromisoformat(text.replace("Z", "+00:00"))  # Atom: "2026-10-23T14:58:15Z"
        except ValueError:
            return None
    return date if date.tzinfo else date.replace(tzinfo=timezone.utc)


def age(published: datetime | None, now: datetime | None = None) -> str:
    """How long ago, short: "5 min", "3 h", "2 d"."""
    if published is None:
        return ""
    minutes = int(((now or datetime.now(timezone.utc)) - published).total_seconds() // 60)
    if minutes < 60:
        return f"{max(minutes, 0)} min"
    if minutes < 24 * 60:
        return f"{minutes // 60} h"
    return f"{minutes // (24 * 60)} d"

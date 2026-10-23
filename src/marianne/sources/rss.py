"""News feeds (RSS and Atom): the latest headlines of one or more feeds, newest first."""

from __future__ import annotations

import asyncio
import html
import re
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from difflib import SequenceMatcher
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from bs4 import BeautifulSoup

from .base import Reading, Source

USER_AGENT = "Mozilla/5.0 (marianne dashboard)"
ATOM = "{http://www.w3.org/2005/Atom}"
DC_DATE = "{http://purl.org/dc/elements/1.1/}date"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"
# What the reader on the page shows of each story, at most.
DETAIL_CHARS = 4000
# Two headlines this alike (0-1, once normalised) are the same story: a newsroom fixing a typo or
# a word republishes it, and only the newest version is kept.
SIMILAR = 0.85
# A last paragraph that only points to the web (the reader already has the link).
READ_MORE = re.compile(r"\s*(seguir leyendo|sigue leyendo|leer más|continue reading|read more)\W*$", re.IGNORECASE)


@dataclass
class Entry:
    title: str
    link: str | None
    published: datetime | None
    # The feed's name, and the story's text: a lede and the start of the article, as feeds give them.
    feed: str = ""
    summary: str = ""
    content: str = ""


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
            for entry in unique(entries, int(item.get("limit", 7)), float(item.get("similar", SIMILAR))):
                readings.append(Reading(entry.title, age(entry.published), link=entry.link, detail=detail(entry)))
        return readings

    async def close(self) -> None:
        await self.client.aclose()


def unique(entries: list[Entry], limit: int, similar: float = SIMILAR) -> list[Entry]:
    """The first `limit` entries (newest first) leaving out republished copies of one already kept:
    the same link, or a headline that is the same or almost (`similar`)."""
    kept: list[tuple[Entry, str]] = []
    for entry in entries:
        if len(kept) == limit:
            break
        title = normalise(entry.title)
        if not any(
            (entry.link and entry.link == other.link) or title == seen or alike(title, seen, similar)
            for other, seen in kept
        ):
            kept.append((entry, title))
    return [entry for entry, _ in kept]


def normalise(title: str) -> str:
    """Lower case, no accents, no punctuation: "¡Última hora!" and "Ultima hora" compare equal."""
    plain = unicodedata.normalize("NFKD", title.casefold())
    plain = "".join(char for char in plain if not unicodedata.combining(char))
    return " ".join(re.sub(r"[^\w\s]", " ", plain).split())


def alike(a: str, b: str, similar: float) -> bool:
    matcher = SequenceMatcher(None, a, b, autojunk=False)
    # The cheap upper bounds first: most pairs of headlines have little in common.
    return matcher.real_quick_ratio() >= similar and matcher.quick_ratio() >= similar and matcher.ratio() >= similar


def feed_urls(item: dict[str, Any]) -> list[str]:
    """`url:` for one feed, `feeds:` for several merged in one list."""
    return [str(url) for url in item.get("feeds", [])] or [str(item["url"])]


def parse_feed(content: bytes) -> list[Entry]:
    root = ET.fromstring(content)
    if root.tag == f"{ATOM}feed":
        feed = clean(root.findtext(f"{ATOM}title"), "")
        return [atom_entry(entry, feed) for entry in root.iter(f"{ATOM}entry")]
    feed = clean(root.findtext("channel/title"), "")
    return [rss_entry(entry, feed) for entry in root.iter("item")]


def rss_entry(item: ET.Element, feed: str = "") -> Entry:
    published = parse_date(item.findtext("pubDate") or item.findtext(DC_DATE))
    return Entry(clean(item.findtext("title")), safe_link(item.findtext("link")), published,
                 feed, html_text(item.findtext("description")), html_text(item.findtext(CONTENT)))


def atom_entry(entry: ET.Element, feed: str = "") -> Entry:
    links = entry.findall(f"{ATOM}link")
    link = next((l.get("href") for l in links if l.get("rel", "alternate") == "alternate"), None)
    published = parse_date(entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated"))
    return Entry(clean(entry.findtext(f"{ATOM}title")), safe_link(link), published,
                 feed, html_text(entry.findtext(f"{ATOM}summary")), html_text(entry.findtext(f"{ATOM}content")))


def detail(entry: Entry) -> dict[str, Any]:
    """What the page's reader shows when a headline is opened."""
    paragraphs = [entry.summary] if entry.summary else []
    # Some feeds repeat the lede at the start of the content.
    if entry.content and entry.content != entry.summary:
        paragraphs.append(entry.content.removeprefix(entry.summary).strip())
    text = READ_MORE.sub("", "\n\n".join(p for p in paragraphs if p)).strip()
    if len(text) > DETAIL_CHARS:
        text = text[:DETAIL_CHARS].rsplit(" ", 1)[0] + " …"
    when = f"{entry.published.astimezone():%d/%m %H:%M}" if entry.published else ""
    return {"feed": entry.feed, "date": when, "text": text}


def html_text(markup: str | None) -> str:
    """Plain text from a feed's HTML, one blank line between paragraphs."""
    if not markup or not markup.strip():
        return ""
    soup = BeautifulSoup(markup, "html.parser")
    for tag in soup(["script", "style", "img", "figure", "iframe"]):
        tag.decompose()
    for br in soup("br"):
        br.replace_with("\n")
    for block in soup(["p", "div", "li", "h1", "h2", "h3", "h4", "blockquote"]):
        block.insert_after("\n\n")
    lines = (re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in soup.get_text().split("\n"))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def clean(text: str | None, empty: str = "(sin título)") -> str:
    """Titles sometimes come with HTML tags or entities inside."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", text or ""))).strip() or empty


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

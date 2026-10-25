"""Met Office weather warnings (yellow, amber, red) for a UK region, from its RSS feed."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from .base import Reading, Source

FEED_URL = "https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/{region}"
USER_AGENT = "Mozilla/5.0 (marianne dashboard)"
# The feed's times are the UK's, whatever the time zone marianne runs in.
UK = ZoneInfo("Europe/London")
LEVELS = {"yellow": "amarillo", "amber": "ámbar", "red": "rojo"}
RANK = {"yellow": 1, "amber": 2, "red": 3}
KINDS = {
    "wind": "viento", "rain": "lluvia", "snow": "nieve", "ice": "hielo", "thunderstorm": "tormentas",
    "thunderstorms": "tormentas", "fog": "niebla", "lightning": "rayos", "extreme heat": "calor extremo",
}
WEEKDAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
MONTHS = {name: number for number, name in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}
TITLE = re.compile(r"^(yellow|amber|red) warning of (.+?) affecting", re.IGNORECASE)
# "valid from 2000 Sat 24 Oct to 2100 Sun 25 Oct"
VALID = re.compile(r"valid from (\d{4}) \w+ (\d{1,2}) (\w{3}) to (\d{4}) \w+ (\d{1,2}) (\w{3})", re.IGNORECASE)


@dataclass
class Warning:
    level: str  # yellow, amber, red
    kind: str  # in Spanish: viento, lluvia...
    starts: datetime | None
    ends: datetime | None
    text: str
    link: str | None


class MetOfficeSource(Source):
    kind = "metoffice"

    def __init__(self, name: str, region: str, area: str | None = None, timeout: float = 15,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(name)
        self.region = region
        # Only the warnings whose areas include this one (e.g. Glasgow, within Strathclyde).
        self.area = area
        self.client = httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                        headers={"User-Agent": USER_AGENT}, transport=transport)

    def describe(self) -> str:
        return f"avisos {self.region}"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        try:
            response = await self.client.get(FEED_URL.format(region=self.region))
            response.raise_for_status()
            warnings = parse_warnings(response.content)
        except Exception as exc:
            self.mark_error(exc)
            raise
        self.mark_ok()
        now = datetime.now().astimezone()
        warnings = current_warnings(warnings, self.area, now)
        readings = []
        for item in items:
            if not warnings:
                readings.append(Reading(item.get("none_text", "Sin avisos"), "", switch=False))
                continue
            for warning in warnings[: int(item.get("limit", 3))]:
                readings.append(warning_reading(item, warning, now))
        return readings

    async def close(self) -> None:
        await self.client.aclose()


def current_warnings(warnings: list[Warning], area: str | None, now: datetime) -> list[Warning]:
    """Those for the area that aren't over, the worst first and then the soonest."""
    if area:
        warnings = [warning for warning in warnings if area.lower() in warning.text.lower()]
    warnings = [warning for warning in warnings if warning.ends is None or warning.ends > now]
    return sorted(warnings, key=lambda warning: (-RANK.get(warning.level, 0), warning.starts or now))


def parse_warnings(content: bytes) -> list[Warning]:
    root = ET.fromstring(content)
    published = parse_date(root.findtext("channel/pubDate"))
    year = (published or datetime.now().astimezone()).year
    warnings = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        match = TITLE.match(title)
        if not match:
            continue
        level, kinds = match.group(1).lower(), match.group(2).lower()
        kind = ", ".join(KINDS.get(part.strip(), part.strip()) for part in re.split(r",| and ", kinds) if part.strip())
        text = (item.findtext("description") or "").strip()
        starts, ends = valid_times(text, year)
        warnings.append(Warning(level, kind, starts, ends, text, (item.findtext("link") or "").strip() or None))
    return warnings


def parse_date(text: str | None) -> datetime | None:
    try:
        return parsedate_to_datetime(text).astimezone() if text else None
    except (TypeError, ValueError):
        return None


def valid_times(text: str, year: int) -> tuple[datetime | None, datetime | None]:
    """When a warning starts and ends, in local time (the Met Office gives UK time)."""
    match = VALID.search(text)
    if not match:
        return None, None

    def when(hhmm: str, day: str, month: str) -> datetime | None:
        number = MONTHS.get(month.lower()[:3])
        if number is None:
            return None
        return datetime(year, number, int(day), int(hhmm[:2]), int(hhmm[2:]), tzinfo=UK).astimezone()

    starts, ends = when(*match.group(1, 2, 3)), when(*match.group(4, 5, 6))
    # A warning over New Year's Eve: it ends in the next year.
    if starts and ends and ends < starts:
        ends = ends.replace(year=ends.year + 1)
    return starts, ends


def warning_reading(item: dict[str, Any], warning: Warning, now: datetime) -> Reading:
    """"⚠ ÁMBAR · VIENTO …… hasta dom 21:00": amber and red also go to the alarm strip."""
    label = f"⚠ {LEVELS.get(warning.level, warning.level)} · {warning.kind}"
    if warning.starts and warning.starts > now:
        value = f"desde {WEEKDAYS[warning.starts.weekday()]} {warning.starts:%H:%M}"
    elif warning.ends:
        value = f"hasta {WEEKDAYS[warning.ends.weekday()]} {warning.ends:%H:%M}"
    else:
        value = "en vigor"
    serious = RANK.get(warning.level, 0) >= RANK.get(str(item.get("alarm_from", "amber")), 2)
    alarm = f"Aviso {LEVELS.get(warning.level)} por {warning.kind} · {value}" if serious else None
    detail = {"feed": "Met Office", "date": value, "text": warning.text}
    return Reading(label, value, alert=serious, alarm=alarm, link=warning.link, detail=detail)

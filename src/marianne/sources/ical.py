"""Events from calendars' iCal (ICS) links: Google Calendar, iCloud, Outlook... give a private one."""

from __future__ import annotations

import asyncio
import time
from datetime import date, datetime, timedelta
from typing import Any

import httpx
import icalendar
import recurring_ical_events

from .base import Reading, Source

USER_AGENT = "Mozilla/5.0 (marianne dashboard)"
# Calendars change seldom: their links are read again every quarter of an hour.
CACHE_SECONDS = 900.0
# Events sent to the page, for the calendar to mark them in any month it goes to.
MONTHS_BACK, MONTHS_AHEAD = 1, 12


class IcalSource(Source):
    kind = "ical"

    def __init__(self, name: str, calendars: list[dict[str, str]], timeout: float = 20,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(name)
        if not calendars:
            raise ValueError(f"source '{name}': falta 'calendars', la lista de calendarios (name y url)")
        missing = [calendar.get("name", "?") for calendar in calendars if not calendar.get("url")]
        if missing:
            raise ValueError(f"source '{name}': falta la url de {', '.join(missing)} (¿está en .env?)")
        self.calendars = calendars
        self.client = httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                        headers={"User-Agent": USER_AGENT}, transport=transport)
        self._events: list[dict[str, Any]] = []
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()

    def describe(self) -> str:
        # Never the links: they give access to the calendars.
        return f"{len(self.calendars)} calendarios"

    async def _calendar(self, calendar: dict[str, str]) -> bytes:
        url = calendar["url"].replace("webcal://", "https://", 1)
        response = await self.client.get(url)
        response.raise_for_status()
        return response.content

    async def _all_events(self) -> list[dict[str, Any]]:
        async with self._lock:
            if time.monotonic() - self._fetched_at < CACHE_SECONDS:
                return self._events
            answers = await asyncio.gather(*(self._calendar(c) for c in self.calendars), return_exceptions=True)
            failures = [answer for answer in answers if isinstance(answer, BaseException)]
            if failures and len(failures) == len(answers):
                raise failures[0]
            today = datetime.now().astimezone().date()
            start = (today.replace(day=1) - timedelta(days=31 * MONTHS_BACK)).replace(day=1)
            end = today + timedelta(days=31 * MONTHS_AHEAD)
            events = []
            for calendar, answer in zip(self.calendars, answers):
                if isinstance(answer, BaseException):
                    continue
                events += await asyncio.to_thread(parse_events, answer, calendar.get("name", ""), start, end)
            self._events = sorted(events, key=lambda event: event["start"])
            self._fetched_at = time.monotonic()
            return self._events

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        try:
            events = await self._all_events()
        except Exception as exc:
            self.mark_error(exc)
            raise
        self.mark_ok()
        # The page lists the events of today, or of tomorrow (its "mañana" key), from these.
        return [Reading(item.get("name", "Eventos"), "", agenda=events) for item in items]

    async def close(self) -> None:
        await self.client.aclose()


def parse_events(content: bytes, calendar: str, start: date, end: date) -> list[dict[str, Any]]:
    """Each event between start and end, repeating ones as each of their times, in local time."""
    parsed = icalendar.Calendar.from_ical(content)
    events = []
    for event in recurring_ical_events.of(parsed).between(start, end):
        begins, finishes = event.get("DTSTART"), event.get("DTEND")
        if begins is None:
            continue
        begins = begins.dt
        finishes = finishes.dt if finishes is not None else None
        all_day = not isinstance(begins, datetime)
        if all_day:
            # An all-day event ends on the day after its last.
            finishes = finishes or begins + timedelta(days=1)
            start_text, end_text = begins.isoformat(), finishes.isoformat()
        else:
            begins = begins.astimezone() if begins.tzinfo else begins.astimezone()
            finishes = (finishes.astimezone() if isinstance(finishes, datetime) else begins + timedelta(hours=1))
            start_text, end_text = f"{begins:%Y-%m-%dT%H:%M}", f"{finishes:%Y-%m-%dT%H:%M}"
        events.append({"name": str(event.get("SUMMARY", "")).strip() or "(sin título)", "start": start_text,
                       "end": end_text, "all_day": all_day, "calendar": calendar})
    return events

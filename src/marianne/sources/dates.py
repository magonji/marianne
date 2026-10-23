"""Countdown to special dates (2026-12-25, or 12-25 every year) and progress bars of
the day, week, month, year and a lifetime."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from .base import Reading, Source

PROGRESS = {"day", "week", "month", "year", "life"}
PROGRESS_LABELS = {"day": "Día", "week": "Semana", "month": "Mes", "year": "Año", "life": "Vida"}


class DatesSource(Source):
    kind = "dates"
    remote = False

    def __init__(self, name: str, sort: bool = True) -> None:
        super().__init__(name)
        self.sort = sort

    def describe(self) -> str:
        return "fechas señaladas"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        self.mark_ok()
        now = datetime.now()
        bars = [progress_reading(item, now) for item in items if "progress" in item]
        dates = [item for item in items if "progress" not in item]
        pairs = [(days_until(item, now.date()), date_reading(item, now.date())) for item in dates]
        if self.sort:
            # Coming dates first, nearest on top; past one-off dates at the end.
            pairs.sort(key=lambda pair: (pair[0] < 0, abs(pair[0])))
        # Progress bars stay on top, in the order they were written.
        return bars + [reading for _, reading in pairs]


def parse_date(value: Any) -> tuple[int | None, int, int]:
    """(year or None for every year, month, day) from a YAML date, 'YYYY-MM-DD' or 'MM-DD'."""
    if isinstance(value, date):
        return value.year, value.month, value.day
    parts = [int(part) for part in str(value).split("-")]
    if len(parts) == 2:
        return None, parts[0], parts[1]
    return parts[0], parts[1], parts[2]


def safe_date(year: int, month: int, day: int) -> date:
    # 29 February in a non-leap year is celebrated on the 28th.
    if month == 2 and day == 29:
        try:
            return date(year, 2, 29)
        except ValueError:
            return date(year, 2, 28)
    return date(year, month, day)


def next_occurrence(item: dict[str, Any], today: date) -> date:
    year, month, day = parse_date(item["date"])
    if year is not None and not item.get("yearly"):
        return date(year, month, day)
    target = safe_date(today.year, month, day)
    return target if target >= today else safe_date(today.year + 1, month, day)


def days_until(item: dict[str, Any], today: date) -> int:
    return (next_occurrence(item, today) - today).days


def date_reading(item: dict[str, Any], today: date) -> Reading:
    target = next_occurrence(item, today)
    days = (target - today).days
    label = item.get("name", f"{target:%d/%m/%Y}")
    year = parse_date(item["date"])[0]
    # For yearly dates with a year (a birthday), say which anniversary it is.
    years = f" · {target.year - year} años" if year is not None and item.get("yearly") else ""

    if days == 0:
        return Reading(label, f"¡HOY!{years}", switch=True, notice=f"★ Hoy: {label}{years}")
    if days < 0:
        return Reading(label, f"hace {-days} días", switch=False)
    soon = days <= int(item.get("soon", 7))
    text = "MAÑANA" if days == 1 else f"en {days} días · {target:%d/%m}"
    return Reading(label, text + years, switch=True if soon else None)



def as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    return datetime.fromisoformat(str(value))


def period(kind: str, item: dict[str, Any], now: datetime) -> tuple[datetime, datetime]:
    """Start and end of the period the bar measures."""
    today = datetime(now.year, now.month, now.day)
    if kind == "day":
        return today, today + timedelta(days=1)
    if kind == "week":
        monday = today - timedelta(days=today.weekday())
        return monday, monday + timedelta(days=7)
    if kind == "month":
        start = today.replace(day=1)
        return start, (start + timedelta(days=32)).replace(day=1)
    if kind == "year":
        return datetime(now.year, 1, 1), datetime(now.year + 1, 1, 1)
    return as_datetime(item["birth"]), as_datetime(item["end"])


def progress_reading(item: dict[str, Any], now: datetime) -> Reading:
    kind = item["progress"]
    label = item.get("name", PROGRESS_LABELS[kind])
    start, end = period(kind, item, now)
    fraction = min(1.0, max(0.0, (now - start) / (end - start)))
    decimals = int(item.get("decimals", 1 if kind == "life" else 0))
    note = ""
    if kind == "life" and item.get("days_left"):
        note = f"quedan {max(0, (end.date() - now.date()).days)} días"
    return Reading(label, f"{fraction * 100:.{decimals}f}", "%", fraction=fraction, note=note, wide_bar=True)


"""Countdown to special dates (2026-12-25, or 12-25 every year) and progress bars of
the day, week, month, year and a lifetime."""

from __future__ import annotations

import os
import re
import secrets
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml

from .base import Reading, Source

PROGRESS = {"day", "week", "month", "year", "life"}
PROGRESS_LABELS = {"day": "Día", "week": "Semana", "month": "Mes", "year": "Año", "life": "Vida"}
DATE_FORMAT = re.compile(r"^(\d{4}-)?\d{2}-\d{2}$")
MAX_DATES = 200


class DatesSource(Source):
    kind = "dates"
    remote = False

    def __init__(self, name: str, sort: bool = True, file: str | None = None, edit_key: str = "f") -> None:
        super().__init__(name)
        self.sort = sort
        # Dates kept in their own file, which the page can change (the config is read-only).
        self.store = DateStore(Path(file)) if file else None
        self.edit_key = edit_key

    def describe(self) -> str:
        return "fechas señaladas"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        self.mark_ok()
        now = datetime.now()
        bars = [progress_reading(item, now) for item in items if "progress" in item]
        dates = [item for item in items if "progress" not in item]
        if self.store:
            try:
                dates += self.store.load()
            except (OSError, ValueError, yaml.YAMLError) as exc:
                bars.append(Reading(self.store.path.name, "ERROR", error=True, note=str(exc)[:40]))
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



class DateStore:
    """A YAML list of dates ({id, name, date, yearly, soon}) that the page adds, changes and deletes."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        data = yaml.safe_load(self.path.read_text()) or []
        if not isinstance(data, list):
            raise ValueError("no es una lista de fechas")
        dates = []
        for raw in data:
            entry = clean_date(raw)
            dates.append({"id": str(raw.get("id") or secrets.token_hex(4)), **entry})
        return dates

    def save(self, dates: list[dict[str, Any]]) -> None:
        # To a temporary file first and then renamed, so a crash never leaves it half written.
        self.path.parent.mkdir(parents=True, exist_ok=True)
        text = yaml.safe_dump(dates, allow_unicode=True, sort_keys=False)
        handle, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".fechas-", suffix=".yaml")
        with os.fdopen(handle, "w") as file:
            file.write("# Fechas de la cuenta atrás, editadas desde la página (tecla F).\n" + text)
        os.replace(temporary, self.path)

    def add(self, raw: dict[str, Any]) -> list[dict[str, Any]]:
        dates = self.load()
        if len(dates) >= MAX_DATES:
            raise ValueError(f"como mucho {MAX_DATES} fechas")
        dates.append({"id": secrets.token_hex(4), **clean_date(raw)})
        self.save(dates)
        return dates

    def update(self, date_id: str, raw: dict[str, Any]) -> list[dict[str, Any]]:
        dates = self.load()
        index = self._index(dates, date_id)
        dates[index] = {"id": date_id, **clean_date(raw)}
        self.save(dates)
        return dates

    def delete(self, date_id: str) -> list[dict[str, Any]]:
        dates = self.load()
        del dates[self._index(dates, date_id)]
        self.save(dates)
        return dates

    @staticmethod
    def _index(dates: list[dict[str, Any]], date_id: str) -> int:
        for index, entry in enumerate(dates):
            if entry["id"] == date_id:
                return index
        raise KeyError(date_id)


def clean_date(raw: Any) -> dict[str, Any]:
    """A date as the page sends it, checked: a name, 'YYYY-MM-DD' or 'MM-DD', yearly and soon."""
    if not isinstance(raw, dict):
        raise ValueError("cada fecha tiene que ser un diccionario")
    name = str(raw.get("name") or "").strip()
    if not name or len(name) > 60:
        raise ValueError("el nombre tiene que tener entre 1 y 60 caracteres")
    value = raw.get("date")
    text = value.isoformat() if isinstance(value, date) else str(value or "").strip()
    if not DATE_FORMAT.match(text):
        raise ValueError("la fecha tiene que ser DD/MM o DD/MM/AAAA")
    year, month, day = parse_date(text)
    try:
        # 29 February is fine without a year (every year: the 28th when it isn't a leap year).
        date(year or 2000, month, day)
    except ValueError:
        raise ValueError("esa fecha no existe") from None
    try:
        soon = int(raw.get("soon", 7))
    except (TypeError, ValueError):
        raise ValueError("los días de aviso tienen que ser un número") from None
    if not 0 <= soon <= 365:
        raise ValueError("los días de aviso tienen que estar entre 0 y 365")
    entry: dict[str, Any] = {"name": name, "date": text}
    # Only a date with a year can be yearly (an anniversary); without a year it already is.
    if year is not None and raw.get("yearly"):
        entry["yearly"] = True
    entry["soon"] = soon
    return entry


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


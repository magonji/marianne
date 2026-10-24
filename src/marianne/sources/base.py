"""Common interface for every data source (Home Assistant, web scraping, ...)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any


@dataclass
class Reading:
    """A single value ready to be painted in a panel row."""

    label: str
    value: str
    unit: str = ""
    # True/False for on/off style values, None for everything else.
    switch: bool | None = None
    # 0.0 - 1.0 when the value should be drawn as a bar.
    fraction: float | None = None
    error: bool = False
    # The value crossed a threshold set in the config: painted in red, blinking.
    alert: bool = False
    # Message for the full-width alarm strip, once an alert has lasted too long.
    alarm: str | None = None
    # Extra text after the unit: a trend arrow, the time of a daily max/min...
    note: str = ""
    # Not drawn in the panel, but its alerts and alarms still count.
    hidden: bool = False
    # Good news for the green notice strip (e.g. a sunny day tomorrow).
    notice: str | None = None
    # Ring the terminal bell once (e.g. a pomodoro has just finished).
    ring: bool = False
    # More values drawn on the same row (e.g. a room's humidity next to its temperature).
    extra: list[Reading] = field(default_factory=list)
    # The bar stretches to fill the row (all the wide bars of a panel end up the same length).
    wide_bar: bool = False
    # A small drawing, one string per line, to the left of a big value (the weather now).
    art: list[str] | None = None
    # Its place in the Sun diagram (dawn, rising, noon...), instead of a row.
    sun: str | None = None
    # Its icon in a panel drawn as icons, as "mdi:dolphin" or "si:jellyfin".
    icon: str | None = None
    # Where a click on the label goes (a news headline opens the article).
    link: str | None = None
    # The day's weather as a chart: points, rain bars and the scales (see openweather.chart_reading).
    chart: dict[str, Any] | None = None
    # A newer version is waiting (a service whose container What's Up Docker can update).
    update: bool = False
    # More to show when the link is opened in the page (a story: its feed, date and text).
    detail: dict[str, Any] | None = None

    def parts(self) -> list[Reading]:
        return [self, *self.extra]


class Source(ABC):
    """A data provider. Panels ask it for readings of a list of item specs."""

    kind: str = "base"
    # Local sources (clock-based, no network) can't fail, so the status bar leaves them out.
    remote: bool = True

    def __init__(self, name: str) -> None:
        self.name = name
        self.ok: bool | None = None  # None = not contacted yet
        self.message = ""
        self.last_update: datetime | None = None

    @abstractmethod
    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        """Return the readings for the items, in order (usually one per item)."""

    def describe(self) -> str:
        return self.kind

    async def close(self) -> None:
        pass

    def mark_ok(self) -> None:
        self.ok = True
        self.message = ""
        self.last_update = datetime.now()

    def mark_error(self, exc: BaseException) -> None:
        self.ok = False
        self.message = str(exc) or exc.__class__.__name__


def parse_number(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def format_number(number: float, decimals: int | None) -> str:
    if decimals is not None:
        return f"{number:.{decimals}f}"
    return f"{number:g}"


def check_alert(item: dict[str, Any], number: float | None = None, switch: bool | None = None) -> bool:
    """`alert: true` fires while a switch is on; `alert_below`/`alert_above` are numeric thresholds."""
    if switch is not None:
        return switch and bool(item.get("alert"))
    if number is None:
        return False
    if "alert_below" in item and number < float(item["alert_below"]):
        return True
    return "alert_above" in item and number > float(item["alert_above"])


def make_fraction(number: float | None, item: dict[str, Any], unit: str) -> float | None:
    """Fraction for the bar, if the item wants one (explicit `bar` or a % unit)."""
    if number is None or not item.get("bar", unit == "%"):
        return None
    low = float(item.get("min", 0))
    high = float(item.get("max", 100))
    if high == low:
        return None
    return max(0.0, min(1.0, (number - low) / (high - low)))


# The `history` command's periods, and how the time of a max or min reads in each.
HISTORY_PERIODS = ("today", "7d", "30d", "year", "all")
WHEN_FORMAT = {"today": "%H:%M", "7d": "%d/%m %Hh", "30d": "%d/%m", "year": "%d/%m", "all": "%d/%m/%y"}


def period_start(period: str, now: datetime) -> datetime:
    """Where a history period starts: midnight, 7 or 30 days ago, 1 January, or ever."""
    if period == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "7d":
        return now - timedelta(days=7)
    if period == "30d":
        return now - timedelta(days=30)
    if period == "year":
        return now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    return datetime(2000, 1, 1, tzinfo=now.tzinfo)

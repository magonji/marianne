"""Fake source that invents plausible values, to try marianne without Home Assistant."""

from __future__ import annotations

import asyncio
import math
import random
from datetime import datetime, timedelta
from typing import Any

from .base import Reading, Source, check_alert, format_number, make_fraction

# (keyword in the item id, min, max, unit); the first match wins, so specific ones go first.
PROFILES = [
    ("temperatura_exterior", 4, 16, "°C"),
    ("presion", 995, 1035, "hPa"),
    ("objetivo", 18, 22, "°C"),
    ("temp", 17, 26, "°C"),
    ("hum", 35, 70, "%"),
    ("bat", 5, 100, "%"),
    ("power", 80, 3200, "W"),
    ("potencia", 80, 3200, "W"),
    ("energ", 2, 25, "kWh"),
    ("co2", 400, 1400, "ppm"),
    ("precio", 0.05, 0.30, "€/kWh"),
]
# A spring day for the Sun diagram, as (hour, minute).
SUN_TIMES = {"dawn": (6, 22), "rising": (6, 58), "noon": (13, 12), "setting": (19, 27), "dusk": (20, 3)}
SWITCH_DOMAINS = ("binary_sensor.", "switch.", "light.", "input_boolean.", "fan.")


class DemoSource(Source):
    kind = "demo"

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self._values: dict[str, float] = {}
        # Switches keep their state for a while instead of flickering, and remember since when.
        self._switches: dict[str, tuple[bool, datetime]] = {}

    def describe(self) -> str:
        return "datos simulados"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        await asyncio.sleep(random.uniform(0.1, 0.4))
        self.mark_ok()
        readings = []
        for item in items:
            reading = self._reading(item)
            reading.hidden = bool(item.get("hidden"))
            reading.sun = item.get("sun")
            for extra in item.get("also", []):
                extra_reading = self._reading(extra)
                extra_reading.fraction = None
                reading.extra.append(extra_reading)
            readings.append(reading)
        return readings

    def _reading(self, item: dict[str, Any]) -> Reading:
        key = str(item.get("entity") or item.get("name") or id(item))
        label = item.get("name") or key.split(".")[-1].replace("_", " ")

        if item.get("sun"):
            return sun_reading(item["sun"], label)

        if key.startswith(SWITCH_DOMAINS):
            now = datetime.now()
            is_on, since = self._switches.get(key, (random.random() < 0.4, now - timedelta(minutes=random.randint(1, 30))))
            if random.random() < 0.05:
                is_on, since = not is_on, now
            self._switches[key] = (is_on, since)
            is_on = is_on != bool(item.get("invert"))
            text = str(item.get("on_text", "ON") if is_on else item.get("off_text", "OFF"))
            alert = check_alert(item, switch=is_on)
            alarm = None
            minutes = (now - since).total_seconds() / 60
            if alert and "alarm_after" in item and minutes >= float(item["alarm_after"]):
                alarm = f"{item.get('alarm_text') or f'{label} {text}'} · desde hace {int(minutes)} min"
            return Reading(label, text, switch=is_on, alert=alert, alarm=alarm)

        low, high, unit = next(((lo, hi, u) for word, lo, hi, u in PROFILES if word in key.lower()), (0, 100, ""))
        unit = item.get("unit", unit)
        previous = self._values.get(key, random.uniform(low, high))
        number = max(low, min(high, previous + random.uniform(-0.05, 0.05) * (high - low)))
        self._values[key] = number
        decimals = item.get("decimals", 0 if high > 100 else 2 if high < 1 else 1)
        fraction = make_fraction(number, item, unit)
        value = format_number(number, decimals)
        return Reading(label, value, unit, fraction=fraction, alert=check_alert(item, number))


def sun_reading(role: str, label: str) -> Reading:
    if role in SUN_TIMES:
        return Reading(label, "{:02d}:{:02d}".format(*SUN_TIMES[role]))
    # Rough elevation and azimuth from the time of day: enough to look right.
    now = datetime.now()
    rise, noon, set_ = (h * 60 + m for h, m in (SUN_TIMES["rising"], SUN_TIMES["noon"], SUN_TIMES["setting"]))
    clock = now.hour * 60 + now.minute
    if role == "elevation":
        return Reading(label, f"{48 * math.sin(math.pi * (clock - rise) / (set_ - rise)):.1f}", "°")
    return Reading(label, f"{(180 + (clock - noon) / 4) % 360:.0f}", "°")

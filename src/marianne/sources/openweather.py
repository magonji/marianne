"""OpenWeather source: the current temperature and today's forecast, from the free APIs."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from .base import Reading, Source, check_alert, format_number, make_fraction

API_URL = "https://api.openweathermap.org/data/2.5/forecast"
CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather"
# The forecast only changes every few hours; the free plan allows 1000 calls a day.
CACHE_SECONDS = 600.0

# Single-width symbols per OpenWeather condition group (first digit of the id).
SYMBOLS = {2: "ϟ", 3: "☂", 5: "☂", 6: "❄", 7: "≡"}
# Which condition describes a day best: storms beat snow beat rain... beat clear sky.
SEVERITY = {2: 6, 6: 5, 5: 4, 3: 3, 7: 2, 8: 1}

FIELDS = {"now", "summary", "max", "min", "rain_probability", "rain", "next_rain", "wind", "hours", "good_day", "chart"}
LABELS = {
    "chart": "El tiempo",
    "now": "Ahora",
    "summary": "Hoy",
    "max": "Máxima",
    "min": "Mínima",
    "rain_probability": "Prob. lluvia",
    "rain": "Lluvia",
    "next_rain": "Próxima lluvia",
    "wind": "Viento",
    "hours": "Próximas horas",
    "good_day": "Mañana 9-18h",
}
# Short labels when max/min go next to another value (`also`), e.g. beside the big temperature.
EXTRA_LABELS = {"max": "▲", "min": "▼", "rain_probability": "☂"}
# Three-line drawings of the current weather, shown beside the big temperature.
CLOUD = [" .-(   ).  ", "(___.____) "]
ICONS = {
    "sun": ["  \\  |  /  ", "  ── ● ──  ", "  /  |  \\  "],
    "moon": ["   .--.    ", "  (  (     ", "   `--'    "],
    "partly_sun": [" \\ | /     ", " ─ ●.-(  ).", "  (___.___)"],
    "partly_moon": ["  .-.      ", " ( (.-(  ).", "  `(___.__)"],
    "cloud": ["    .--.   ", " .-(    ). ", "(___.____) "],
    "drizzle": [*CLOUD, "  ' ' ' '  "],
    "rain": [*CLOUD, "  ╱ ╱ ╱ ╱  "],
    "snow": [*CLOUD, "  * * * *  "],
    "storm": [*CLOUD, "  ╱ ϟ ╱ ϟ  "],
    "mist": [" ─ ─ ─ ─ ─ ", "─ ─ ─ ─ ─  ", " ─ ─ ─ ─ ─ "],
}
# Storms, drizzle and rain: what counts as "it will rain".
RAINY = {2, 3, 5}
WEEKDAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
# Clear sky or few clouds (up to 25 %) count as sunny.
SUNNY = {800, 801}
# Rain from this many mm an hour is heavy (the Met Office's "heavy rain"): its bar goes in red.
HEAVY_RAIN = 4.0
# Observed weather is kept for this long, enough for today and yesterday.
HISTORY_SECONDS = 2 * 86400


class OpenWeatherSource(Source):
    kind = "openweather"

    def __init__(
        self,
        name: str,
        api_key: str,
        city: str,
        lang: str = "es",
        timeout: float = 15,
        history_file: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(name)
        if not api_key:
            raise ValueError(f"source '{name}': falta la api_key de OpenWeather")
        self.city = city
        self.params = {"q": city, "appid": api_key, "units": "metric", "lang": lang}
        self.client = httpx.AsyncClient(timeout=timeout, transport=transport)
        self._forecast: dict[str, Any] = {}
        self._fetched_at = 0.0
        self._current: dict[str, Any] = {}
        self._current_at = 0.0
        self._lock = asyncio.Lock()
        # The weather observed through the day, for the hours already gone in the chart.
        self.history = WeatherHistory(Path(history_file) if history_file else None)

    def describe(self) -> str:
        return f"openweather {self.city}"

    async def _get(self, url: str) -> dict[str, Any]:
        response = await self.client.get(url, params=self.params)
        if response.status_code == 401:
            raise RuntimeError("OpenWeather: api_key no válida o aún no activada")
        response.raise_for_status()
        return response.json()

    async def _get_forecast(self) -> dict[str, Any]:
        async with self._lock:
            if time.monotonic() - self._fetched_at > CACHE_SECONDS:
                self._forecast = await self._get(API_URL)
                self._fetched_at = time.monotonic()
            return self._forecast

    async def _get_current(self) -> dict[str, Any]:
        async with self._lock:
            if time.monotonic() - self._current_at > CACHE_SECONDS:
                self._current = await self._get(CURRENT_URL)
                self._current_at = time.monotonic()
                self.history.add(self._current)
            return self._current

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        try:
            forecast = await self._get_forecast()
            # The current weather is a second call, only made if some item shows it.
            fields = {part["field"] for item in items for part in [item, *item.get("also", [])]}
            current = await self._get_current() if fields & {"now", "chart"} else {}
        except Exception as exc:
            self.mark_error(exc)
            raise
        self.mark_ok()
        now = datetime.now(timezone.utc)
        readings = []
        for item in items:
            reading = field_reading(item, forecast, now, current, self.history.samples)
            for extra in item.get("also", []):
                extra = {"name": EXTRA_LABELS.get(extra["field"], LABELS[extra["field"]]), **extra}
                extra_reading = field_reading(extra, forecast, now, current)
                extra_reading.fraction = None
                reading.extra.append(extra_reading)
            readings.append(reading)
        return readings

    async def close(self) -> None:
        await self.client.aclose()


def slots_for_today(forecast: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    """Forecast slots still to come today in the city's time; the next 24 h late at night."""
    offset = timezone(timedelta(seconds=forecast.get("city", {}).get("timezone", 0)))
    today = now.astimezone(offset).date()
    # A slot covers the 3 hours after its time, so the current one still counts.
    upcoming = [slot for slot in forecast.get("list", []) if slot["dt"] > now.timestamp() - 3 * 3600]
    todays = [slot for slot in upcoming if datetime.fromtimestamp(slot["dt"], offset).date() == today]
    return todays or upcoming[:8]


def condition_group(slot: dict[str, Any]) -> int:
    return slot["weather"][0]["id"] // 100


def severity(slot: dict[str, Any]) -> tuple[int, float, int]:
    """Condition type first; between two rains, the one with more water."""
    water = slot.get("rain", {}).get("3h", 0) + slot.get("snow", {}).get("3h", 0)
    return SEVERITY.get(condition_group(slot), 0), water, slot["weather"][0]["id"]


def symbol(slot: dict[str, Any]) -> str:
    condition = slot["weather"][0]["id"]
    if condition == 800:
        return "☀"
    return SYMBOLS.get(condition // 100, "☁")


def drawing(weather: dict[str, Any]) -> list[str]:
    """The drawing for an OpenWeather condition; the Moon instead of the Sun at night."""
    condition, night = weather["id"], str(weather.get("icon", "")).endswith("n")
    group = condition // 100
    if condition == 800:
        name = "moon" if night else "sun"
    elif condition in (801, 802):
        name = "partly_moon" if night else "partly_sun"
    else:
        name = {2: "storm", 3: "drizzle", 5: "rain", 6: "snow", 7: "mist"}.get(group, "cloud")
    return ICONS[name]


def field_reading(
    item: dict[str, Any],
    forecast: dict[str, Any],
    now: datetime,
    current: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
) -> Reading:
    field = item["field"]
    label = item.get("name", LABELS[field])
    if field == "chart":
        return chart_reading(item, label, forecast, now, current or {}, history or [])
    if field == "good_day":
        return good_day(item, label, forecast, now)
    if field == "next_rain":
        return next_rain(item, label, forecast, now)
    if field == "now":
        if not current or "main" not in current:
            return Reading(label, "N/D", error=True)
        number = current["main"]["temp"]
        reading = Reading(label, format_number(number, item.get("decimals", 1)), "°C", alert=check_alert(item, number))
        if current.get("weather"):
            reading.art = drawing(current["weather"][0])
        return reading
    slots = slots_for_today(forecast, now)
    if not slots:
        return Reading(label, "SIN DATOS", error=True)

    if field == "summary":
        worst = max(slots, key=severity)
        return Reading(label, f"{symbol(worst)} {worst['weather'][0]['description'].upper()}")

    if field == "hours":
        offset = timezone(timedelta(seconds=forecast.get("city", {}).get("timezone", 0)))
        count = int(item.get("count", 5))
        # Only slots that haven't started yet: the one under way is already "now".
        upcoming = [slot for slot in forecast["list"] if slot["dt"] > now.timestamp()][:count]
        parts = [
            f"{datetime.fromtimestamp(slot['dt'], offset):%H}h {symbol(slot)} {slot['main']['temp']:.0f}°"
            for slot in upcoming
        ]
        return Reading(label, "  ".join(parts))

    if field in ("max", "min"):
        key = "temp_max" if field == "max" else "temp_min"
        pick = max if field == "max" else min
        temperatures = [slot["main"][key] for slot in slots]
        if current and "main" in current:
            # So that the current temperature is never above today's max or below the min.
            temperatures.append(current["main"]["temp"])
        number, unit = pick(temperatures), "°C"
    elif field == "rain_probability":
        number, unit = max(slot.get("pop", 0) for slot in slots) * 100, "%"
    elif field == "rain":
        number = sum(slot.get("rain", {}).get("3h", 0) + slot.get("snow", {}).get("3h", 0) for slot in slots)
        unit = "mm"
    else:  # wind, in km/h
        number, unit = max(slot["wind"]["speed"] for slot in slots) * 3.6, "km/h"

    decimals = item.get("decimals", 1 if field in ("max", "min", "rain") else 0)
    return Reading(
        label,
        format_number(number, decimals),
        unit,
        fraction=make_fraction(number, item, unit),
        alert=check_alert(item, number),
    )


def next_rain(item: dict[str, Any], label: str, forecast: dict[str, Any], now: datetime) -> Reading:
    """When the forecast next says rain, with at least `min_probability` % chance."""
    offset = timezone(timedelta(seconds=forecast.get("city", {}).get("timezone", 0)))
    minimum = float(item.get("min_probability", 30)) / 100
    upcoming = [slot for slot in forecast.get("list", []) if slot["dt"] + 3 * 3600 > now.timestamp()]
    if not upcoming:
        return Reading(label, "SIN DATOS", error=True)
    for slot in upcoming:
        if condition_group(slot) in RAINY and slot.get("pop", 0) >= minimum:
            break
    else:
        # Not in the whole forecast (5 days).
        return Reading(label, "NO PREVISTA", switch=False)
    probability = f" · {slot.get('pop', 0) * 100:.0f} %"
    if slot["dt"] <= now.timestamp():
        # The slot under way.
        return Reading(label, f"{symbol(slot)} AHORA{probability}", switch=True)
    when = datetime.fromtimestamp(slot["dt"], offset)
    days = (when.date() - now.astimezone(offset).date()).days
    day = "hoy" if days == 0 else "mañana" if days == 1 else WEEKDAYS[when.weekday()]
    return Reading(label, f"{symbol(slot)} {day} {when:%H}h{probability}")


def good_day(item: dict[str, Any], label: str, forecast: dict[str, Any], now: datetime) -> Reading:
    """Will tomorrow be dry, calm and mostly sunny between `from` and `to` (city time)?"""
    offset = timezone(timedelta(seconds=forecast.get("city", {}).get("timezone", 0)))
    tomorrow = now.astimezone(offset).date() + timedelta(days=1)
    start_hour, end_hour = int(item.get("from", 9)), int(item.get("to", 18))
    start = datetime(tomorrow.year, tomorrow.month, tomorrow.day, start_hour, tzinfo=offset)
    end = datetime(tomorrow.year, tomorrow.month, tomorrow.day, end_hour, tzinfo=offset)
    # Each slot covers the 3 hours after its time: keep the ones that overlap the window.
    slots = [
        slot
        for slot in forecast.get("list", [])
        if slot["dt"] < end.timestamp() and slot["dt"] + 3 * 3600 > start.timestamp()
    ]
    if not slots:
        return Reading(label, "SIN DATOS", error=True)

    rain_probability = max(slot.get("pop", 0) for slot in slots) * 100
    rain = sum(slot.get("rain", {}).get("3h", 0) + slot.get("snow", {}).get("3h", 0) for slot in slots)
    wind = max(slot["wind"]["speed"] for slot in slots) * 3.6
    sunny = sum(slot["weather"][0]["id"] in SUNNY for slot in slots) / len(slots)
    high = max(slot["main"]["temp_max"] for slot in slots)

    if rain_probability > float(item.get("max_rain_probability", 20)) or rain >= float(item.get("max_rain", 0.5)):
        return Reading(label, f"LLUVIA {rain_probability:.0f} %", switch=False)
    if wind > float(item.get("max_wind", 20)):
        return Reading(label, f"VIENTO {wind:.0f} km/h", switch=False)
    if sunny < float(item.get("min_sunny", 0.5)):
        return Reading(label, "NUBLADO", switch=False)
    notice = (
        f"☀ Mañana buen día de {start_hour} a {end_hour} h: soleado, sin lluvia ni viento · máx {high:.0f} °C"
    )
    return Reading(label, item.get("on_text", "BUEN DÍA"), switch=True, notice=notice)


class WeatherHistory:
    """The weather observed through the day: one sample per current-weather call, kept two days,
    in a file if there is one, so that a restart doesn't lose the hours already gone."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.samples: list[dict[str, Any]] = self._load()

    def _load(self) -> list[dict[str, Any]]:
        if self.path is None or not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return []
        return [sample for sample in data if isinstance(sample, dict) and "t" in sample] if isinstance(data, list) else []

    def add(self, current: dict[str, Any]) -> None:
        sample = observed_sample(current)
        if sample is None or any(old["t"] == sample["t"] for old in self.samples):
            return
        cutoff = sample["t"] - HISTORY_SECONDS
        self.samples = sorted([old for old in self.samples if old["t"] >= cutoff] + [sample], key=lambda old: old["t"])
        if self.path is not None:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                handle, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".tiempo-", suffix=".json")
                with os.fdopen(handle, "w") as file:
                    json.dump(self.samples, file)
                os.replace(temporary, self.path)
            except OSError:
                pass  # The chart still has them in memory.


def observed_sample(current: dict[str, Any]) -> dict[str, Any] | None:
    """Temperature, wind (km/h), clouds (%) and rain (mm in the last hour) from the current weather."""
    if "main" not in current or "dt" not in current:
        return None
    return {
        "t": int(current["dt"]),
        "temp": current["main"]["temp"],
        "wind": current.get("wind", {}).get("speed", 0) * 3.6,
        "clouds": current.get("clouds", {}).get("all", 0),
        "rain": current.get("rain", {}).get("1h", 0) + current.get("snow", {}).get("1h", 0),
    }


def chart_reading(
    item: dict[str, Any],
    label: str,
    forecast: dict[str, Any],
    now: datetime,
    current: dict[str, Any],
    history: list[dict[str, Any]],
) -> Reading:
    """The day in a chart (today and tomorrow): what was observed up to now, the forecast after."""
    offset = timezone(timedelta(seconds=forecast.get("city", {}).get("timezone", 0)))
    today = now.astimezone(offset).date()
    days = [chart_day(day, forecast, history, now, offset) for day in (today, today + timedelta(days=1))]
    temperature = current.get("main", {}).get("temp")
    chart = {
        "key": str(item.get("day_key", "d")).lower(),
        "heavy_rain": float(item.get("heavy_rain", HEAVY_RAIN)),
        "now": now.timestamp(),
        "temp": temperature,
        "days": days,
    }
    if temperature is not None and days[0]["points"]:
        days[0]["max"] = max(days[0]["max"], temperature)
        days[0]["min"] = min(days[0]["min"], temperature)
    return Reading(label, "", chart=chart)


def chart_day(
    day: date, forecast: dict[str, Any], history: list[dict[str, Any]], now: datetime, offset: timezone
) -> dict[str, Any]:
    """The points (temperature, wind, clouds) and rain bars of one day, in the city's time.

    Hours already gone: the hourly means of what was observed. From now on: the forecast, in
    slots of 3 hours, with those just outside the day so the lines reach its edges.
    """
    start = datetime(day.year, day.month, day.day, tzinfo=offset).timestamp()
    end = start + 86400
    moment = now.timestamp()
    points: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []

    hours: dict[int, list[dict[str, Any]]] = {}
    for sample in history:
        if start <= sample["t"] < min(end, moment):
            hours.setdefault(int((sample["t"] - start) // 3600), []).append(sample)
    for hour, samples in sorted(hours.items()):
        mean = {key: sum(sample[key] for sample in samples) / len(samples) for key in ("t", "temp", "wind", "clouds", "rain")}
        # At the samples' mean time: the middle of a full hour, earlier for the one under way.
        points.append({"t": mean["t"], "temp": mean["temp"], "wind": mean["wind"],
                       "clouds": mean["clouds"], "observed": True})
        if mean["rain"] > 0:
            bars.append({"from": start + hour * 3600, "to": start + (hour + 1) * 3600,
                         "rain": mean["rain"], "pop": 1.0, "observed": True})
    # The last observation itself, so that the observed line meets the forecast at "now".
    latest = history[-1] if history else None
    if latest and start <= latest["t"] < end and moment - latest["t"] < 2 * 3600 and (
        not points or latest["t"] - points[-1]["t"] > 300
    ):
        points.append({"t": latest["t"], "temp": latest["temp"], "wind": latest["wind"],
                       "clouds": latest["clouds"], "observed": True})

    for slot in forecast.get("list", []):
        slot_end = slot["dt"] + 3 * 3600
        if slot_end <= max(moment, start - 3 * 3600) or slot["dt"] > end + 3 * 3600:
            continue
        if slot["dt"] > moment:
            points.append({"t": slot["dt"], "temp": slot["main"]["temp"], "wind": slot["wind"]["speed"] * 3.6,
                           "clouds": slot.get("clouds", {}).get("all", 0), "observed": False})
        rain = (slot.get("rain", {}).get("3h", 0) + slot.get("snow", {}).get("3h", 0)) / 3
        bar_start, bar_end = max(slot["dt"], moment, start), min(slot_end, end)
        if rain > 0 and bar_end > bar_start:
            bars.append({"from": bar_start, "to": bar_end, "rain": rain, "pop": slot.get("pop", 0), "observed": False})

    points.sort(key=lambda point: point["t"])
    # The day's max and min: midnight at its end is already the next day's.
    inside = [point for point in points if start <= point["t"] < end] or points
    pops = [bar["pop"] for bar in bars if not bar["observed"]]
    return {
        "date": day.isoformat(),
        "start": start,
        "end": end,
        "points": points,
        "bars": bars,
        "max": max((point["temp"] for point in inside), default=None),
        "min": min((point["temp"] for point in inside), default=None),
        "pop": max(pops, default=0) * 100,
    }

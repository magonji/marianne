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

from .base import Reading, Source, check_alert, format_number, last_days, make_fraction

API_URL = "https://api.openweathermap.org/data/2.5/forecast"
CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather"
# Hourly forecast for the chart (OpenWeather's free one comes in slots of 3 hours). Free, no key,
# from the national weather services' models; data CC BY 4.0, Open-Meteo.com.
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_FIELDS = "temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation,precipitation_probability,cloud_cover"
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
# Observed weather is kept sample by sample for today and the two days before; older days, only
# as a summary (their max, min and rain), for the `history` command's last 7 days.
HISTORY_DAYS = 2
SUMMARY_DAYS = 7


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
        hourly: str | None = None,
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
        self.observed = WeatherHistory(Path(history_file) if history_file else None)
        # "open-meteo": the chart's forecast hour by hour, at the city OpenWeather has found.
        if hourly not in (None, "open-meteo"):
            raise ValueError(f"source '{name}': 'hourly' solo puede ser open-meteo")
        self.hourly = hourly
        self._hours: list[dict[str, Any]] = []
        self._hours_at = 0.0

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
                self.observed.add(self._current)
            return self._current

    async def _get_hours(self, forecast: dict[str, Any]) -> list[dict[str, Any]]:
        """Open-Meteo's hours (yesterday to the day after tomorrow); none if it doesn't answer, and
        then the chart makes do with OpenWeather's 3-hour slots."""
        coord = forecast.get("city", {}).get("coord")
        if self.hourly != "open-meteo" or not coord:
            return []
        if time.monotonic() - self._hours_at > CACHE_SECONDS:
            params = {"latitude": coord["lat"], "longitude": coord["lon"], "hourly": OPEN_METEO_FIELDS,
                      "past_days": 1, "forecast_days": 3, "wind_speed_unit": "kmh", "timeformat": "unixtime"}
            try:
                response = await self.client.get(OPEN_METEO_URL, params=params)
                response.raise_for_status()
                self._hours = open_meteo_hours(response.json())
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                self._hours = []
            self._hours_at = time.monotonic()
        return self._hours

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        try:
            forecast = await self._get_forecast()
            # The current weather is a second call, only made if some item shows it.
            fields = {part["field"] for item in items for part in [item, *item.get("also", [])]}
            current = await self._get_current() if fields & {"now", "chart"} else {}
        except Exception as exc:
            self.mark_error(exc)
            raise
        hours = await self._get_hours(forecast) if "chart" in fields else []
        self.mark_ok()
        now = datetime.now(timezone.utc)
        readings = []
        for item in items:
            reading = field_reading(item, forecast, now, current, self.observed.samples, hours)
            for extra in item.get("also", []):
                extra = {"name": EXTRA_LABELS.get(extra["field"], LABELS[extra["field"]]), **extra}
                extra_reading = field_reading(extra, forecast, now, current)
                extra_reading.fraction = None
                reading.extra.append(extra_reading)
            readings.append(reading)
        return readings

    async def history(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return weather_week(self.observed, datetime.now().astimezone())

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
    hours: list[dict[str, Any]] | None = None,
) -> Reading:
    field = item["field"]
    label = item.get("name", LABELS[field])
    if field == "chart":
        return chart_reading(item, label, forecast, now, current or {}, history or [], hours or [])
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
    """The weather observed: one sample per current-weather call for the last days, and a summary
    of each older day, in a file if there is one, so that a restart doesn't lose them."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.samples: list[dict[str, Any]] = []
        self.days: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return
        # The first version of the file was just the list of samples.
        samples = data if isinstance(data, list) else data.get("samples", []) if isinstance(data, dict) else []
        self.samples = [sample for sample in samples if isinstance(sample, dict) and "t" in sample]
        if isinstance(data, dict) and isinstance(data.get("days"), dict):
            self.days = data["days"]

    def add(self, current: dict[str, Any]) -> None:
        sample = observed_sample(current)
        if sample is None or any(old["t"] == sample["t"] for old in self.samples):
            return
        samples = sorted([*self.samples, sample], key=lambda old: old["t"])
        # Days before the last few are kept only as their summary.
        keep_from = (local_day(sample["t"]) - timedelta(days=HISTORY_DAYS)).isoformat()
        old = [old for old in samples if local_day(old["t"]).isoformat() < keep_from]
        self.days.update(daily_summaries(old))
        summaries_from = (local_day(sample["t"]) - timedelta(days=SUMMARY_DAYS)).isoformat()
        self.days = {day: summary for day, summary in self.days.items() if day >= summaries_from}
        self.samples = [old for old in samples if local_day(old["t"]).isoformat() >= keep_from]
        if self.path is not None:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                handle, temporary = tempfile.mkstemp(dir=self.path.parent, prefix=".tiempo-", suffix=".json")
                with os.fdopen(handle, "w") as file:
                    json.dump({"samples": self.samples, "days": self.days}, file)
                os.replace(temporary, self.path)
            except OSError:
                pass  # The chart still has them in memory.

    def all_days(self) -> dict[str, dict[str, Any]]:
        """Every day observed: the summaries kept, and those of the days still sample by sample."""
        return {**self.days, **daily_summaries(self.samples)}


def local_day(t: float) -> date:
    return datetime.fromtimestamp(t).astimezone().date()


def daily_summaries(samples: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Each day's highest and lowest temperature and wind (with when) and its rain in mm, which is
    the sum of each hour's mean rate."""
    by_day: dict[str, list[dict[str, Any]]] = {}
    for sample in samples:
        by_day.setdefault(local_day(sample["t"]).isoformat(), []).append(sample)
    summaries = {}
    for day, group in by_day.items():
        hours: dict[int, list[float]] = {}
        for sample in group:
            hours.setdefault(int(sample["t"] // 3600), []).append(sample["rain"])
        summary: dict[str, Any] = {"rain": sum(sum(rates) / len(rates) for rates in hours.values())}
        for key in ("temp", "wind"):
            high = max(group, key=lambda sample: sample[key])
            low = min(group, key=lambda sample: sample[key])
            summary.update({f"{key}_max": high[key], f"{key}_max_t": high["t"], f"{key}_min": low[key], f"{key}_min_t": low["t"]})
        summaries[day] = summary
    return summaries


def observed_sample(current: dict[str, Any]) -> dict[str, Any] | None:
    """Temperature, wind and gusts (km/h, and the degrees it blows from), clouds (%) and rain (mm in
    the last hour) from the current weather."""
    if "main" not in current or "dt" not in current:
        return None
    sample = {
        "t": int(current["dt"]),
        "temp": current["main"]["temp"],
        "wind": current.get("wind", {}).get("speed", 0) * 3.6,
        "clouds": current.get("clouds", {}).get("all", 0),
        "rain": current.get("rain", {}).get("1h", 0) + current.get("snow", {}).get("1h", 0),
    }
    if current.get("wind", {}).get("deg") is not None:
        sample["deg"] = current["wind"]["deg"]
    # No gust in it: as strong as the wind itself.
    sample["gust"] = max(current.get("wind", {}).get("gust", 0) * 3.6, sample["wind"])
    return sample


def weather_week(history: WeatherHistory, now: datetime) -> list[dict[str, Any]]:
    """The history's "7 days", day by day: each day's highest and lowest temperature and wind, and
    its rain (None for a day Marianne didn't observe)."""
    summaries = history.all_days()
    days = [summaries.get(day.isoformat()) for day in last_days(now)]
    if not any(days):
        return [{"label": "Temperatura", "error": "SIN DATOS"}]
    rows = []
    for key, label, unit, decimals in (("temp", "Temperatura", "°C", 1), ("wind", "Viento", "km/h", 0)):
        cells = [None if day is None else {"max": format_number(day[f"{key}_max"], decimals),
                                            "min": format_number(day[f"{key}_min"], decimals)} for day in days]
        rows.append({"label": label, "parts": [{"unit": unit, "daily": cells}]})
    rain = [None if day is None else {"total": format_number(day["rain"], 1)} for day in days]
    rows.append({"label": "Lluvia", "parts": [{"unit": "mm", "daily": rain}]})
    return rows


def chart_reading(
    item: dict[str, Any],
    label: str,
    forecast: dict[str, Any],
    now: datetime,
    current: dict[str, Any],
    history: list[dict[str, Any]],
    hours: list[dict[str, Any]] | None = None,
) -> Reading:
    """The day in a chart (today and tomorrow): what was observed up to now, the forecast after."""
    offset = timezone(timedelta(seconds=forecast.get("city", {}).get("timezone", 0)))
    today = now.astimezone(offset).date()
    days = [chart_day(day, forecast, history, now, offset, hours) for day in (today, today + timedelta(days=1))]
    temperature = current.get("main", {}).get("temp")
    chart = {
        "key": str(item.get("day_key", "m")).lower(),
        "hourly": bool(hours),
        "heavy_rain": float(item.get("heavy_rain", HEAVY_RAIN)),
        "now": now.timestamp(),
        "temp": temperature,
        # What it's like now (temperature, wind, clouds, rain in the last hour), for the line under it.
        "current": observed_sample(current),
        "days": days,
    }
    if temperature is not None and days[0]["points"]:
        days[0]["max"] = max(days[0]["max"], temperature)
        days[0]["min"] = min(days[0]["min"], temperature)
    return Reading(label, "", chart=chart)


def open_meteo_hours(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Open-Meteo's hourly arrays as one dict per hour. Its precipitation is what falls in the
    hour *before* each time."""
    hourly = data["hourly"]
    hours = []
    for index, t in enumerate(hourly["time"]):
        # A field missing from the answer (the gusts, in some models) counts as unknown.
        values = {key: (hourly.get(key) or [None] * len(hourly["time"]))[index] for key in OPEN_METEO_FIELDS.split(",")}
        if values["temperature_2m"] is None:
            continue
        hours.append({
            "t": int(t),
            "temp": values["temperature_2m"],
            "wind": values["wind_speed_10m"] or 0,
            "gust": values["wind_gusts_10m"] if values["wind_gusts_10m"] is not None else values["wind_speed_10m"] or 0,
            "clouds": values["cloud_cover"] or 0,
            "rain": values["precipitation"] or 0,
            "pop": (values["precipitation_probability"] or 0) / 100,
        })
    return hours


def chart_day(
    day: date,
    forecast: dict[str, Any],
    history: list[dict[str, Any]],
    now: datetime,
    offset: timezone,
    hours: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The points (temperature, wind, clouds) and rain bars of one day, in the city's time.

    Hours already gone: the hourly means of what was observed, and where nothing was (marianne
    wasn't running), Open-Meteo's estimate. From now on: the forecast, hour by hour from
    Open-Meteo or else in OpenWeather's slots of 3 hours, with those just outside the day so the
    lines reach its edges.
    """
    start = datetime(day.year, day.month, day.day, tzinfo=offset).timestamp()
    end = start + 86400
    moment = now.timestamp()
    points: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []

    by_hour: dict[int, list[dict[str, Any]]] = {}
    for sample in history:
        if start <= sample["t"] < min(end, moment):
            by_hour.setdefault(int((sample["t"] - start) // 3600), []).append(sample)
    for hour, samples in sorted(by_hour.items()):
        mean = {key: sum(sample[key] for sample in samples) / len(samples) for key in ("t", "temp", "wind", "clouds", "rain")}
        # Samples kept before gusts were: as strong as the wind.
        mean["gust"] = sum(sample.get("gust", sample["wind"]) for sample in samples) / len(samples)
        # At the samples' mean time: the middle of a full hour, earlier for the one under way.
        points.append({"t": mean["t"], "temp": mean["temp"], "wind": mean["wind"], "gust": mean["gust"],
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
                       "gust": latest.get("gust", latest["wind"]), "clouds": latest["clouds"], "observed": True})

    if hours:
        observed_hours = set(by_hour)
        for hour in hours:
            t = hour["t"]
            if t < start - 3600 or t > end + 3600:
                continue
            point = {"t": t, "temp": hour["temp"], "wind": hour["wind"], "gust": hour.get("gust", hour["wind"]),
                     "clouds": hour["clouds"], "observed": False}
            if t <= moment:
                # Gone by: only to fill an hour nothing was observed in.
                if start <= t < end and int((t - start) // 3600) not in observed_hours:
                    points.append({**point, "estimated": True})
            else:
                points.append(point)
            # Its rain fell in the hour before t.
            rain_from, rain_to = max(t - 3600, start), min(t, end)
            if hour["rain"] <= 0 or rain_to <= rain_from:
                continue
            if rain_to <= moment:
                if int((rain_from - start) // 3600) not in observed_hours:
                    bars.append({"from": rain_from, "to": rain_to, "rain": hour["rain"], "pop": 1.0,
                                 "observed": False, "estimated": True})
            else:
                bars.append({"from": max(rain_from, moment), "to": rain_to, "rain": hour["rain"],
                             "pop": hour["pop"], "observed": False})

    for slot in forecast.get("list", []) if not hours else []:
        slot_end = slot["dt"] + 3 * 3600
        if slot_end <= max(moment, start - 3 * 3600) or slot["dt"] > end + 3 * 3600:
            continue
        if slot["dt"] > moment:
            wind = slot["wind"]["speed"] * 3.6
            points.append({"t": slot["dt"], "temp": slot["main"]["temp"], "wind": wind,
                           "gust": max(slot["wind"].get("gust", 0) * 3.6, wind),
                           "clouds": slot.get("clouds", {}).get("all", 0), "observed": False})
        rain = (slot.get("rain", {}).get("3h", 0) + slot.get("snow", {}).get("3h", 0)) / 3
        bar_start, bar_end = max(slot["dt"], moment, start), min(slot_end, end)
        if rain > 0 and bar_end > bar_start:
            bars.append({"from": bar_start, "to": bar_end, "rain": rain, "pop": slot.get("pop", 0), "observed": False})

    points.sort(key=lambda point: point["t"])
    # The day's max and min: midnight at its end is already the next day's.
    inside = [point for point in points if start <= point["t"] < end] or points
    pops = [bar["pop"] for bar in bars if not bar["observed"] and not bar.get("estimated")]
    return {
        "date": day.isoformat(),
        "start": start,
        "end": end,
        "points": points,
        "bars": bars,
        "max": max((point["temp"] for point in inside), default=None),
        "min": min((point["temp"] for point in inside), default=None),
        "pop": max(pops, default=0) * 100,
        # Litres per m² over the whole day: what fell in the hours gone and what is forecast for the rest.
        "rain": sum(bar["rain"] * (bar["to"] - bar["from"]) / 3600 for bar in bars),
    }

"""Home Assistant source, via the REST API (/api/states, /api/history) and, for records, the WebSocket API."""

from __future__ import annotations

import asyncio
import json
import ssl
import time
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import websockets

from .base import Reading, Source, check_alert, format_number, make_fraction, parse_number

UNAVAILABLE = {"unavailable", "unknown", "none", ""}
# Shortcuts for `format:`; any other value is used as a strftime pattern.
# `format: auto` shows just the time for today and adds the day otherwise.
TIME_FORMATS = {"time": "%H:%M", "datetime": "%d/%m %H:%M", "date": "%d/%m/%Y"}
# Panels refreshing at the same moment share a single /api/states request.
CACHE_SECONDS = 2.0
# History (for `trend` and `stats`) is heavier and changes slowly.
HISTORY_CACHE_SECONDS = 300.0
# Records only change when a new one is set: the current value is checked on every refresh anyway.
RECORDS_CACHE_SECONDS = 3600.0

Samples = list[tuple[datetime, float]]
Records = dict[str, tuple[datetime, float]]


class HomeAssistantSource(Source):
    kind = "homeassistant"

    def __init__(
        self,
        name: str,
        url: str,
        token: str,
        verify_ssl: bool = True,
        timeout: float = 10,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(name)
        if not token:
            raise ValueError(f"source '{name}': falta el token de Home Assistant (exporta HASS_TOKEN o ponlo en config.yaml)")
        self.url = url.rstrip("/")
        self.token = token
        self.verify_ssl = verify_ssl
        self.timeout = timeout
        self.client = httpx.AsyncClient(
            base_url=self.url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
            verify=verify_ssl,
            transport=transport,
        )
        self._states: dict[str, dict[str, Any]] = {}
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()
        self._history: dict[frozenset[str], tuple[float, dict[str, Samples]]] = {}
        # Today's raw states of the `on_today` items, by (entity, attribute).
        self._changes: dict[tuple[str, str | None], tuple[float, list[tuple[datetime, str]]]] = {}
        # All-time maximum and minimum of the `records` items, from the long-term statistics.
        self._records: tuple[float, dict[str, Records]] = (0.0, {})
        # When each numeric alert started, so `alarm_after` can wait for it to persist.
        self._alert_since: dict[tuple[str, str | None], datetime] = {}

    def describe(self) -> str:
        return self.url

    async def _all_states(self) -> dict[str, dict[str, Any]]:
        async with self._lock:
            if time.monotonic() - self._fetched_at > CACHE_SECONDS:
                response = await self.client.get("/api/states")
                response.raise_for_status()
                self._states = {state["entity_id"]: state for state in response.json()}
                self._fetched_at = time.monotonic()
            return self._states

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        try:
            states = await self._all_states()
        except Exception as exc:
            self.mark_error(exc)
            raise
        self.mark_ok()
        histories = await self._histories(items)
        records = await self._all_records(items)
        readings: list[Reading] = []
        for item in items:
            state = states.get(item["entity"])
            reading = await self._on_today(item, state) if item.get("on_today") else self._reading(item, state)
            reading.hidden = bool(item.get("hidden"))
            reading.sun = item.get("sun")
            readings.append(reading)
            if state and "stale_after" in item:
                mark_stale(item, reading, state, datetime.now().astimezone())
            for extra_item in item.get("also", []):
                extra = self._extra(extra_item, states.get(extra_item["entity"]), reading)
                if extra_item.get("replace"):
                    # Takes the place of the main value when it has something to say (eco mode...).
                    if extra.value and not extra.error:
                        reading.value, reading.unit = extra.value, extra.unit
                    continue
                reading.extra.append(extra)
            samples = histories.get(item["entity"])
            current = parse_number(state.get("state")) if state else None
            if current is not None:
                current *= item.get("scale", 1)
            if item.get("records") and item["entity"] in records:
                readings += record_rows(item, reading, records[item["entity"]], current)
            if samples is None or current is None or reading.error:
                continue
            if "trend" in item:
                reading.note = trend_note(item, current, samples, datetime.now().astimezone())
            if item.get("stats") == "beside":
                # Next to the value (beside the big digits): ▲ max and ▼ min, without the time.
                for row, arrow in zip(day_stats(item, reading, current, samples, datetime.now().astimezone()), "▲▼"):
                    reading.extra.append(Reading(arrow, row.value, row.unit))
            elif item.get("stats"):
                readings += day_stats(item, reading, current, samples, datetime.now().astimezone())
        return readings

    def _extra(self, item: dict[str, Any], state: dict[str, Any] | None, main: Reading) -> Reading:
        """A value that shares its row with `main`: no bar, and no repeated stale note."""
        extra = self._reading(item, state)
        if state and "stale_after" in item:
            mark_stale(item, extra, state, datetime.now().astimezone())
        extra.fraction = None
        if extra.note == main.note:
            extra.note = ""
        return extra

    async def _on_today(self, item: dict[str, Any], state: dict[str, Any] | None) -> Reading:
        """How long the item has been on since midnight (e.g. the boiler heating)."""
        if state is None:
            return Reading(item.get("name", item["entity"]), "NO EXISTE", error=True)
        label = item.get("name") or state.get("attributes", {}).get("friendly_name") or item["entity"]
        now = datetime.now().astimezone()
        key = (item["entity"], item.get("attribute"))
        cached = self._changes.get(key)
        if cached and time.monotonic() - cached[0] < HISTORY_CACHE_SECONDS and cached[1][0][0] >= midnight(now):
            changes = cached[1]
        else:
            params = {"filter_entity_id": item["entity"], "significant_changes_only": "0"}
            if "attribute" not in item:
                params["no_attributes"] = ""
            try:
                response = await self.client.get(f"/api/history/period/{quote(midnight(now).isoformat())}", params=params)
                response.raise_for_status()
            except httpx.HTTPError:
                return Reading(label, "N/D", error=True)
            series = next(iter(response.json()), [])
            changes = [
                (when, raw_state(item, sample))
                for sample in series
                if (when := parse_timestamp(sample.get("last_updated") or sample.get("last_changed", ""))) is not None
            ]
            if not changes:
                return Reading(label, "N/D", error=True)
            self._changes[key] = (time.monotonic(), changes)
        # The history is cached for a while: the current state brings it up to date.
        latest = parse_timestamp(state.get("last_updated", ""))
        if latest is not None and latest > changes[-1][0]:
            changes = [*changes, (latest, raw_state(item, state))]
        return Reading(label, format_duration(on_minutes(item, changes, now)))

    async def _all_records(self, items: list[dict[str, Any]]) -> dict[str, Records]:
        """All-time max and min of the `records` items, from Home Assistant's long-term statistics."""
        entities = sorted({item["entity"] for item in items if item.get("records")})
        cached_at, cached = self._records
        if not entities or (time.monotonic() - cached_at < RECORDS_CACHE_SECONDS and set(entities) <= cached.keys()):
            return cached
        # The statistics are only on the WebSocket API.
        url = "ws" + self.url[len("http"):] + "/api/websocket"
        try:
            async with websockets.connect(url, open_timeout=self.timeout, ssl=None if url.startswith("ws:") else True if self.verify_ssl else _no_verify()) as ws:
                await ws.recv()  # auth_required
                await ws.send(json.dumps({"type": "auth", "access_token": self.token}))
                if json.loads(await ws.recv()).get("type") != "auth_ok":
                    return cached
                await ws.send(json.dumps({
                    "id": 1,
                    "type": "recorder/statistics_during_period",
                    "start_time": "2000-01-01T00:00:00Z",
                    "statistic_ids": entities,
                    "period": "day",
                    "types": ["max", "min"],
                }))
                answer = json.loads(await asyncio.wait_for(ws.recv(), self.timeout))
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException, ValueError):
            # Without records the panel still shows everything else.
            return cached
        records = {entity: parse_records(rows) for entity, rows in (answer.get("result") or {}).items() if rows}
        self._records = (time.monotonic(), {**cached, **records})
        return self._records[1]

    async def _histories(self, items: list[dict[str, Any]]) -> dict[str, Samples]:
        """Numeric history of the items that use `trend` or `stats`, since midnight or longer."""
        wanted = [item for item in items if "trend" in item or item.get("stats")]
        if not wanted:
            return {}
        entities = frozenset(item["entity"] for item in wanted)
        cached = self._history.get(entities)
        if cached and time.monotonic() - cached[0] < HISTORY_CACHE_SECONDS:
            return cached[1]

        now = datetime.now().astimezone()
        hours = max(float(item.get("trend", 0)) for item in wanted)
        start = min(midnight(now), now - timedelta(hours=hours))
        try:
            response = await self.client.get(
                f"/api/history/period/{quote(start.isoformat())}",
                params={"filter_entity_id": ",".join(sorted(entities)), "minimal_response": "", "no_attributes": ""},
            )
            response.raise_for_status()
        except httpx.HTTPError:
            # Without history the panel still shows the current values.
            return {}
        scales = {item["entity"]: item.get("scale", 1) for item in wanted}
        histories = {}
        for series in response.json():
            if not series:
                continue
            entity = series[0]["entity_id"]
            histories[entity] = [
                (when, number * scales.get(entity, 1))
                for sample in series
                if (when := parse_timestamp(sample.get("last_changed", ""))) is not None
                and (number := parse_number(sample.get("state"))) is not None
            ]
        self._history[entities] = (time.monotonic(), histories)
        return histories

    def _reading(self, item: dict[str, Any], state: dict[str, Any] | None) -> Reading:
        entity = item["entity"]
        if state is None:
            return Reading(item.get("name", entity), "NO EXISTE", error=True)

        attributes = state.get("attributes", {})
        label = item.get("name") or attributes.get("friendly_name") or entity

        if "attribute" in item:
            raw = attributes.get(item["attribute"])
            unit = item.get("unit", "")
        else:
            raw = state.get("state")
            unit = item.get("unit", attributes.get("unit_of_measurement", ""))
        raw = "" if raw is None else str(raw)
        changed = parse_timestamp(state.get("last_changed", ""))
        # `alert_states` lists raw text states that should raise an alert (e.g. a finished washer).
        text_alert = raw in item.get("alert_states", ())

        # `on_states` turns a text state into an on/off indicator (e.g. a thermostat "heating").
        if "on_states" in item:
            is_on = raw in item["on_states"]
            return Reading(label, str(item.get("map", {}).get(raw, raw)), switch=is_on)

        # Translations go first: some devices use "none" as a normal state.
        if raw in item.get("map", {}):
            value = str(item["map"][raw])
            return Reading(label, value, alert=text_alert, alarm=alarm_message(item, label, value, changed, text_alert))

        if raw.lower() in UNAVAILABLE:
            return Reading(label, "N/D", error=True)

        if raw in ("on", "off"):
            # `invert` is for sensors wired the other way round (e.g. "on" means closed).
            is_on = (raw == "on") != bool(item.get("invert"))
            text = str(item.get("on_text", "ON") if is_on else item.get("off_text", "OFF"))
            alert = check_alert(item, switch=is_on)
            alarm = alarm_message(item, label, text, changed, alert)
            if item.get("since") and changed:
                text += " " + format_since(state["last_changed"])
            return Reading(label, text, switch=is_on, alert=alert, alarm=alarm)

        if "format" in item:
            return Reading(label, format_timestamp(raw, item["format"]), unit)

        number = parse_number(raw)
        if number is not None:
            number *= item.get("scale", 1)
            value = format_number(number, item.get("decimals"))
            alert = check_alert(item, number)
        else:
            value = raw
            alert = text_alert
        fraction = make_fraction(number, item, unit)
        if number is None:
            alarm = alarm_message(item, label, value, changed, alert)
        else:
            alarm = self._numeric_alarm(item, label, f"{value} {unit}".strip(), alert)
        return Reading(label, value, unit, fraction=fraction, alert=alert, alarm=alarm)

    def _numeric_alarm(self, item: dict[str, Any], label: str, value: str, alert: bool) -> str | None:
        """Numbers change constantly, so the alert's start is tracked here rather than taken from HA."""
        if "alarm_after" not in item:
            return None
        key = (item["entity"], item.get("attribute"))
        if not alert:
            self._alert_since.pop(key, None)
            return None
        since = self._alert_since.setdefault(key, datetime.now().astimezone())
        return alarm_message(item, label, value, since, alert)

    async def close(self) -> None:
        await self.client.aclose()


def mark_stale(item: dict[str, Any], reading: Reading, state: dict[str, Any], now: datetime) -> None:
    """Flag a value the device hasn't reported for more than `stale_after` minutes."""
    reported = parse_timestamp(state.get("last_reported") or state.get("last_updated") or "")
    if reported is None:
        return
    minutes = (now - reported).total_seconds() / 60
    if minutes > float(item["stale_after"]):
        reading.error = True
        reading.note = f"hace {format_duration(minutes)}"


def midnight(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def trend_note(item: dict[str, Any], current: float, samples: Samples, now: datetime) -> str:
    """Arrow and change against `trend` hours ago; within `trend_steady` counts as steady."""
    cutoff = now - timedelta(hours=float(item["trend"]))
    before = [value for when, value in samples if when <= cutoff]
    if before:
        reference = before[-1]
    elif samples:
        reference = samples[0][1]
    else:
        return ""
    delta = current - reference
    decimals = item.get("decimals", 1)
    if abs(delta) <= float(item.get("trend_steady", 0)):
        return f"► {delta:+.{decimals}f}"
    return f"{'▲' if delta > 0 else '▼'} {delta:+.{decimals}f}"


def day_stats(item: dict[str, Any], reading: Reading, current: float, samples: Samples, now: datetime) -> list[Reading]:
    """Two extra rows with today's maximum and minimum and the time each happened."""
    start = midnight(now)
    # The last value before midnight was still the value at midnight.
    before = [(start, value) for when, value in samples if when < start][-1:]
    today = before + [(when, value) for when, value in samples if when >= start] + [(now, current)]
    high = max(today, key=lambda sample: sample[1])
    low = min(today, key=lambda sample: sample[1])
    decimals = item.get("decimals")
    return [
        Reading(item.get("max_name", "Máxima hoy"), format_number(high[1], decimals), reading.unit, note=f"{high[0]:%H:%M}"),
        Reading(item.get("min_name", "Mínima hoy"), format_number(low[1], decimals), reading.unit, note=f"{low[0]:%H:%M}"),
    ]


def parse_records(rows: list[dict[str, Any]]) -> Records:
    """{'max': (day, value), 'min': (day, value)} from daily statistics rows."""
    def day(row: dict[str, Any]) -> datetime:
        start = row["start"]
        if isinstance(start, (int, float)):
            return datetime.fromtimestamp(start / 1000).astimezone()
        return datetime.fromisoformat(start).astimezone()

    high = max((row for row in rows if row.get("max") is not None), key=lambda row: row["max"])
    low = min((row for row in rows if row.get("min") is not None), key=lambda row: row["min"])
    return {"max": (day(high), high["max"]), "min": (day(low), low["min"])}


def record_rows(item: dict[str, Any], reading: Reading, records: Records, current: float | None) -> list[Reading]:
    """Two rows with the all-time maximum and minimum and the day each happened."""
    decimals = item.get("decimals")
    now = datetime.now().astimezone()
    rows = []
    for kind, name, beats in (("max", "Récord máxima", float.__gt__), ("min", "Récord mínima", float.__lt__)):
        when, value = records[kind]
        # The statistics are compiled every hour: a record being set right now isn't in them yet.
        if current is not None and not reading.error and beats(float(current), float(value)):
            when, value = now, current
        rows.append(Reading(item.get(f"record_{kind}_name", name), format_number(value, decimals), reading.unit, note=f"{when:%d/%m/%y}"))
    return rows


def format_timestamp(raw: str, fmt: str) -> str:
    """ISO timestamp from Home Assistant (usually UTC) -> local time with the given format."""
    if fmt == "auto":
        return format_since(raw)
    try:
        when = datetime.fromisoformat(raw).astimezone()
    except ValueError:
        return raw
    return when.strftime(TIME_FORMATS.get(fmt, fmt))


def alarm_message(
    item: dict[str, Any], label: str, value: str, changed: datetime | None, alert: bool
) -> str | None:
    """Text for the alarm strip once an alert has lasted `alarm_after` minutes."""
    if not alert or changed is None or "alarm_after" not in item:
        return None
    minutes = (datetime.now().astimezone() - changed).total_seconds() / 60
    if minutes < float(item["alarm_after"]):
        return None
    return f"{item.get('alarm_text') or f'{label} {value}'} · desde hace {format_duration(minutes)}"


def parse_timestamp(raw: str) -> datetime | None:
    try:
        return datetime.fromisoformat(raw).astimezone()
    except ValueError:
        return None


def raw_state(item: dict[str, Any], state: dict[str, Any]) -> str:
    if "attribute" in item:
        return str(state.get("attributes", {}).get(item["attribute"]))
    return str(state.get("state"))


def is_on(item: dict[str, Any], raw: str) -> bool:
    on = raw in item["on_states"] if "on_states" in item else raw == "on"
    return on != bool(item.get("invert"))


def on_minutes(item: dict[str, Any], changes: list[tuple[datetime, str]], now: datetime) -> float:
    """Minutes spent on since midnight, from the states in order of time."""
    start = midnight(now)
    total = 0.0
    for (when, raw), (until, _) in zip(changes, [*changes[1:], (now, "")]):
        if is_on(item, raw):
            total += max(0.0, (min(until, now) - max(when, start)).total_seconds())
    return total / 60


def format_duration(minutes: float) -> str:
    hours, mins = divmod(int(minutes), 60)
    days, hours = divmod(hours, 24)
    if days:
        return f"{days} d {hours} h"
    return f"{hours} h {mins:02d} min" if hours else f"{mins} min"


def format_since(raw: str) -> str:
    """Time of a change: just HH:MM if it happened today, with the day otherwise."""
    try:
        when = datetime.fromisoformat(raw).astimezone()
    except ValueError:
        return raw
    return when.strftime("%H:%M" if when.date() == datetime.now().date() else "%d/%m %H:%M")


def _no_verify() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context

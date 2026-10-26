"""Home Assistant source, via the REST API (/api/states, /api/history) and, for records, the WebSocket API."""

from __future__ import annotations

import asyncio
import json
import re
import ssl
import time
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import websockets

from .base import Reading, Source, check_alert, format_number, last_days, make_fraction, parse_number

UNAVAILABLE = {"unavailable", "unknown", "none", ""}
# A digit of a value that can't be trusted (a sensor that's down): 6.0 → -.-, 996 → ---.
OFFLINE_DIGIT = "-"
# Shortcuts for `format:`; any other value is used as a strftime pattern.
# `format: auto` shows just the time for today and adds the day otherwise.
TIME_FORMATS = {"time": "%H:%M", "datetime": "%d/%m %H:%M", "date": "%d/%m/%Y"}
# Panels refreshing at the same moment share a single /api/states request.
CACHE_SECONDS = 2.0
# History (for `trend` and `stats`) is heavier and changes slowly.
HISTORY_CACHE_SECONDS = 300.0
# Records only change when a new one is set: the current value is checked on every refresh anyway.
RECORDS_CACHE_SECONDS = 3600.0
# How far back the history is read to find when a device last really changed a value.
SEEN_DAYS = 7

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
        # When each device last really changed a value (see _last_seen), by device, for a few minutes.
        self._seen: tuple[float, dict[str, datetime]] = (0.0, {})
        # The `history` command's rows, by items, for a few minutes.
        self._history_rows: dict[str, tuple[float, list[dict[str, Any]]]] = {}

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
        seen = await self._last_seen(items, states)
        readings: list[Reading] = []
        for item in items:
            if item.get("energy"):
                readings.append(await self._energy(item, states))
                continue
            state = states.get(item["entity"])
            reading = await self._on_today(item, state) if item.get("on_today") else self._reading(item, state)
            reading.hidden = bool(item.get("hidden"))
            reading.sun = item.get("sun")
            readings.append(reading)
            if state and "stale_after" in item:
                mark_stale(item, reading, state, datetime.now().astimezone(), seen.get(device(item["entity"])))
            for extra_item in item.get("also", []):
                extra = self._extra(extra_item, states.get(extra_item["entity"]), reading, seen)
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
            if samples is None or current is None or reading.error or reading.offline:
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

    def _extra(self, item: dict[str, Any], state: dict[str, Any] | None, main: Reading,
               seen: dict[str, datetime] | None = None) -> Reading:
        """A value that shares its row with `main`: no bar, and no repeated stale note."""
        extra = self._reading(item, state)
        if state and "stale_after" in item:
            mark_stale(item, extra, state, datetime.now().astimezone(), (seen or {}).get(device(item["entity"])))
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
        changes = await self._changes_today(item, state, now)
        if not changes:
            return Reading(label, "N/D", error=True)
        return Reading(label, format_duration(on_minutes(item, changes, now)))

    async def _changes_today(self, item: dict[str, Any], state: dict[str, Any], now: datetime) -> list[tuple[datetime, str]]:
        """The item's raw states (its attribute's, with `attribute`) since midnight, in order of time."""
        key = (item["entity"], item.get("attribute"))
        cached = self._changes.get(key)
        if cached and time.monotonic() - cached[0] < HISTORY_CACHE_SECONDS and cached[1][0][0] >= midnight(now):
            changes = cached[1]
        else:
            params = {"filter_entity_id": item["entity"], "significant_changes_only": "0", "end_time": now.isoformat()}
            if "attribute" not in item:
                params["no_attributes"] = ""
            try:
                response = await self.client.get(f"/api/history/period/{quote(midnight(now).isoformat())}", params=params)
                response.raise_for_status()
            except httpx.HTTPError:
                return []
            series = next(iter(response.json()), [])
            changes = [
                (when, raw_state(item, sample))
                for sample in series
                if (when := parse_timestamp(sample.get("last_updated") or sample.get("last_changed", ""))) is not None
            ]
            if not changes:
                return []
            self._changes[key] = (time.monotonic(), changes)
        # The history is cached for a while: the current state brings it up to date.
        latest = parse_timestamp(state.get("last_updated", ""))
        if latest is not None and latest > changes[-1][0]:
            changes = [*changes, (latest, raw_state(item, state))]
        return changes

    async def _energy(self, item: dict[str, Any], states: dict[str, dict[str, Any]]) -> Reading:
        """The energy widget: the power now, its curve today (5-minute means), the heating's spells
        today, the totals, and the thermostat (off, eco, target) with the room's temperature."""
        now = datetime.now().astimezone()
        start = midnight(now)
        power_state = states.get(item["power"]) or {}
        climate = states.get(item.get("climate", "")) or {}
        attributes = climate.get("attributes", {})
        power = parse_number(power_state.get("state"))
        limit = float(item.get("valid_max", float("inf")))

        key = ("energy", item["power"])
        cached = self._changes.get(key)
        if cached and time.monotonic() - cached[0] < HISTORY_CACHE_SECONDS and cached[1] and cached[1][0][0] >= start.timestamp():
            series = cached[1]
        else:
            answers = await self._statistics([{"start_time": start.isoformat(), "statistic_ids": [item["power"]],
                                               "period": "5minute", "types": ["mean"]}])
            rows = (answers or [{}])[0].get(item["power"], [])
            series = [[row_time(row).timestamp(), round(row["mean"])] for row in rows
                      if row.get("mean") is not None and row["mean"] <= limit]
            self._changes[key] = (time.monotonic(), series)
        if power is not None and power <= limit:
            series = [*series, [now.timestamp(), round(power)]]

        heating: list[list[float]] = []
        heat_minutes = 0.0
        if climate:
            heat_item = {"entity": item["climate"], "attribute": "hvac_action", "on_states": ["heating"]}
            changes = await self._changes_today(heat_item, climate, now)
            for (when, raw), (until, _) in zip(changes, [*changes[1:], (now, "")]):
                if raw == "heating":
                    begins, ends = max(when, start), min(until, now)
                    if ends > begins:
                        heating.append([begins.timestamp(), ends.timestamp()])
            heat_minutes = on_minutes(heat_item, changes, now)

        room = states.get(item.get("room", "")) or {}
        room_temp = parse_number(room.get("state"))
        energy = parse_number((states.get(item.get("energy_today", "")) or {}).get("state"))
        widget = {
            "start": start.timestamp(),
            "end": (start + timedelta(days=1)).timestamp(),
            "now": now.timestamp(),
            "series": series,
            "heating": heating,
            "kwh": energy,
            "heat_minutes": heat_minutes,
            "heat_text": format_duration(heat_minutes),
            "flame": attributes.get("hvac_action") == "heating",
            "off": climate.get("state") == "off",
            "eco": attributes.get("preset_mode") == "eco",
            "target": attributes.get("temperature"),
            "room": item.get("room_name", "Vestíbulo"),
            "room_temp": room_temp,
        }
        value = "--" if power is None else f"{power:.0f}"
        return Reading(item.get("name", "Luz"), value, "W", offline=power is None, energy=widget)

    async def _last_seen(self, items: list[dict[str, Any]], states: dict[str, dict[str, Any]]) -> dict[str, datetime]:
        """When each device of the `stale_after` items last really changed one of its values.

        Home Assistant and Zigbee2MQTT send a device's last values again when they restart, so its
        last report says nothing about whether it's still there: a device whose values haven't
        changed is the one that's gone. Its values are those whose ids share the device's (the
        Zigbee2MQTT name, sensor.0x…_temperature, _humidity, _pressure...)."""
        wanted = {device(part["entity"]) for item in items for part in [item, *item.get("also", [])]
                  if "stale_after" in part and "entity" in part}
        if not wanted:
            return {}
        cached_at, cached = self._seen
        if time.monotonic() - cached_at < HISTORY_CACHE_SECONDS and wanted <= cached.keys():
            return cached
        entities = sorted(entity for entity in states if device(entity) in wanted)
        now = datetime.now().astimezone()
        start = now - timedelta(days=SEEN_DAYS)
        try:
            # Without end_time, Home Assistant gives only one day from the start.
            response = await self.client.get(
                f"/api/history/period/{quote(start.isoformat())}",
                params={"filter_entity_id": ",".join(entities), "end_time": now.isoformat(), "minimal_response": "",
                        "no_attributes": "", "significant_changes_only": "0"},
            )
            response.raise_for_status()
        except httpx.HTTPError:
            return cached  # Without history, the last report is all there is.
        # A device with no change at all in those days: before the start (mark_stale says "más de").
        found: dict[str, datetime] = {name: datetime.min.replace(tzinfo=now.tzinfo) for name in wanted}
        for series in response.json():
            if not series:
                continue
            changed = last_change(series)
            name = device(series[0]["entity_id"])
            if changed is not None and changed > found[name]:
                found[name] = changed
        self._seen = (time.monotonic(), {**cached, **found})
        return self._seen[1]

    async def _statistics(self, queries: list[dict[str, Any]]) -> list[dict[str, list[dict[str, Any]]]] | None:
        """Answers to `recorder/statistics_during_period` queries, over one WebSocket (the statistics
        are only there); None if Home Assistant can't be asked."""
        url = "ws" + self.url[len("http"):] + "/api/websocket"
        context = None if url.startswith("ws:") else True if self.verify_ssl else _no_verify()
        try:
            # Months of hourly rows don't fit in the default 1 MB message.
            async with websockets.connect(url, open_timeout=self.timeout, ssl=context, max_size=16 * 2**20) as ws:
                await ws.recv()  # auth_required
                await ws.send(json.dumps({"type": "auth", "access_token": self.token}))
                if json.loads(await ws.recv()).get("type") != "auth_ok":
                    return None
                answers = []
                for number, query in enumerate(queries, start=1):
                    await ws.send(json.dumps({"id": number, "type": "recorder/statistics_during_period", **query}))
                    answer = json.loads(await asyncio.wait_for(ws.recv(), self.timeout * 3))
                    answers.append(answer.get("result") or {})
                return answers
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException, ValueError):
            return None

    async def _all_records(self, items: list[dict[str, Any]]) -> dict[str, Records]:
        """All-time max and min of the `records` items, from Home Assistant's long-term statistics."""
        entities = sorted({item["entity"] for item in items if item.get("records")})
        cached_at, cached = self._records
        if not entities or (time.monotonic() - cached_at < RECORDS_CACHE_SECONDS and set(entities) <= cached.keys()):
            return cached
        answers = await self._statistics([{
            "start_time": "2000-01-01T00:00:00Z", "statistic_ids": entities, "period": "day", "types": ["max", "min"],
        }])
        if answers is None:
            # Without records the panel still shows everything else.
            return cached
        records = {entity: parse_records(rows) for entity, rows in answers[0].items() if rows}
        self._records = (time.monotonic(), {**cached, **records})
        return self._records[1]

    async def history(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The `history` command's rows for these items: the last 7 days, day by day."""
        key = json.dumps([item.get("entity") for item in items])
        cached = self._history_rows.get(key)
        if cached and time.monotonic() - cached[0] < HISTORY_CACHE_SECONDS:
            return cached[1]
        rows = await self._week(items, await self._all_states(), datetime.now().astimezone())
        self._history_rows[key] = (time.monotonic(), rows)
        return rows

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
            # No value at all: two digits, and the item's decimals.
            decimals = int(item.get("decimals") or 0)
            shape = OFFLINE_DIGIT * 2 + ("." + OFFLINE_DIGIT * decimals if decimals else "")
            return Reading(label, shape, unit, offline=True)

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

    async def _week(self, items: list[dict[str, Any]], states: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
        """The history's "7 days", day by day: each measured value's max and min of each day, and
        each meter's consumption of each day."""
        days = last_days(now)
        start = midnight(now) - timedelta(days=len(days) - 1)
        # `week: false` leaves a value out of this table (e.g. a power, keeping its energy).
        parts = [[part for part in history_parts(item) if part.get("week") is not False] for item in items]
        kinds = {part["entity"]: state_kind(states.get(part["entity"])) for found in parts for part in found}
        measured = sorted(entity for entity, kind in kinds.items() if kind == "range")
        meters = sorted(entity for entity, kind in kinds.items() if kind == "daily")
        queries = []
        # Hour by hour, so that a meter's glitch only takes out its hour, not the whole day.
        if measured:
            queries.append({"start_time": start.isoformat(), "statistic_ids": measured, "period": "hour", "types": ["max", "min"]})
        if meters:
            queries.append({"start_time": start.isoformat(), "statistic_ids": meters, "period": "day", "types": ["change"]})
        answers = await self._statistics(queries) if queries else []
        if answers is None:
            return [{"label": item.get("name", item.get("entity", "")), "error": "SIN CONEXIÓN"} for item in items]
        found = {entity: rows for answer in answers for entity, rows in answer.items()}
        rows = []
        orders = []
        for item, item_parts in zip(items, parts):
            if item.get("on_today") and item.get("week"):
                # Time on each day (the heating), from the states of the whole week.
                rows.append(await self._week_on_time(item, states.get(item["entity"]), days, start, now))
                orders.append(float(item.get("week_order", 0)))
                continue
            row_parts = []
            for part in item_parts:
                state = states.get(part["entity"]) or {}
                unit = part.get("unit", state.get("attributes", {}).get("unit_of_measurement", ""))
                kind = kinds[part["entity"]]
                if kind == "range":
                    row_parts.append({"unit": unit, "daily": week_ranges(part, found.get(part["entity"], []), days, state, now)})
                elif kind == "daily":
                    row_parts.append({"unit": unit, "daily": week_totals(part, found.get(part["entity"], []), days)})
            if row_parts:
                rows.append({"label": item.get("week_name", item.get("name", item["entity"])), "parts": row_parts})
                orders.append(float(item.get("week_order", 0)))
        # `week_order` moves a column along the table (higher, further right); the rest keep their order.
        return [row for _, _, row in sorted(zip(orders, range(len(rows)), rows), key=lambda entry: entry[:2])]

    async def _week_on_time(
        self, item: dict[str, Any], state: dict[str, Any] | None, days: list, start: datetime, now: datetime
    ) -> dict[str, Any]:
        label = item.get("week_name", item.get("name", item["entity"]))
        params = {"filter_entity_id": item["entity"], "significant_changes_only": "0", "end_time": now.isoformat()}
        if "attribute" not in item:
            params["no_attributes"] = ""
        try:
            response = await self.client.get(f"/api/history/period/{quote(start.isoformat())}", params=params)
            response.raise_for_status()
        except httpx.HTTPError:
            return {"label": label, "error": "SIN CONEXIÓN"}
        series = next(iter(response.json()), [])
        changes = [
            (when, raw_state(item, sample))
            for sample in series
            if (when := parse_timestamp(sample.get("last_updated") or sample.get("last_changed", ""))) is not None
        ]
        if state:
            latest = parse_timestamp(state.get("last_updated", ""))
            if latest is not None and (not changes or latest > changes[-1][0]):
                changes.append((latest, raw_state(item, state)))
        if not changes:
            return {"label": label, "error": "SIN DATOS"}
        cells = []
        for day in days:
            day_start = datetime(day.year, day.month, day.day).astimezone()
            day_end = min(day_start + timedelta(days=1), now)
            # Nothing known before the first state of the history.
            if day_end <= changes[0][0]:
                cells.append(None)
                continue
            cells.append({"total": format_duration(minutes_on(item, changes, day_start, day_end))})
        return {"label": label, "parts": [{"unit": "", "daily": cells}]}

    async def close(self) -> None:
        await self.client.aclose()


def minutes_on(item: dict[str, Any], changes: list[tuple[datetime, str]], start: datetime, end: datetime) -> float:
    """Minutes spent on between start and end, from the states in order of time."""
    total = 0.0
    for (when, raw), (until, _) in zip(changes, [*changes[1:], (end, "")]):
        if is_on(item, raw):
            total += max(0.0, (min(until, end) - max(when, start)).total_seconds())
    return total / 60


def week_ranges(
    part: dict[str, Any], rows: list[dict[str, Any]], days: list, state: dict[str, Any], now: datetime
) -> list[dict[str, Any] | None]:
    """Each day's max and min from the hourly statistics (None for a day without data), leaving out
    the hours beyond `valid_max` or `valid_min`. Days after the sensor last reported are None too:
    Home Assistant keeps writing its last value. Today's counts the current value."""
    scale, decimals = part.get("scale", 1), part.get("decimals")
    high_limit, low_limit = part.get("valid_max"), part.get("valid_min")
    highs: dict[Any, list[float]] = {}
    lows: dict[Any, list[float]] = {}
    for row in rows:
        day = row_time(row).date()
        if row.get("max") is not None and (high_limit is None or row["max"] * scale <= float(high_limit)):
            highs.setdefault(day, []).append(row["max"] * scale)
        if row.get("min") is not None and (low_limit is None or row["min"] * scale >= float(low_limit)):
            lows.setdefault(day, []).append(row["min"] * scale)
    current = parse_number(state.get("state"))
    reported = parse_timestamp(state.get("last_reported") or state.get("last_updated") or "")
    if current is not None and reported is not None and reported >= midnight(now):
        highs.setdefault(now.date(), []).append(current * scale)
        lows.setdefault(now.date(), []).append(current * scale)
    cells = []
    for day in days:
        silent = reported is not None and day > reported.date()
        if silent or day not in highs or day not in lows:
            cells.append(None)
        else:
            cells.append({"max": format_number(max(highs[day]), decimals), "min": format_number(min(lows[day]), decimals)})
    return cells


def week_totals(part: dict[str, Any], rows: list[dict[str, Any]], days: list) -> list[dict[str, Any] | None]:
    """Each day's consumption of a meter (None for a day without data or a reset)."""
    by_day = {row_time(row).date(): row["change"] * part.get("scale", 1)
              for row in rows if row.get("change") is not None and row["change"] >= 0}
    return [{"total": format_number(by_day[day], part.get("decimals", 1))} if day in by_day else None for day in days]


def device(entity: str) -> str:
    """The device an entity belongs to, by its id: sensor.0x00124b…_temperature → 0x00124b…."""
    return entity.split(".", 1)[-1].rsplit("_", 1)[0]


def last_change(series: list[dict[str, Any]]) -> datetime | None:
    """When the value last became different from the one before (unavailable and unknown don't
    count, and neither does the same value sent again)."""
    previous, changed = None, None
    for sample in series:
        value = sample.get("state")
        if value in (None, "", "unavailable", "unknown"):
            continue
        when = parse_timestamp(sample.get("last_changed") or sample.get("last_updated") or "")
        if previous is not None and value != previous and when is not None:
            changed = when
        previous = value
    return changed


def mark_stale(item: dict[str, Any], reading: Reading, state: dict[str, Any], now: datetime,
               seen: datetime | None = None) -> None:
    """Flag a value the device hasn't reported for more than `stale_after` minutes: by its last
    report, or by when its device last really changed a value, if that's earlier (see _last_seen)."""
    reported = parse_timestamp(state.get("last_reported") or state.get("last_updated") or "")
    if reported is None:
        return
    if seen is not None and seen.year == 1:
        # Not one change in all the history read: longer ago than that.
        go_offline(reading, f"hace más de {SEEN_DAYS} d")
        return
    if seen is not None and seen < reported:
        reported = seen
    minutes = (now - reported).total_seconds() / 60
    if minutes > float(item["stale_after"]):
        go_offline(reading, f"hace {format_duration(minutes)}")



def go_offline(reading: Reading, note: str) -> None:
    """A value too old to trust: its digits as dashes (6.0 → -.-), in a dim colour, no bar and no
    alert, and since when."""
    reading.value = re.sub(r"\d", OFFLINE_DIGIT, reading.value)
    reading.offline = True
    reading.fraction = None
    reading.alert = False
    reading.alarm = None
    reading.note = note

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
        if current is not None and not reading.error and not reading.offline and beats(float(current), float(value)):
            when, value = now, current
        rows.append(Reading(item.get(f"record_{kind}_name", name), format_number(value, decimals), reading.unit, note=f"{when:%d/%m/%y}"))
    return rows


def history_parts(item: dict[str, Any]) -> list[dict[str, Any]]:
    """The values of an item (and of its `also`) that have a history: entities' numeric states,
    not attributes, counters of time (`on_today`) or hidden ones; `history: false` leaves one out."""
    if (item.get("hidden") and not item.get("history")) or item.get("on_today") or item.get("history") is False or "entity" not in item:
        return []
    return [
        part for part in [item, *item.get("also", [])]
        if "entity" in part and not part.get("attribute") and not part.get("replace") and part.get("history") is not False
    ]


def state_kind(state: dict[str, Any] | None) -> str | None:
    """'range' for a measured value (the max and min of it), 'daily' for a meter (the consumption
    per day); None for anything without long-term statistics."""
    state_class = ((state or {}).get("attributes") or {}).get("state_class")
    if state_class == "measurement":
        return "range"
    if state_class in ("total", "total_increasing"):
        return "daily"
    return None


def row_time(row: dict[str, Any]) -> datetime:
    start = row["start"]
    if isinstance(start, (int, float)):
        return datetime.fromtimestamp(start / 1000).astimezone()
    return datetime.fromisoformat(start).astimezone()


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
    return minutes_on(item, changes, midnight(now), now)


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

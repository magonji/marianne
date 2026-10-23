import asyncio
from datetime import datetime, timedelta, timezone

import httpx

from marianne.config import parse_config
from marianne.sources.base import Reading
from marianne.sources.homeassistant import (
    HomeAssistantSource,
    day_stats,
    format_duration,
    format_since,
    mark_stale,
    trend_note,
)
from marianne.sources.web import WebSource

STATES = [
    {"entity_id": "sensor.temp", "state": "21.39999", "attributes": {"friendly_name": "Salón", "unit_of_measurement": "°C"}},
    {"entity_id": "sensor.hum", "state": "50", "attributes": {"unit_of_measurement": "%"}},
    {"entity_id": "binary_sensor.door", "state": "on", "attributes": {}, "last_changed": "2026-10-19T07:54:35+00:00"},
    {"entity_id": "sensor.dead", "state": "unavailable", "attributes": {}},
    {"entity_id": "sensor.sun_next_rising", "state": "2026-10-20T06:58:37+00:00", "attributes": {}},
    {"entity_id": "sensor.job", "state": "none", "attributes": {}},
    {"entity_id": "sensor.washer", "state": "finish", "attributes": {}, "last_changed": "2026-10-19T07:00:00+00:00"},
    {"entity_id": "weather.home", "state": "sunny", "attributes": {"temperature": 18.5}},
]


def run(coro):
    return asyncio.run(coro)


def ha_source() -> HomeAssistantSource:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer secret"
        return httpx.Response(200, json=STATES)

    return HomeAssistantSource("ha", "http://ha.test", token="secret", transport=httpx.MockTransport(handler))


def test_home_assistant_readings():
    items = [
        {"entity": "sensor.temp"},
        {"entity": "sensor.hum"},
        {"entity": "binary_sensor.door", "on_text": "ABIERTA"},
        {"entity": "sensor.dead"},
        {"entity": "sensor.missing"},
        {"entity": "weather.home", "attribute": "temperature", "unit": "°C", "name": "Fuera"},
        {"entity": "weather.home", "map": {"sunny": "SOL"}},
    ]
    temp, hum, door, dead, missing, outside, weather = run(ha_source().fetch(items))

    assert (temp.label, temp.value, temp.unit, temp.fraction) == ("Salón", "21.4", "°C", None)
    assert hum.fraction == 0.5
    assert (door.value, door.switch) == ("ABIERTA", True)
    assert dead.error and missing.error
    assert (outside.label, outside.value, outside.unit) == ("Fuera", "18.5", "°C")
    assert weather.value == "SOL"


def test_home_assistant_since():
    (door,) = run(ha_source().fetch([{"entity": "binary_sensor.door", "on_text": "ABIERTA", "since": True}]))
    assert door.value == "ABIERTA " + format_since("2026-10-19T07:54:35+00:00")


def test_format_since_adds_day_when_not_today():
    now = datetime.now().astimezone()
    assert format_since(now.isoformat()) == now.strftime("%H:%M")
    assert format_since("2020-01-02T03:04:00+00:00").startswith("02/01 ")


def test_home_assistant_invert():
    (freezer,) = run(ha_source().fetch([{"entity": "binary_sensor.door", "invert": True, "off_text": "CERRADO"}]))
    assert (freezer.value, freezer.switch) == ("CERRADO", False)


def test_alerts():
    items = [
        {"entity": "binary_sensor.door", "alert": True},
        {"entity": "binary_sensor.door", "invert": True, "alert": True},
        {"entity": "sensor.hum", "alert_below": 60},
        {"entity": "sensor.hum", "alert_below": 40, "alert_above": 70},
    ]
    open_door, inverted, low, in_range = run(ha_source().fetch(items))
    assert open_door.alert and low.alert
    assert not inverted.alert and not in_range.alert


def test_alarm_after_minutes_open():
    items = [
        {"entity": "binary_sensor.door", "name": "Puerta", "on_text": "ABIERTA", "alert": True, "alarm_after": 1},
        {"entity": "binary_sensor.door", "alert": True, "alarm_after": 10**9},
        {"entity": "binary_sensor.door", "alarm_after": 1},
    ]
    long_open, recent, no_alert = run(ha_source().fetch(items))
    assert long_open.alarm.startswith("Puerta ABIERTA · desde hace ")
    assert recent.alarm is None and no_alert.alarm is None


def test_format_duration():
    assert format_duration(7.9) == "7 min"
    assert format_duration(125) == "2 h 05 min"
    assert format_duration(203 * 60 + 51) == "8 d 11 h"


def test_map_applies_before_unavailable_check():
    mapped, unmapped = run(ha_source().fetch([{"entity": "sensor.job", "map": {"none": "—"}}, {"entity": "sensor.job"}]))
    assert (mapped.value, mapped.error) == ("—", False)
    assert unmapped.error


def test_text_state_alert_and_custom_alarm_text():
    items = [
        {"entity": "sensor.washer", "map": {"finish": "TERMINADA"}, "alert_states": ["finish"],
         "alarm_after": 0, "alarm_text": "Lavadora terminada"},
        {"entity": "sensor.washer", "alert_states": ["finish"]},
        {"entity": "sensor.washer", "alert_states": ["wash"], "alarm_after": 0},
    ]
    mapped, raw, other = run(ha_source().fetch(items))
    assert mapped.value == "TERMINADA" and mapped.alert
    assert mapped.alarm.startswith("Lavadora terminada · desde hace ")
    assert raw.alert and raw.alarm is None
    assert not other.alert and other.alarm is None


def test_on_states_turn_text_into_indicator():
    items = [
        {"entity": "sensor.washer", "on_states": ["finish"], "map": {"finish": "LISTA"}},
        {"entity": "sensor.job", "on_states": ["heating"]},
    ]
    on, off = run(ha_source().fetch(items))
    assert (on.value, on.switch) == ("LISTA", True)
    assert (off.value, off.switch) == ("none", False)


def test_numeric_alarm_waits_for_alarm_after_and_resets():
    source = ha_source()
    item = {"entity": "sensor.hum", "name": "Humedad", "alert_above": 40, "alarm_after": 10, "hidden": True}
    (first,) = run(source.fetch([item]))
    assert first.alert and first.hidden and first.alarm is None  # just started
    key = ("sensor.hum", None)
    source._alert_since[key] -= timedelta(minutes=11)
    source._fetched_at = 0
    (later,) = run(source.fetch([item]))
    assert later.alarm == "Humedad 50 % · desde hace 11 min"
    (cleared,) = run(source.fetch([{**item, "alert_above": 90}]))
    assert cleared.alarm is None and key not in source._alert_since


def test_also_puts_extra_values_on_the_same_row():
    items = [{"entity": "sensor.temp", "name": "Salón", "also": [{"entity": "sensor.hum", "alert_above": 40}]}]
    (row,) = run(ha_source().fetch(items))
    (hum,) = row.extra
    assert (row.label, row.value, hum.value, hum.unit) == ("Salón", "21.4", "50", "%")
    assert hum.fraction is None and hum.alert and not row.alert


def test_config_normalises_also_shorthand():
    config = parse_config(
        {"sources": {"homeassistant": {}}, "panels": [{"items": [{"entity": "sensor.t", "also": "sensor.h"}]}]}, None
    )
    assert config.panels[0].items[0]["also"] == [{"entity": "sensor.h"}]


def test_home_assistant_scale():
    (hum,) = run(ha_source().fetch([{"entity": "sensor.hum", "scale": 0.001, "unit": "k", "decimals": 2}]))
    assert (hum.value, hum.unit) == ("0.05", "k")


def test_home_assistant_timestamp_in_local_time():
    (rising,) = run(ha_source().fetch([{"entity": "sensor.sun_next_rising", "format": "time"}]))
    expected = datetime.fromisoformat("2026-10-20T06:58:37+00:00").astimezone().strftime("%H:%M")
    assert rising.value == expected


def test_web_scraping():
    html = "<html><div class='price'>Precio: 0,153 €</div><a id='l' href='/x'>link</a></html>"
    source = WebSource("web", transport=httpx.MockTransport(lambda r: httpx.Response(200, text=html)))
    items = [
        {"name": "Luz", "url": "http://w.test", "selector": ".price", "regex": r"([\d,]+)", "numeric": True, "decimals": 2},
        {"name": "Enlace", "url": "http://w.test", "selector": "#l", "attr": "href"},
        {"name": "Nada", "url": "http://w.test", "selector": ".nope"},
    ]
    price, link, nothing = run(source.fetch(items))
    assert price.value == "0.15"
    assert link.value == "/x"
    assert nothing.error


def test_config_shorthand():
    config = parse_config(
        {"sources": {"homeassistant": {}}, "panels": [{"title": "A", "items": ["sensor.x"], "span": 2}]}, None
    )
    assert config.panels[0].items == [{"entity": "sensor.x", "source": "homeassistant"}]
    assert config.panels[0].column_span == 2


NOW = datetime(2026, 10, 19, 15, 0, tzinfo=timezone.utc)


def at(hour, minute=0):
    return NOW.replace(hour=hour, minute=minute)


def test_stale_value_is_flagged_and_skips_trend():
    item = {"entity": "sensor.temp", "stale_after": 120}
    reading = Reading("T", "7.3", "°C")
    mark_stale(item, reading, {"last_reported": at(1, 30).isoformat()}, NOW)
    assert reading.error and reading.note == "hace 13 h 30 min"
    fresh = Reading("T", "7.3", "°C")
    mark_stale(item, fresh, {"last_reported": at(14).isoformat()}, NOW)
    assert not fresh.error and fresh.note == ""


def test_trend_note():
    samples = [(at(10), 1020.0), (at(11, 30), 1022.0), (at(13), 1025.0)]
    assert trend_note({"trend": 3, "decimals": 0}, 1027.0, samples, NOW) == "▲ +5"
    assert trend_note({"trend": 3}, 1021.0, samples, NOW) == "▼ -1.0"
    assert trend_note({"trend": 3, "trend_steady": 1}, 1022.5, samples, NOW) == "► +0.5"
    # Not enough history: compare with the oldest sample.
    assert trend_note({"trend": 10}, 1021.0, samples, NOW) == "▲ +1.0"


def test_day_stats_include_value_at_midnight_and_current():
    samples = [(at(0) - timedelta(hours=2), 3.0), (at(6), 5.5), (at(13, 20), 12.4)]
    high, low = day_stats({"decimals": 1}, Reading("T", "9", "°C"), 9.0, samples, NOW)
    assert (high.label, high.value, high.unit, high.note) == ("Máxima hoy", "12.4", "°C", "13:20")
    assert (low.value, low.note) == ("3.0", at(0).strftime("%H:%M"))


def test_history_rows_through_the_api():
    now = datetime.now(timezone.utc)
    history = [[
        {"entity_id": "sensor.hum", "state": "40", "last_changed": (now - timedelta(hours=5)).isoformat()},
        {"state": "45", "last_changed": (now - timedelta(minutes=1)).isoformat()},
    ]]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/api/history/period/"):
            assert request.url.params["filter_entity_id"] == "sensor.hum"
            return httpx.Response(200, json=history)
        return httpx.Response(200, json=STATES)

    source = HomeAssistantSource("ha", "http://ha.test", token="t", transport=httpx.MockTransport(handler))
    readings = run(source.fetch([{"entity": "sensor.hum", "trend": 3, "decimals": 0, "stats": True}]))
    assert [r.label for r in readings[1:]] == ["Máxima hoy", "Mínima hoy"]
    assert readings[0].note == "▲ +10"
    assert readings[1].value == "50"


def test_history_failure_keeps_current_values():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/api/history/"):
            return httpx.Response(500)
        return httpx.Response(200, json=STATES)

    source = HomeAssistantSource("ha", "http://ha.test", token="t", transport=httpx.MockTransport(handler))
    (hum,) = run(source.fetch([{"entity": "sensor.hum", "trend": 3, "stats": True}]))
    assert (hum.value, hum.note) == ("50", "")


def test_on_today_adds_up_the_time_heating_since_midnight():
    from datetime import datetime

    from marianne.sources.homeassistant import on_minutes

    item = {"entity": "climate.nest", "attribute": "hvac_action", "on_states": ["heating"]}
    tz = datetime.now().astimezone().tzinfo
    at = lambda h, m: datetime(2026, 10, 19, h, m, tzinfo=tz)  # noqa: E731
    changes = [(at(0, 0), "idle"), (at(6, 40), "heating"), (at(7, 0), "idle"), (at(14, 0), "heating")]
    assert on_minutes(item, changes, at(14, 25)) == 45
    # A state from before midnight only counts from midnight on.
    assert on_minutes({"entity": "switch.x"}, [(datetime(2026, 10, 18, 22, 0, tzinfo=tz), "on")], at(1, 30)) == 90


def test_on_today_reads_the_attribute_history():
    from datetime import datetime, timedelta

    start = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    iso = lambda minutes: (start + timedelta(minutes=minutes)).isoformat()  # noqa: E731
    history = [[
        {"entity_id": "climate.nest", "state": "heat", "last_updated": iso(0), "attributes": {"hvac_action": "idle"}},
        {"entity_id": "climate.nest", "state": "heat", "last_updated": iso(1), "attributes": {"hvac_action": "heating"}},
        {"entity_id": "climate.nest", "state": "heat", "last_updated": iso(31), "attributes": {"hvac_action": "idle"}},
    ]]
    state = {"entity_id": "climate.nest", "state": "heat", "last_updated": iso(31), "attributes": {"hvac_action": "idle"}}

    def handler(request):
        if "/api/history/" in request.url.path:
            assert request.url.params["significant_changes_only"] == "0"
            return httpx.Response(200, json=history)
        return httpx.Response(200, json=[state])

    source = HomeAssistantSource("ha", "http://ha", "token", transport=httpx.MockTransport(handler))
    item = {"entity": "climate.nest", "name": "Calefacción hoy", "attribute": "hvac_action",
            "on_states": ["heating"], "on_today": True}
    reading = asyncio.run(source.fetch([item]))[0]
    assert (reading.label, reading.value) == ("Calefacción hoy", "30 min")


def test_also_replace_takes_the_place_of_the_main_value():
    def state(preset):
        return {"entity_id": "climate.nest", "state": "heat", "last_updated": "2026-10-19T10:00:00+00:00",
                "attributes": {"preset_mode": preset}}

    item = {"entity": "climate.nest", "name": "Calefacción", "map": {"heat": "ENCENDIDA"},
            "also": [{"entity": "climate.nest", "attribute": "preset_mode", "replace": True,
                      "map": {"none": "", "eco": "ECO"}}]}
    for preset, expected in (("none", "ENCENDIDA"), ("eco", "ECO")):
        transport = httpx.MockTransport(lambda request, preset=preset: httpx.Response(200, json=[state(preset)]))
        source = HomeAssistantSource("ha", "http://ha", "token", transport=transport)
        reading = asyncio.run(source.fetch([item]))[0]
        assert (reading.value, reading.extra) == (expected, [])


def test_records_from_daily_statistics():
    from datetime import datetime, timezone

    from marianne.sources.homeassistant import parse_records, record_rows

    day = lambda d: int(datetime(2026, 6, d, tzinfo=timezone.utc).timestamp() * 1000)  # noqa: E731
    rows = [
        {"start": day(1), "max": 20.94, "min": 16.13},
        {"start": day(25), "max": 27.67, "min": 17.02},
        {"start": day(26), "max": 15.0, "min": 2.49},
    ]
    records = parse_records(rows)
    assert records["max"][1] == 27.67 and records["min"][1] == 2.49
    main = Reading("Temperatura", "10.0", "°C")
    high, low = record_rows({"decimals": 1}, main, records, 10.0)
    assert (high.label, high.value, high.unit) == ("Récord máxima", "27.7", "°C")
    assert high.note == f"{records['max'][0]:%d/%m/%y}" and low.value == "2.5"
    # A record being set right now beats the hourly statistics.
    assert record_rows({"decimals": 1}, main, records, 1.2)[1].value == "1.2"


def test_stats_beside_go_next_to_the_value():
    from datetime import datetime, timedelta

    now = datetime.now().astimezone()
    iso = lambda minutes: (now - timedelta(minutes=minutes)).isoformat()  # noqa: E731
    state = {"entity_id": "sensor.t", "state": "6.0", "last_updated": iso(1), "last_reported": iso(1), "attributes": {}}
    history = [[{"entity_id": "sensor.t", "state": "4.0", "last_changed": iso(30)},
                {"entity_id": "sensor.t", "state": "9.0", "last_changed": iso(10)}]]

    def handler(request):
        return httpx.Response(200, json=history if "/api/history/" in request.url.path else [state])

    source = HomeAssistantSource("ha", "http://ha", "token", transport=httpx.MockTransport(handler))
    readings = asyncio.run(source.fetch([{"entity": "sensor.t", "decimals": 1, "stats": "beside"}]))
    assert len(readings) == 1
    assert [(extra.label, extra.value) for extra in readings[0].extra] == [("▲", "9.0"), ("▼", "4.0")]

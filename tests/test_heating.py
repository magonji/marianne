import asyncio
import json
import math
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import ConfigError, parse_config
from marianne.heating import (DIALS, STEP, History, add_to_dial_log, analyse, efficiency, history_from, radiator_output,
                              read_dial_log)
from marianne.server import Dashboard, make_app

JUNIOR = DIALS["greenstar-junior"]
START = datetime(2026, 11, 1, tzinfo=timezone.utc)


def simulated_house(days=10, rooms=None, sun=0.0, window=None):
    """A house of known make, one thermostat in its first room: each room's air warms `heat` K/h
    with the boiler on and loses `loss` of its difference with the outside each hour; the
    thermostat keeps its room near 20 °C by day and 16 °C at night. Simulated by the minute,
    sampled every half hour as the analysis does. `window`: (room, half hour) it's opened."""
    rooms = rooms or {"Casa": (1.5, 0.02)}
    temps = {name: 18.0 for name in rooms}
    series = {name: [] for name in rooms}
    thermostat = next(iter(rooms))
    times, outside, on, sunny = [], [], [], []
    burning, t = False, START
    for step in range(int(days * 48)):
        # As Home Assistant's history gives them: the temperatures at the step's start, the
        # heating over the step.
        times.append(t)
        for name in rooms:
            series[name].append(round(temps[name], 2))
        outside.append(round(5 + 3 * math.sin((t.hour + t.minute / 60 - 9) / 24 * 2 * math.pi), 2))
        burned = 0
        for _ in range(30):
            hour = t.hour + t.minute / 60
            out = 5 + 3 * math.sin((hour - 9) / 24 * 2 * math.pi)
            target = 20.0 if 7 <= hour < 23 else 16.0
            burning = temps[thermostat] < target - 0.3 or (burning and temps[thermostat] < target + 0.3)
            shine = max(0.0, math.sin((hour - 6) / 12 * math.pi)) if 6 <= hour < 18 else 0.0
            for name, (heat, loss) in rooms.items():
                temps[name] += (heat * burning - loss * (temps[name] - out) + sun * shine) / 60
                if window == (name, step):
                    temps[name] -= 1.5 / 30
            burned += burning
            t += timedelta(minutes=1)
        on.append(burned / 30)
        sunny.append(shine)
    return times, series, outside, on, sunny


def history(times, rooms, outside, on, flow=68, sun=None):
    n = len(times)
    return History(times, rooms, {}, outside, on, [20.0] * n, [0.0] * n, sun or {}, [flow] * n, cycles=[60.0, 90.0, 10.0])


def test_the_balance_finds_the_house_losses_against_the_boiler():
    times, rooms, outside, on, _ = simulated_house()
    result = analyse(history(times, rooms, outside, on), "4", JUNIOR, -3, 20)
    # Over days, the boiler's time for each degree of difference is the loss against the heating
    assert result["model"]["per_degree"] == pytest.approx(0.02 / 1.5, rel=0.08)
    assert result["model"]["warming"] == pytest.approx(1.5, rel=0.1)
    assert result["limit"] == pytest.approx(20 - 1.5 / 0.02, abs=6)
    assert result["cycles"] == {"count": 3, "mean": 53, "short": 1}
    # The positions: the lower, the cooler the water back, the better the boiler, the slower the warming
    dials = result["dials"]
    assert [p["dial"] for p in dials] == ["1", "2", "3", "4", "5", "6", "max"]
    assert all(a["back"] < b["back"] and a["efficiency"] >= b["efficiency"] for a, b in zip(dials, dials[1:]))
    warming = [p["warm_two"] for p in dials if p["warm_two"]]
    assert len(warming) >= 4 and warming == sorted(warming, reverse=True)
    assert next(p for p in dials if p["dial"] == "4")["saving"] == 0
    best = result["advice"]["best"]
    assert best is not None and next(p for p in dials if p["dial"] == best)["condensing"]


def test_a_weak_boiler_has_no_lower_position_to_go_to():
    # Barely holding: needs most of the time at the top position, a lower one can't do it
    times, rooms, outside, on, _ = simulated_house(rooms={"Casa": (0.25, 0.02)})
    result = analyse(history(times, rooms, outside, on, flow=82), "max", JUNIOR, -3, 20)
    assert result["advice"]["design"] in (None, "max", "6")
    assert result["advice"]["best"] is None


def test_the_sun_shows_on_its_side():
    times, rooms, outside, on, sunny = simulated_house(sun=0.4)
    result = analyse(history(times, rooms, outside, on, sun={"este": sunny}), "4", JUNIOR, -3, 20)
    assert result["sun"]["este"]["warms"] == pytest.approx(0.4, rel=0.25)


def test_rooms_cooling_windows_and_mould():
    times, rooms, outside, on, _ = simulated_house(
        rooms={"Vestíbulo": (0.6, 0.03), "Estudio": (0.6, 0.05), "Dormitorio": (0.6, 0.03)}, window=("Dormitorio", 100))
    h = history(times, rooms, outside, on)
    # Humid air in the study: its corners over 80 %
    h.humidity = {"Estudio": [75.0] * len(times), "Vestíbulo": [45.0] * len(times)}
    result = analyse(h, "4", JUNIOR, -3, 20, thermostat_room="Vestíbulo")
    by_name = {room["name"]: room for room in result["rooms"]}
    assert by_name["Estudio"]["cools"] > 1.2 > by_name["Vestíbulo"]["cools"]
    # The leaky room stays behind the thermostat's while the heating runs
    assert by_name["Estudio"]["behind"] < 0
    assert by_name["Dormitorio"]["opened"] == 1 and by_name["Vestíbulo"]["opened"] == 0
    assert "behind" not in by_name["Vestíbulo"]
    assert by_name["Estudio"]["mould"] > 50 and by_name["Vestíbulo"]["mould"] == 0


def test_radiators_and_the_condensing_curve():
    assert radiator_output(75, 20) == pytest.approx((1.0, 60.0), abs=0.01)
    low, back = radiator_output(47, 20)
    assert 0.2 < low < 0.5 and 38 < back < 44
    assert efficiency(30) > efficiency(50) > efficiency(60) > 86


def test_without_heating_seen_there_is_no_model():
    n = 100
    times = [START + STEP * k for k in range(n)]
    result = analyse(history(times, {"Casa": [18.0] * n}, [5.0] * n, [0.0] * n), "4", JUNIOR, -3, 20)
    assert result["model"] is None


def test_the_dial_log(tmp_path):
    path = str(tmp_path / "data" / "caldera.json")
    assert read_dial_log(path) == []
    add_to_dial_log(path, "4")
    add_to_dial_log(path, "3")
    assert [dial for _, dial in read_dial_log(path)] == ["4", "3"]


def test_history_from_home_assistant_rows():
    now = START + timedelta(hours=6)
    iso = lambda h: (START + timedelta(hours=h)).isoformat()  # noqa: E731
    states = {
        "climate.nest": [{"state": "heat", "last_updated": iso(0), "attributes": {"hvac_action": "idle", "temperature": 20}},
                         {"state": "heat", "last_updated": iso(1), "attributes": {"hvac_action": "heating", "temperature": 20}},
                         {"state": "heat", "last_updated": iso(2), "attributes": {"hvac_action": "idle", "temperature": 20}}],
        "sensor.fuera": [{"state": "5.0", "last_updated": iso(0)}],
        "sensor.salon": [{"state": "18.0", "last_updated": iso(0)}, {"state": "unavailable", "last_updated": iso(3)}],
        "sensor.sun_solar_elevation": [{"state": "30", "last_updated": iso(0)}],
        "sensor.sun_solar_azimuth": [{"state": "119", "last_updated": iso(0)}],
    }
    item = {"heating": "climate.nest", "outside": "sensor.fuera", "rooms": {"Salón": "sensor.salon"},
            "facades": {"este": 119, "oeste": 299}}
    h = history_from(states, item, now, 0.25, [(START, "4")], JUNIOR)
    assert len(h.times) == 12 and h.flow[0] == 68
    assert sum(h.heating) == pytest.approx(2.0)  # one hour on, in half hours
    assert h.cycles == [60.0]
    assert h.rooms["Salón"][0] == 18.0
    # The sun straight at the east windows, not at the west ones
    assert h.sun["este"][0] == pytest.approx(math.cos(math.radians(30))) and h.sun["oeste"][0] == 0


def test_heating_needs_its_entities():
    for item in ({"heating": "sensor.x", "outside": "sensor.f", "rooms": {"A": "sensor.a"}},
                 {"heating": "climate.x", "rooms": {"A": "sensor.a"}},
                 {"heating": "climate.x", "outside": "sensor.f", "rooms": {"A": "sensor.a"}, "boiler": "otra"}):
        with pytest.raises(ConfigError):
            parse_config({"boot": False, "sources": {"homeassistant": {"url": "http://ha.test", "token": "x"}},
                          "panels": [{"title": "Eficiencia", "key": "g", "items": [item]}]}, None)


def test_the_dial_from_the_page(tmp_path):
    published = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            published.append((request.url.path, json.loads(request.content)))
            return httpx.Response(200, json={})
        return httpx.Response(200, json=[])

    dial_file = str(tmp_path / "caldera.json")
    config = parse_config({"boot": False, "sources": {"homeassistant": {"url": "http://ha.test", "token": "x"}},
                           "panels": [{"title": "Eficiencia", "key": "g", "items": [
                               {"heating": "climate.nest", "outside": "sensor.f", "rooms": {"A": "sensor.a"},
                                "dial_file": dial_file, "publish": "sensor.caldera_impulsion"}]}]}, None)
    dashboard = Dashboard(config, demo=False)
    dashboard.sources["homeassistant"].client._transport = httpx.MockTransport(handler)

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            answer = await client.post("/api/dial/0", json={"position": "3"})
            assert answer.status == 200
            (reading,) = (await answer.json())["panels"][0][0]["readings"]
            assert reading["heating"]["dial"] == "3" and reading["heating"]["since"]
            assert (await client.post("/api/dial/0", json={"position": "7"})).status == 400
            assert (await client.post("/api/dial/5", json={"position": "3"})).status == 404

    asyncio.run(run())
    assert [dial for _, dial in read_dial_log(dial_file)] == ["3"]
    # Home Assistant answered no such sensor (it restarted): set again on each look, as here once more
    assert len(published) >= 2 and published[0] == published[-1]
    assert published[0] == ("/api/states/sensor.caldera_impulsion", {
        "state": 61, "attributes": {"unit_of_measurement": "°C", "device_class": "temperature", "position": "3",
                                    "friendly_name": "Caldera: temperatura de impulsión", "icon": "mdi:water-boiler"}})


def test_a_summary_line_elsewhere(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    config = parse_config({"boot": False, "sources": {"homeassistant": {"url": "http://ha.test", "token": "x"}},
                           "panels": [{"title": "Energía", "items": [{"heating_summary": True, "name": "Caldera"}]}]}, None)
    dashboard = Dashboard(config, demo=False)
    dashboard.sources["homeassistant"].client._transport = httpx.MockTransport(handler)
    asyncio.run(dashboard.reload())
    (reading,) = dashboard.state()["panels"][0][0]["readings"]
    assert (reading["label"], reading["heating_summary"]) == ("Caldera", True)


def test_days_kept_and_weeks(tmp_path):
    from marianne.heating import day_summaries, house_of, keep_days, read_days, weeks

    times, rooms, outside, on, _ = simulated_house(days=10)
    h = history(times, rooms, outside, on)
    days = day_summaries(h, house_of(h))
    # Full days only, each with its hours and its degree-hours
    assert len(days) == 10 and all(day["degree_hours"] > 0 and day["hours"] > 0 for day in days.values())
    path = str(tmp_path / "calefaccion.json")
    first = dict(list(days.items())[:6])
    keep_days(path, first)
    # Seen again with more days: merged, nothing lost
    kept = keep_days(path, dict(list(days.items())[4:]))
    assert kept == days and read_days(path) == days
    # The balance from kept days alone gives the same as from the history
    with_days = analyse(h, "4", JUNIOR, -3, 20, days=kept)
    assert with_days["model"]["per_degree"] == pytest.approx(analyse(h, "4", JUNIOR, -3, 20)["model"]["per_degree"])
    assert with_days["kept_days"] == 10
    week_rows = weeks(kept, None)
    assert sum(w["days"] for w in week_rows) == 10 and week_rows[0]["monday"] <= week_rows[-1]["monday"]
    assert all(w["per_degree_day"] > 0 for w in week_rows)


def test_a_lower_dial_counts_its_hours_for_less():
    from marianne.heating import at_dial, radiator_output

    reference = radiator_output(68, 20)[0]
    # Ten hours at position 2 gave out less than ten at position 4
    day = {"hours": 10.0, "output": 10 * radiator_output(53, 19)[0], "dial": "2"}
    assert at_dial(day, reference) < 10
    assert at_dial({"hours": 10.0, "output": None, "dial": None}, reference) == 10

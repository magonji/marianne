import asyncio
from datetime import date, datetime, timedelta

from marianne.sources.homeassistant import daily_part, history_parts, range_part, state_kind
from marianne.sources.openweather import WeatherHistory, daily_summaries, weather_history

NOW = datetime(2026, 10, 24, 14, 0).astimezone()


def stat(when, **values):
    return {"start": int(when.timestamp() * 1000), **values}


def test_which_values_have_a_history():
    item = {"entity": "sensor.salon_temp", "name": "Salón", "also": [{"entity": "sensor.salon_hum"}]}
    assert [part["entity"] for part in history_parts(item)] == ["sensor.salon_temp", "sensor.salon_hum"]
    assert history_parts({"entity": "sensor.x", "hidden": True}) == []
    assert history_parts({"entity": "sensor.x", "on_today": True}) == []
    assert history_parts({"entity": "sensor.x", "history": False}) == []
    assert history_parts({"entity": "climate.x", "attribute": "temperature"}) == []
    assert state_kind({"attributes": {"state_class": "measurement"}}) == "range"
    assert state_kind({"attributes": {"state_class": "total_increasing"}}) == "daily"
    assert state_kind({"attributes": {}}) is None


def test_range_leaves_out_glitches_and_counts_the_current_value():
    rows = [stat(NOW - timedelta(hours=3), max=250.0, min=40.0),
            stat(NOW - timedelta(hours=2), max=179919.0, min=60.0),  # the meter's glitch
            stat(NOW - timedelta(hours=1), max=900.0, min=55.0)]
    part = range_part({"entity": "sensor.luz", "valid_max": 20000, "decimals": 0}, rows, "W", 30.0, NOW, "today")
    assert (part["max"], part["max_at"]) == ("900", f"{NOW - timedelta(hours=1):%H:%M}")
    assert (part["min"], part["min_at"]) == ("30", f"{NOW:%H:%M}")  # right now, not yet in the statistics
    assert range_part({}, [], "W", None, NOW, "7d") == {"error": "SIN DATOS", "unit": "W"}


def test_daily_consumption_ignores_resets_and_an_unfinished_today():
    day = lambda n: NOW.replace(hour=0) - timedelta(days=n)
    rows = [stat(day(3), change=4.4), stat(day(2), change=-198.4), stat(day(1), change=18.9), stat(day(0), change=1.2)]
    part = daily_part({"decimals": 1}, rows, "kWh", "7d")
    assert (part["max"], part["min"], part["unit"]) == ("18.9", "4.4", "kWh/día")
    assert daily_part({"decimals": 1}, rows, "kWh", "today") == {"total": "1.2", "unit": "kWh"}


def test_weather_history_keeps_old_days_as_summaries(tmp_path):
    history = WeatherHistory(tmp_path / "tiempo.json")
    start = datetime(2026, 10, 20, 0, 0).astimezone()
    # Five days, one sample an hour: a warm afternoon and 1 mm/h of rain at 6 every day
    for hour in range(5 * 24):
        when = start + timedelta(hours=hour)
        history.add({"dt": int(when.timestamp()), "main": {"temp": 10 + (when.hour == 15) * 5 + hour / 100},
                     "wind": {"speed": 2}, "clouds": {"all": 50}, "rain": {"1h": 1.0} if when.hour == 6 else {}})
    kept = {datetime.fromtimestamp(sample["t"]).date() for sample in history.samples}
    assert min(kept) == date(2026, 10, 22) and set(history.days) == {"2026-10-20", "2026-10-21"}
    # The file keeps both, and the older format (a bare list) still loads
    again = WeatherHistory(tmp_path / "tiempo.json")
    assert set(again.days) == set(history.days) and len(again.samples) == len(history.samples)
    assert daily_summaries(history.samples)["2026-10-22"]["rain"] == 1.0

    rows = {row["label"]: row["parts"][0] for row in weather_history(history, "all", datetime(2026, 10, 24, 23).astimezone())}
    assert rows["Temperatura"]["max_at"] == "24/10/26" and rows["Lluvia"]["max"] == "1.0"
    assert rows["Datos desde"]["total"] == "20/10/26"
    today = {row["label"]: row["parts"][0] for row in weather_history(history, "today", datetime(2026, 10, 24, 23).astimezone())}
    assert today["Temperatura"]["max_at"] == "15:00" and today["Lluvia"] == {"total": "1.0", "unit": "mm"}


def test_history_route(tmp_path):
    from aiohttp.test_utils import TestClient, TestServer

    from marianne.config import parse_config
    from marianne.server import Dashboard, make_app

    data = {"boot": False,
            "sources": {"tiempo": {"type": "openweather", "api_key": "k", "history": str(tmp_path / "t.json")},
                        "fechas": {"type": "dates"}},
            "panels": [{"title": "El tiempo", "source": "tiempo", "history": True, "items": [{"field": "good_day"}]},
                       {"title": "Fechas", "source": "fechas", "items": [{"progress": "day"}]}]}
    dashboard = Dashboard(parse_config(data, None), demo=False)

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            layout = await (await client.get("/api/layout")).json()
            assert layout["history_key"] == "h" and layout["history_periods"][0] == "today"
            assert [panel["history"] for panel in layout["panels"]] == [True, False]
            answer = await (await client.get("/api/history/7d")).json()
            assert answer["period"] == "7d" and list(answer["panels"]) == ["0"]
            assert answer["panels"]["0"] == [{"label": "Temperatura", "error": "SIN DATOS"}]  # nothing observed yet
            assert (await client.get("/api/history/siglo")).status == 404

    asyncio.run(run())

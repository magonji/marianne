import asyncio
from datetime import date, datetime, timedelta

from marianne.sources.homeassistant import history_parts, state_kind, week_totals
from marianne.sources.openweather import WeatherHistory, daily_summaries, weather_week

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


def test_week_totals_ignore_resets():
    day = lambda n: NOW.replace(hour=0) - timedelta(days=n)
    rows = [stat(day(2), change=4.4), stat(day(1), change=-198.4), stat(day(0), change=1.2)]
    days = [day(n).date() for n in (2, 1, 0)]
    assert week_totals({"decimals": 1}, rows, days) == [{"total": "4.4"}, None, {"total": "1.2"}]


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

    week = {row["label"]: row["parts"][0]["daily"] for row in weather_week(history, datetime(2026, 10, 24, 23).astimezone())}
    assert [cell and cell["max"] for cell in week["Temperatura"]][:2] == [None, None]  # 18 and 19: not observed
    assert week["Temperatura"][-1]["max"] == "16.1" and week["Lluvia"][-1] == {"total": "1.0"}


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
            assert layout["history_key"] == "h"
            assert [panel["history"] for panel in layout["panels"]] == [True, False]
            answer = await (await client.get("/api/history")).json()
            assert len(answer["days"]) == 7 and list(answer["panels"]) == ["0"]
            assert answer["panels"]["0"] == [{"label": "Temperatura", "error": "SIN DATOS"}]  # nothing observed yet

    asyncio.run(run())


def test_week_ranges_by_hour_without_glitches_or_silent_days():
    from marianne.sources.homeassistant import week_ranges

    days = [NOW.date() - timedelta(days=n) for n in (2, 1, 0)]
    hour = lambda day, h: datetime(day.year, day.month, day.day, h).astimezone()
    rows = [stat(hour(days[0], 3), max=300.0, min=40.0), stat(hour(days[0], 4), max=179919.0, min=50.0),
            stat(hour(days[1], 9), max=900.0, min=45.0)]
    state = {"state": "120", "last_reported": NOW.isoformat()}
    cells = week_ranges({"valid_max": 20000, "decimals": 0}, rows, days, state, NOW)
    # The glitch only takes out its hour; today, nothing in the statistics yet but the current value
    assert cells == [{"max": "300", "min": "40"}, {"max": "900", "min": "45"}, {"max": "120", "min": "120"}]
    # A sensor silent since the day before yesterday: the days after are unknown
    silent = {"state": "6.0", "last_reported": (NOW - timedelta(days=2)).isoformat()}
    assert week_ranges({}, rows, days, silent, NOW)[1:] == [None, None]


def test_minutes_on_within_a_day():
    from marianne.sources.homeassistant import minutes_on

    day = datetime(2026, 10, 23).astimezone()
    item = {"on_states": ["heating"]}
    changes = [(day - timedelta(hours=1), "heating"), (day + timedelta(hours=1), "idle"),
               (day + timedelta(hours=7), "heating"), (day + timedelta(hours=7, minutes=30), "idle")]
    # From midnight (it was already heating) to 1:00, and 7:00 to 7:30
    assert minutes_on(item, changes, day, day + timedelta(days=1)) == 90


def test_hidden_items_can_stay_in_the_history():
    assert history_parts({"entity": "sensor.luz_hoy", "hidden": True}) == []
    assert [p["entity"] for p in history_parts({"entity": "sensor.luz_hoy", "hidden": True, "history": True})] == ["sensor.luz_hoy"]
    assert history_parts({"energy": True, "power": "sensor.luz"}) == []

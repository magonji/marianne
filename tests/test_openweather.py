import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from marianne.config import ConfigError, parse_config
from marianne.sources import build_source
from marianne.sources.openweather import OpenWeatherSource, field_reading


def ts(day, hour):
    return int(datetime(2026, 10, day, hour, tzinfo=timezone.utc).timestamp())


def slot(day, hour, temp, condition, description, pop=0.0, rain=0.0, wind=3.0):
    data = {
        "dt": ts(day, hour),
        "main": {"temp": temp, "temp_min": temp - 1, "temp_max": temp + 1},
        "weather": [{"id": condition, "description": description}],
        "pop": pop,
        "wind": {"speed": wind},
    }
    if rain:
        data["rain"] = {"3h": rain}
    return data


# Glasgow in October: UTC+1.
FORECAST = {
    "city": {"name": "Glasgow", "timezone": 3600},
    "list": [
        slot(19, 9, 9.0, 803, "nubes rotas"),
        slot(19, 12, 11.0, 500, "lluvia ligera", pop=0.6, rain=1.2, wind=5.0),
        slot(19, 15, 12.5, 501, "lluvia moderada", pop=0.9, rain=3.4, wind=7.5),
        slot(19, 18, 10.0, 800, "cielo claro", wind=4.0),
        slot(19, 21, 8.0, 800, "cielo claro"),
        slot(20, 0, 6.0, 800, "cielo claro"),
    ],
}
NOW = datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc)


def read(field, **options):
    return field_reading({"field": field, **options}, FORECAST, NOW)


def test_today_summary_picks_the_worst_condition():
    assert read("summary").value == "☂ LLUVIA MODERADA"


def test_today_numbers_ignore_past_slots():
    assert (read("max").value, read("max").unit) == ("13.5", "°C")
    assert read("min").value == "7.0"  # 21:00 UTC is 22:00 in Glasgow, still today
    assert read("rain_probability").value == "90"
    assert read("rain").value == "4.6"
    assert (read("wind").value, read("wind").unit) == ("27", "km/h")


def test_rain_probability_bar_and_alert():
    reading = read("rain_probability", alert_above=80)
    assert reading.fraction == 0.9 and reading.alert


def test_next_hours_timeline_in_city_time():
    # At 14:00 in Glasgow the 13h slot is under way: the timeline starts with the next one.
    assert read("hours", count=3).value == "16h ☂ 12°  19h ☀ 10°  22h ☀ 8°"


def test_late_night_falls_back_to_next_24_hours():
    late = datetime(2026, 10, 19, 23, 30, tzinfo=timezone.utc)  # 00:30 in Glasgow
    assert field_reading({"field": "max"}, FORECAST, late).value == "7.0"


def test_fetch_uses_the_api_and_caches():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.url.params["q"] == "Glasgow,GB" and request.url.params["units"] == "metric"
        return httpx.Response(200, json=FORECAST)

    source = OpenWeatherSource("ow", "key", "Glasgow,GB", transport=httpx.MockTransport(handler))
    asyncio.run(source.fetch([{"field": "summary"}]))
    asyncio.run(source.fetch([{"field": "max"}]))
    assert len(calls) == 1 and source.ok


def test_invalid_key_gives_a_clear_error():
    source = OpenWeatherSource(
        "ow", "bad", "Glasgow,GB", transport=httpx.MockTransport(lambda r: httpx.Response(401, json={}))
    )
    with pytest.raises(RuntimeError, match="api_key"):
        asyncio.run(source.fetch([{"field": "max"}]))
    assert source.ok is False


def test_config_checks_fields_and_missing_key(monkeypatch):
    sources = {"tiempo": {"type": "openweather"}}
    with pytest.raises(ConfigError, match="field"):
        parse_config({"sources": sources, "panels": [{"source": "tiempo", "items": [{"field": "nope"}]}]}, None)
    monkeypatch.delenv("OPENWEATHER_KEY", raising=False)
    with pytest.raises(ValueError, match="api_key"):
        build_source("tiempo", sources["tiempo"])


def tomorrow_forecast(*slots):
    return {"city": {"name": "Glasgow", "timezone": 3600}, "list": list(slots)}


# Tomorrow (20/10) 9:00-18:00 in Glasgow is 8:00-17:00 UTC: slots at 6 (7-10 local) to 15 UTC overlap it.
GOOD = [
    slot(20, 6, 9.0, 800, "cielo claro"),
    slot(20, 9, 12.0, 801, "algo de nubes"),
    slot(20, 12, 15.0, 800, "cielo claro", pop=0.1),
    slot(20, 15, 14.0, 803, "nubes rotas"),
]


def good(*slots, **options):
    return field_reading({"field": "good_day", **options}, tomorrow_forecast(*slots), NOW)


def test_good_day_tomorrow():
    reading = good(*GOOD, slot(20, 18, 11.0, 501, "lluvia", pop=1.0, rain=5))  # after 18:00: ignored
    assert (reading.value, reading.switch) == ("BUEN DÍA", True)
    assert reading.notice == "☀ Mañana buen día de 9 a 18 h: soleado, sin lluvia ni viento · máx 16 °C"


def test_not_a_good_day_says_why():
    rainy = good(*GOOD[:3], slot(20, 15, 14.0, 500, "lluvia ligera", pop=0.6, rain=0.8))
    assert (rainy.value, rainy.switch, rainy.notice) == ("LLUVIA 60 %", False, None)
    windy = good(*GOOD[:3], slot(20, 15, 14.0, 800, "cielo claro", wind=8.0))
    assert windy.value == "VIENTO 29 km/h"
    cloudy = good(*[slot(20, h, 12.0, 804, "nublado") for h in (6, 9, 12)], GOOD[3])
    assert cloudy.value == "NUBLADO"


def test_good_day_thresholds_are_configurable():
    windy = [*GOOD[:3], slot(20, 15, 14.0, 800, "cielo claro", wind=8.0)]
    assert good(*windy, max_wind=30).switch is True


def test_current_temperature_with_max_and_min_beside():
    current = {"main": {"temp": 14.2}}
    reading = field_reading({"field": "now"}, FORECAST, NOW, current)
    assert (reading.label, reading.value, reading.unit) == ("Ahora", "14.2", "°C")
    # The current temperature counts for today's max and min.
    assert field_reading({"field": "max"}, FORECAST, NOW, current).value == "14.2"
    assert field_reading({"field": "now"}, FORECAST, NOW, {}).error


def test_also_takes_fields_and_short_labels():
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/weather"):
            return httpx.Response(200, json={"main": {"temp": 10.0}})
        return httpx.Response(200, json=FORECAST)

    data = {"sources": {"tiempo": {"type": "openweather"}},
            "panels": [{"source": "tiempo", "items": [{"field": "now", "also": ["max", "min"]}]}]}
    item = parse_config(data, None).panels[0].items[0]
    assert item["also"] == [{"field": "max"}, {"field": "min"}]
    source = OpenWeatherSource("tiempo", "key", "Glasgow,GB", transport=httpx.MockTransport(handler))
    reading = asyncio.run(source.fetch([item]))[0]
    assert [extra.label for extra in reading.extra] == ["▲", "▼"]
    assert sorted(calls) == ["/data/2.5/forecast", "/data/2.5/weather"]


def test_also_fields_are_checked():
    data = {"sources": {"tiempo": {"type": "openweather"}},
            "panels": [{"source": "tiempo", "items": [{"field": "now", "also": ["maxima"]}]}]}
    with pytest.raises(ConfigError, match="field"):
        parse_config(data, None)


def test_current_weather_drawing():
    from marianne.sources.openweather import ICONS, drawing

    assert drawing({"id": 800, "icon": "01d"}) == ICONS["sun"]
    assert drawing({"id": 800, "icon": "01n"}) == ICONS["moon"]
    assert drawing({"id": 802, "icon": "03d"}) == ICONS["partly_sun"]
    assert drawing({"id": 501, "icon": "10d"}) == ICONS["rain"]
    assert drawing({"id": 211, "icon": "11d"}) == ICONS["storm"]
    assert all(len(icon) == 3 and len({len(line) for line in icon}) == 1 for icon in ICONS.values())
    reading = field_reading({"field": "now"}, FORECAST, NOW, {"main": {"temp": 5.0}, "weather": [{"id": 601, "icon": "13d"}]})
    assert reading.art == ICONS["snow"]


def test_next_rain():
    assert read("next_rain").value == "☂ AHORA · 60 %"
    # With a higher bar, the 15:00 UTC slot (16h in Glasgow) is the next one.
    assert read("next_rain", min_probability=70).value == "☂ hoy 16h · 90 %"
    assert read("next_rain", min_probability=95).value == "NO PREVISTA"
    later = datetime(2026, 10, 18, 20, 0, tzinfo=timezone.utc)
    reading = field_reading({"field": "next_rain"}, FORECAST, later)
    assert (reading.label, reading.value) == ("Próxima lluvia", "☂ mañana 13h · 60 %")


def test_chart_observed_hours_then_forecast(tmp_path):
    from marianne.sources.openweather import WeatherHistory, chart_day, chart_reading

    utc = timezone.utc
    day = datetime(2026, 10, 24, tzinfo=utc)
    now = day + timedelta(hours=13, minutes=20)
    history = WeatherHistory(tmp_path / "tiempo.json")
    # Observed every 20 min from 10:00: -1 °C then warmer, and 2 mm/h of rain at 11.
    for minutes in range(0, 200, 20):
        t = day + timedelta(hours=10, minutes=minutes)
        rain = {"1h": 2.0} if t.hour == 11 else {}
        history.add({"dt": int(t.timestamp()), "main": {"temp": -1 + minutes / 40}, "wind": {"speed": 5},
                     "clouds": {"all": 40}, "rain": rain})
    history.add({"dt": int((day + timedelta(hours=10)).timestamp()), "main": {"temp": 99}})  # repeated: ignored
    assert len(WeatherHistory(tmp_path / "tiempo.json").samples) == 10  # kept in the file

    slot = lambda hour, temp, rain=0.0, pop=0.0: {
        "dt": int((day + timedelta(hours=hour)).timestamp()), "main": {"temp": temp}, "wind": {"speed": 10},
        "clouds": {"all": 80}, "pop": pop, **({"rain": {"3h": rain}} if rain else {})}
    forecast = {"city": {"timezone": 0}, "list": [slot(12, 3), slot(15, 2, rain=15, pop=0.8), slot(18, -2), slot(24, -4)]}

    today = chart_day(day.date(), forecast, history.samples, now, utc)
    observed = [point for point in today["points"] if point["observed"]]
    forecasted = [point for point in today["points"] if not point["observed"]]
    assert [int((p["t"] - today["start"]) // 3600) for p in observed] == [10, 11, 12, 13]
    assert observed[0]["temp"] == pytest.approx(-0.5) and observed[0]["wind"] == pytest.approx(18)
    # Only the forecast still to come, up to the slot after midnight so the line reaches the edge
    assert [int((p["t"] - today["start"]) // 3600) for p in forecasted] == [15, 18, 24]
    rain = {(int((b["from"] - today["start"]) // 3600), b["observed"]): b for b in today["bars"]}
    assert rain[(11, True)]["rain"] == pytest.approx(2.0) and rain[(11, True)]["pop"] == 1.0
    assert rain[(15, False)]["rain"] == pytest.approx(5.0) and rain[(15, False)]["pop"] == 0.8
    assert today["pop"] == pytest.approx(80) and today["min"] == pytest.approx(-2)

    reading = chart_reading({"field": "chart"}, "El tiempo", forecast, now, {"main": {"temp": 2.5}}, history.samples)
    assert reading.chart["key"] == "d" and reading.chart["heavy_rain"] == 4.0 and reading.chart["temp"] == 2.5
    assert [day["date"] for day in reading.chart["days"]] == ["2026-10-24", "2026-10-25"]

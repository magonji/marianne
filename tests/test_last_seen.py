import asyncio

import httpx

from marianne.sources import homeassistant
from marianne.sources.homeassistant import HomeAssistantSource, device

STATION = "sensor.0x00158d0000000001_temperature"
POT = "sensor.0xa4c1380000000002_soil_moisture"


def test_device_by_zigbee_address():
    assert device(STATION) == "0x00158d0000000001"
    assert device(POT) == device("sensor.0xa4c1380000000002_battery") == "0xa4c1380000000002"
    assert device("sensor.salon_temperature") == "salon"


def test_a_panel_polled_often_doesnt_keep_another_device_out_of_date(monkeypatch):
    """The station was down (no change in the history), then came back. Meanwhile the pot's panel,
    polled every few seconds, looks up its own device: the station must be looked up again too."""
    clock = [1000.0]
    monkeypatch.setattr(homeassistant.time, "monotonic", lambda: clock[0])
    station_back = [False]

    def series(entity, values):
        return [{"entity_id": entity, "state": values[0], "last_changed": "2026-10-23T10:00:00+00:00"},
                *({"state": value, "last_changed": f"2026-10-30T2{i}:00:00+00:00"} for i, value in enumerate(values[1:]))]

    def handler(request: httpx.Request) -> httpx.Response:
        wanted = request.url.params["filter_entity_id"].split(",")
        answer = []
        if STATION in wanted:
            answer.append(series(STATION, ["6.0", "20.0", "20.5"] if station_back[0] else ["6.0"]))
        if POT in wanted:
            answer.append(series(POT, ["40", "41"]))
        return httpx.Response(200, json=answer)

    source = HomeAssistantSource("ha", "http://ha.test", token="x", transport=httpx.MockTransport(handler))
    states = {STATION: {}, POT: {}}
    station = [{"entity": STATION, "stale_after": 120}]
    pot = [{"entity": POT, "stale_after": 360}]

    async def run():
        seen = await source._last_seen(station, states)
        assert seen[device(STATION)].year == 1  # no change at all: down
        station_back[0] = True
        # The pot's panel, every few seconds for more than the cache time
        for _ in range(80):
            clock[0] += 5
            await source._last_seen(pot, states)
        seen = await source._last_seen(station, states)
        assert seen[device(STATION)].isoformat() == "2026-10-30T21:00:00+00:00"

    asyncio.run(run())

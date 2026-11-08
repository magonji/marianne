import asyncio

import httpx

from marianne.sources.homeassistant import HomeAssistantSource

STATES = [
    {"entity_id": "sensor.plug_power", "state": "2055", "attributes": {"unit_of_measurement": "W"}},
    {"entity_id": "sensor.plug_energy", "state": "3.85", "attributes": {"unit_of_measurement": "kWh"}},
    {"entity_id": "sensor.reset_energy", "state": "0.4", "attributes": {"unit_of_measurement": "kWh"}},
    {"entity_id": "sensor.idle_power", "state": "2", "attributes": {"unit_of_measurement": "W"}},
]


def source(history_calls):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/api/history/period"):
            history_calls.append(request.url.params["filter_entity_id"])
            # At midnight: 3.00 and 5.0 (this one was reset during the day)
            return httpx.Response(200, json=[
                [{"entity_id": "sensor.plug_energy", "state": "unknown"}, {"state": "3.00"}, {"state": "3.5"}],
                [{"entity_id": "sensor.reset_energy", "state": "5.0"}, {"state": "0.1"}],
            ])
        return httpx.Response(200, json=STATES)

    return HomeAssistantSource("ha", "http://ha.test", token="x", transport=httpx.MockTransport(handler))


def test_today_and_on_above():
    calls = []
    ha = source(calls)
    items = [
        {"entity": "sensor.plug_power", "name": "Lavavajillas", "decimals": 0, "on_above": 10,
         "also": [{"entity": "sensor.plug_energy", "decimals": 2, "today": True}]},
        {"entity": "sensor.reset_energy", "name": "Reiniciado", "decimals": 1, "today": True},
        {"entity": "sensor.idle_power", "name": "Parado", "on_above": 10},
    ]
    dishwasher, reset, idle = asyncio.run(ha.fetch(items))
    assert (dishwasher.value, dishwasher.switch) == ("2055", True)
    assert (dishwasher.extra[0].value, dishwasher.extra[0].unit) == ("0.85", "kWh")  # 3.85 - 3.00
    assert reset.value == "0.4"  # reset during the day: all it reads
    assert idle.switch is False
    # The midnight values are asked for once a day
    asyncio.run(ha.fetch(items))
    assert len(calls) == 1

import asyncio
import json

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import ConfigError, parse_config
from marianne.server import Dashboard, make_app
from marianne.sources.homeassistant import HomeAssistantSource

PLAN = {"size": [10, 10], "rooms": [{"name": "Salón", "rect": [0, 0, 10, 10], "lights": [8, 2]}]}
STATES = [{"entity_id": "light.lampara", "state": "on", "attributes": {}},
          {"entity_id": "switch.techo", "state": "off", "attributes": {}},
          {"entity_id": "sensor.t", "state": "20", "attributes": {}}]


def config(items):
    return parse_config({"boot": False, "sources": {"homeassistant": {"url": "http://ha.test", "token": "x"}},
                         "panels": [{"title": "Casa", "plan": PLAN, "items": items}]}, None)


def test_a_light_goes_in_a_room_of_the_plan():
    with pytest.raises(ConfigError):
        config([{"entity": "light.lampara", "light": "Garaje"}])
    assert config([{"entity": "light.lampara", "light": "Salón"}]).panels[0].plan["rooms"][0]["lights"] == [8.0, 2.0]


def test_lights_are_switched_by_their_place_among_the_lights():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            calls.append((request.url.path, json.loads(request.content)))
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=STATES)

    board = Dashboard(config([{"entity": "sensor.t", "room": "Salón"},
                              {"entity": "light.lampara", "light": "Salón"},
                              {"entity": "switch.techo", "light": "Salón"}]), demo=False)
    board.sources["homeassistant"] = HomeAssistantSource("homeassistant", "http://ha.test", token="x",
                                                         transport=httpx.MockTransport(handler))

    async def run():
        async with TestClient(TestServer(make_app(board))) as client:
            await board.reload()
            lights = [r for r in board.state()["panels"][0][0]["readings"] if r["light"]]
            assert [(r["light"], r["switch"]) for r in lights] == [("Salón", True), ("Salón", False)]
            assert (await client.post("/api/light/0/1")).status == 200
            assert calls == [("/api/services/homeassistant/toggle", {"entity_id": "switch.techo"})]
            for path in ("/api/light/0/2", "/api/light/9/0", "/api/light/0/x"):
                assert (await client.post(path)).status == 404
            assert len(calls) == 1

    asyncio.run(run())

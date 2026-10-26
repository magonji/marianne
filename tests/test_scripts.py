import asyncio

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import ConfigError, parse_config
from marianne.server import Dashboard, make_app
from marianne.sources.homeassistant import HomeAssistantSource

STATES = [{"entity_id": "script.luces", "state": "off", "attributes": {"friendly_name": "Casa Apagar luces"}}]


def config(items):
    return parse_config({"boot": False, "sources": {"homeassistant": {"url": "http://ha.test", "token": "x"}},
                         "panels": [{"title": "Salón", "items": ["sensor.t"]},
                                    {"title": "Acciones", "key": "o", "actions": True, "items": items}]}, None)


def test_scripts_must_be_scripts():
    with pytest.raises(ConfigError):
        config([{"script": "light.salon", "name": "Encender"}])


def test_buttons_run_only_the_scripts_of_the_config():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            calls.append((request.url.path, request.content))
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=STATES)

    dashboard = Dashboard(config([{"script": "script.luces", "icon": "mdi:lightbulb-off"},
                                  {"script": "script.no_hay", "name": "Nada"}]), demo=False)
    dashboard.sources["homeassistant"] = HomeAssistantSource("homeassistant", "http://ha.test", token="x",
                                                             transport=httpx.MockTransport(handler))

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            layout = await (await client.get("/api/layout")).json()
            assert layout["panels"][1]["actions"] is True
            assert "script.luces" not in str(layout)
            await dashboard.reload()
            luces, nada = dashboard.state()["panels"][1][0]["readings"]
            assert (luces["label"], luces["icon"], luces["switch"]) == ("Casa Apagar luces", "mdi:lightbulb-off", False)
            assert nada["error"] and nada["label"] == "Nada"

            assert (await client.post("/api/script/1/0")).status == 200
            assert calls == [("/api/services/script/turn_on", b'{"entity_id":"script.luces"}')]
            # Not a button, or not there: nothing is run
            for path in ("/api/script/0/0", "/api/script/1/5", "/api/script/9/0", "/api/script/x/0"):
                assert (await client.post(path)).status == 404
            assert (await client.get("/api/script/1/0")).status == 405
            assert len(calls) == 1

    asyncio.run(run())

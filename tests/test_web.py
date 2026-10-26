import asyncio
import yaml
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import parse_config
from marianne.server import Dashboard, make_app


def dashboard() -> Dashboard:
    data = {
        "boot": False,
        "sources": {"homeassistant": {"type": "homeassistant", "token": "secreto", "url": "http://casa:8123"},
                    "pomodoro": {"type": "pomodoro", "work": 0.01}},
        "panels": [
            {"title": "Casa", "items": [{"entity": "sensor.temperatura", "alert_below": 1000}]},
            {"title": "Móvil", "page_key": "m", "pages": [
                {"name": "Móvil", "items": ["sensor.bateria"]},
                {"name": "Tableta", "items": ["sensor.bateria_tableta", "sensor.pasos"]},
            ]},
            {"title": "Pomodoro", "source": "pomodoro", "items": [{"field": "timer"}]},
        ],
    }
    return Dashboard(parse_config(data, None), demo=True)


def test_layout_state_and_pomodoro_over_http():
    async def run():
        async with TestClient(TestServer(make_app(dashboard()))) as client:
            layout = await (await client.get("/api/layout")).json()
            assert [panel["pages"] for panel in layout["panels"]] == [["Casa"], ["Móvil", "Tableta"], ["Pomodoro"]]
            assert "secreto" not in str(layout) and "casa:8123" not in str(layout)
            await asyncio.sleep(0.6)  # the demo source takes up to 0.4 s
            state = await (await client.get("/api/state")).json()
            casa, movil, _ = state["panels"]
            assert casa[0]["readings"][0]["alert"] and casa[0]["updated"]
            assert [len(page["readings"]) for page in movil] == [1, 2]
            assert state["pomodoro"]["active"] is False

            state = await (await client.post("/api/pomodoro/pomodoro/toggle")).json()
            assert state["pomodoro"]["running"] and state["pomodoro"]["active"]
            await asyncio.sleep(1.5)  # 0.6 s of work: it ends and rings once
            state = await (await client.get("/api/state")).json()
            assert state["rings"] == 1 and state["pomodoro"]["label"] == "Descanso corto"
            assert (await client.post("/api/pomodoro/nada/toggle")).status == 404
            assert "marianne" in (await (await client.get("/")).text()).lower()

    asyncio.run(run())


def test_the_page_and_its_files_are_revalidated():
    async def run():
        async with TestClient(TestServer(make_app(dashboard()))) as client:
            for path in ("/", "/static/app.js", "/static/style.css"):
                response = await client.get(path)
                assert response.headers["Cache-Control"] == "no-cache", path
            assert "Cache-Control" not in (await client.get("/api/layout")).headers

    asyncio.run(run())

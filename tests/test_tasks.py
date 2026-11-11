import asyncio
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import ConfigError, parse_config
from marianne.server import Dashboard, make_app


def config(folder, items):
    return parse_config({"boot": False, "sources": {"tareas": {"type": "tasks", "folder": str(folder)}},
                         "panels": [{"title": "Acciones", "key": "o", "actions": True, "source": "tareas",
                                     "items": items}]}, None)


def test_tasks_need_a_plain_name(tmp_path):
    for name in ("", "../etc", "Actualizar todo", "a;rm"):
        with pytest.raises(ConfigError):
            config(tmp_path, [{"task": name}])


def test_a_button_leaves_the_request_and_shows_how_it_went(tmp_path):
    folder = tmp_path / "tareas"
    dashboard = Dashboard(config(folder, [{"task": "actualizar", "name": "Actualizar", "icon": "mdi:docker"}]), demo=False)

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            await dashboard.reload()
            (button,) = dashboard.state()["panels"][0][0]["readings"]
            assert (button["label"], button["switch"], button["note"]) == ("Actualizar", False, "")

            answer = await client.post("/api/script/0/0")
            assert answer.status == 200 and (await answer.json())["done"] == "task"
            assert (folder / "actualizar.request").exists()
            (button,) = (await answer.json())["panels"][0][0]["readings"]
            assert button["switch"] is True
            # Once only: not again while it waits or runs
            assert (await client.post("/api/script/0/0")).status == 409

            # The server takes it, runs it and says how it went
            (folder / "actualizar.request").unlink()
            (folder / "actualizar.status").write_text(json.dumps({"state": "running", "at": "2026-11-11T10:00:00+00:00"}))
            await dashboard.reload()
            assert dashboard.state()["panels"][0][0]["readings"][0]["switch"] is True
            assert (await client.post("/api/script/0/0")).status == 409
            (folder / "actualizar.status").write_text(json.dumps({"state": "error", "at": "2026-11-09T10:02:00+00:00"}))
            await dashboard.reload()
            (button,) = dashboard.state()["panels"][0][0]["readings"]
            assert button["switch"] is False and button["value"] == "error" and button["note"].startswith("falló 09/11")
            # And it can be asked for again
            assert (await client.post("/api/script/0/0")).status == 200

    asyncio.run(run())

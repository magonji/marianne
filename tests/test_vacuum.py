import asyncio
import json
from datetime import datetime, timedelta, timezone

import io

import httpx
import pytest
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import ConfigError, parse_config
from marianne.server import Dashboard, make_app
from PIL import Image

from marianne.sources.homeassistant import HomeAssistantSource, read_vacuum_map

PATH = (147, 194, 238, 255)


def robot_map() -> bytes:
    """A map 200 × 300: transparent, a room in a close light blue, and the path across it."""
    image = Image.new("RGBA", (200, 300), (0, 0, 0, 0))
    for x in range(20, 120):
        for y in range(40, 200):
            image.putpixel((x, y), (133, 193, 233, 255))
    for x in range(30, 100):
        image.putpixel((x, 100), PATH)
    for x in range(60, 70):  # the robot, a white dot
        for y in range(150, 160):
            image.putpixel((x, y), (255, 255, 255, 255))
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()

NOW = datetime.now(timezone.utc)
STATES = [
    {"entity_id": "vacuum.robot", "state": "cleaning", "attributes": {}, "last_changed": (NOW - timedelta(minutes=20)).isoformat()},
    {"entity_id": "sensor.robot_room", "state": "Hall", "attributes": {}},
    {"entity_id": "binary_sensor.robot_charging", "state": "on", "attributes": {}},
    {"entity_id": "sensor.robot_error", "state": "none", "attributes": {}},
    {"entity_id": "sensor.robot_error2", "state": "wheels_jammed", "attributes": {},
     "last_changed": (NOW - timedelta(minutes=1)).isoformat()},
    {"entity_id": "sensor.robot_last_end", "state": (NOW - timedelta(minutes=5)).isoformat(), "attributes": {"device_class": "timestamp"}},
    {"entity_id": "sensor.robot_area", "state": "38.2", "attributes": {"unit_of_measurement": "m²"}},
]


def config(panels):
    return parse_config({"boot": False, "sources": {"homeassistant": {"url": "http://ha.test", "token": "x"}}, "panels": panels}, None)


def dashboard(panels, calls):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            calls.append((request.url.path, json.loads(request.content)))
            return httpx.Response(200, json=[])
        if request.url.path.startswith("/api/history/period"):
            return httpx.Response(200, json=[[{"entity_id": "sensor.robot_room", "state": "Salón"},
                                              {"state": "Hall"}, {"state": "unavailable"}, {"state": "Salón"}]])
        if request.url.path.startswith("/api/image_proxy/"):
            return httpx.Response(200, content=robot_map(), headers={"content-type": "image/jpeg"})
        return httpx.Response(200, json=STATES)

    board = Dashboard(config(panels), demo=False)
    board.sources["homeassistant"] = HomeAssistantSource("homeassistant", "http://ha.test", token="x",
                                                         transport=httpx.MockTransport(handler))
    return board


PLAN = {"size": [10, 10], "rooms": [{"name": "Salón", "rect": [0, 0, 5, 10]}, {"name": "Vestíbulo", "rect": [5, 0, 5, 10]}],
        "map": {"entity": "image.robot_map", "box": [10, 20, 110, 220], "rotate": 90, "to": [0, 0, 10, 10]}}


def test_vacuum_rows_robot_and_map():
    panels = [
        {"title": "Aspiradora", "items": [
            {"entity": "sensor.robot_error", "name": "Problema", "map": {"none": "NINGUNO"}, "ok_states": ["none"]},
            {"entity": "sensor.robot_error2", "name": "Problema", "ok_states": ["none"], "alarm_after": 0, "alarm_text": "Atascada"},
            {"entity": "sensor.robot_last_end", "name": "Última", "format": "auto", "also": "sensor.robot_area",
             "notice_within": 30, "notice_text": "Limpieza terminada"}]},
        {"title": "Casa", "plan": PLAN, "items": [
            {"entity": "sensor.robot_room", "robot": "vacuum.robot", "charging": "binary_sensor.robot_charging", "map": {"Hall": "Vestíbulo"}}]},
    ]
    calls = []
    board = dashboard(panels, calls)

    async def run():
        async with TestClient(TestServer(make_app(board))) as client:
            await board.reload()
            fine, stuck, last = board.state()["panels"][0][0]["readings"]
            assert not fine["alert"] and stuck["alert"] and stuck["alarm"].startswith("Atascada · desde hace")
            assert last["notice"] == "Limpieza terminada · 38.2 m²"
            (robot,) = board.state()["panels"][1][0]["readings"]
            assert robot["value"] == "Vestíbulo"
            assert robot["robot"] == {"state": "cleaning", "rooms": ["Salón", "Vestíbulo"], "charging": True}
            layout = await (await client.get("/api/layout")).json()
            assert layout["panels"][1]["plan"]["map"]["rotate"] == 90
            picture = await client.get("/api/plan/1/map")
            assert picture.status == 200 and picture.content_type == "image/png"
            path = Image.open(io.BytesIO(await picture.read()))
            assert path.size == (100, 200)  # cut to the box
            spot = await (await client.get("/api/plan/1/robot")).json()
            assert spot == {"at": [65.0, 155.0]}  # in the whole picture's pixels
            assert (await client.get("/api/plan/0/map")).status == 404

    asyncio.run(run())


def test_vacuum_buttons_run_only_their_command():
    panels = [{"title": "Acciones", "actions": True, "items": [
        {"vacuum": "vacuum.robot", "command": "return_to_base", "name": "A la base"},
        {"vacuum": "vacuum.robot", "command": "clean_rooms", "rooms": [21, "22"], "name": "Cocina y salón"}]}]
    calls = []
    board = dashboard(panels, calls)

    async def run():
        async with TestClient(TestServer(make_app(board))) as client:
            await board.reload()
            buttons = board.state()["panels"][0][0]["readings"]
            assert [(b["label"], b["icon"]) for b in buttons] == [("A la base", "mdi:home-import-outline"),
                                                                ("Cocina y salón", "mdi:robot-vacuum")]
            assert (await client.post("/api/script/0/0")).status == 200
            assert (await client.post("/api/script/0/1")).status == 200
            assert calls == [
                ("/api/services/vacuum/return_to_base", {"entity_id": "vacuum.robot"}),
                ("/api/services/vacuum/send_command", {"entity_id": "vacuum.robot", "command": "app_segment_clean",
                                                       "params": [{"segments": [21, 22], "repeat": 1}]}),
            ]

    asyncio.run(run())


@pytest.mark.parametrize("item", [
    {"vacuum": "vacuum.robot", "command": "explode"},
    {"vacuum": "vacuum.robot", "command": "clean_rooms"},
])
def test_wrong_vacuum_buttons(item):
    with pytest.raises(ConfigError):
        config([{"title": "Acciones", "actions": True, "items": [item]}])


@pytest.mark.parametrize("map_", [
    {"entity": "sensor.robot", "box": [0, 0, 1, 1]},
    {"entity": "image.robot_map", "box": [0, 0, 1]},
    {"entity": "image.robot_map", "box": [0, 0, 1, 1], "rotate": 45},
])
def test_wrong_plan_maps(map_):
    with pytest.raises(ConfigError):
        config([{"title": "Casa", "plan": {**PLAN, "map": map_}, "items": []}])


def test_only_the_path_is_kept():
    content, where = read_vacuum_map(robot_map(), [0, 0, 200, 300], list(PATH[:3]))
    assert where == [65.0, 155.0]
    path = Image.open(io.BytesIO(content)).convert("RGBA")
    assert path.getpixel((60, 100))[3] == 255          # on the path
    assert path.getpixel((60, 102))[3] == 255          # a little thicker
    assert path.getpixel((60, 150))[3] == 0            # the room, a close blue: gone
    assert path.getpixel((150, 250))[3] == 0           # around the house

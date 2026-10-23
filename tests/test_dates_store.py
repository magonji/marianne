import asyncio
from datetime import date

import pytest
from aiohttp.test_utils import TestClient, TestServer

from marianne.config import parse_config
from marianne.server import Dashboard, make_app
from marianne.sources.dates import DatesSource, DateStore, clean_date


def test_clean_date_checks_what_the_page_sends():
    assert clean_date({"name": " Navidad ", "date": "12-25"}) == {"name": "Navidad", "date": "12-25", "soon": 7}
    # Read back from the file, yearly is kept, and only means something with a year
    assert clean_date({"name": "Cumple", "date": "1990-03-14", "yearly": True, "soon": "14"})["yearly"] is True
    assert "yearly" not in clean_date({"name": "Navidad", "date": "12-25", "yearly": True})
    # Saved from the page, it's decided by the date: gone by (a birthday) yearly, to come (a trip) once
    today = date(2026, 10, 23)
    assert clean_date({"name": "Cumple", "date": "1990-03-14"}, decide_yearly=True, today=today)["yearly"] is True
    assert "yearly" not in clean_date({"name": "Viaje", "date": "2026-12-02", "yearly": True},
                                      decide_yearly=True, today=today)
    assert "yearly" not in clean_date({"name": "Navidad", "date": "12-25"}, decide_yearly=True, today=today)
    assert clean_date({"name": "Bisiesto", "date": "02-29"})["date"] == "02-29"
    assert clean_date({"name": "Yaml", "date": date(2027, 1, 6)})["date"] == "2027-01-06"
    for wrong in ({"name": "", "date": "12-25"}, {"name": "x" * 61, "date": "12-25"},
                  {"name": "Mal", "date": "25/12"}, {"name": "Mal", "date": "02-30"},
                  {"name": "Mal", "date": "2027-02-29"}, {"name": "Mal", "date": "12-25", "soon": 400},
                  {"name": "Mal", "date": "12-25", "soon": "pronto"}, "no es un diccionario"):
        with pytest.raises(ValueError):
            clean_date(wrong)


def test_store_add_update_delete(tmp_path):
    store = DateStore(tmp_path / "data" / "fechas.yaml")
    assert store.load() == []
    (navidad,) = store.add({"name": "Navidad", "date": "12-25"})
    store.add({"name": "Viaje", "date": "2026-12-02"})
    store.update(navidad["id"], {"name": "Nochebuena", "date": "12-24", "soon": 3})
    names = [(entry["name"], entry["date"], entry["soon"]) for entry in store.load()]
    assert names == [("Nochebuena", "12-24", 3), ("Viaje", "2026-12-02", 7)]
    assert [entry["name"] for entry in store.delete(navidad["id"])] == ["Viaje"]
    with pytest.raises(KeyError):
        store.delete("no-existe")
    # Only the file is left behind, no temporary ones
    assert [path.name for path in (tmp_path / "data").iterdir()] == ["fechas.yaml"]


def test_stored_dates_join_the_panel(tmp_path):
    store = DateStore(tmp_path / "fechas.yaml")
    store.add({"name": "Navidad", "date": "12-25"})
    source = DatesSource("fechas", file=str(store.path))
    readings = asyncio.run(source.fetch([{"progress": "day"}, {"name": "De config", "date": "01-06"}]))
    assert readings[0].label == "Día"
    assert {reading.label for reading in readings[1:]} == {"Navidad", "De config"}

    (tmp_path / "fechas.yaml").write_text("esto: no es una lista\n")
    readings = asyncio.run(source.fetch([{"progress": "day"}]))
    assert readings[-1].error and readings[-1].label == "fechas.yaml"


def test_dates_api(tmp_path):
    data = {"boot": False, "sources": {"fechas": {"type": "dates", "file": str(tmp_path / "fechas.yaml")}},
            "panels": [{"title": "Fechas", "source": "fechas", "items": [{"progress": "day"}]}]}
    dashboard = Dashboard(parse_config(data, None), demo=False)

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            layout = await (await client.get("/api/layout")).json()
            assert layout["date_editors"] == [{"name": "fechas", "key": "f"}]
            assert str(tmp_path) not in str(layout)

            response = await client.post("/api/dates/fechas", json={"name": "Navidad", "date": "12-25"})
            (navidad,) = (await response.json())["dates"]
            state = await (await client.get("/api/state")).json()
            assert [r["label"] for r in state["panels"][0][0]["readings"]] == ["Día", "Navidad"]

            response = await client.post("/api/dates/fechas", json={"name": "Mal", "date": "31-31"})
            assert response.status == 400 and "fecha" in (await response.json())["error"]

            response = await client.put(f"/api/dates/fechas/{navidad['id']}", json={"name": "Reyes", "date": "01-06"})
            assert [d["name"] for d in (await response.json())["dates"]] == ["Reyes"]
            assert (await client.delete(f"/api/dates/fechas/{navidad['id']}")).status == 200
            assert (await (await client.get("/api/dates/fechas")).json())["dates"] == []
            assert (await client.delete("/api/dates/fechas/nada")).status == 404
            assert (await client.get("/api/dates/otra")).status == 404

    asyncio.run(run())

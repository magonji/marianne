import pytest

from marianne.config import ConfigError, parse_config


def config(plan, items):
    return parse_config({"sources": {"homeassistant": {}},
                         "panels": [{"title": "Casa", "plan": plan, "items": items}]}, None)


PLAN = {"size": [10, 8], "rooms": [{"name": "Salón", "rect": [0, 0, 6, 8], "label": [3, 2]},
                                   {"name": "", "rect": [1, 4, 3, 2], "furniture": True},
                                   {"name": "Pasillo", "points": [[6, 0], [10, 0], [10, 8]]},
                                   {"name": "", "rect": [6, 6, 1, 1]}],
        "outside": [0, 8, 10, 2],
        "doors": [{"name": "Entrada", "from": [6, 4], "to": [6, 6], "swing": -1, "leaves": 2}]}


def test_plan_is_read_and_sent_with_the_layout():
    panel = config(PLAN, [{"entity": "sensor.t", "room": "Salón"}, {"entity": "sensor.f", "room": "fuera"}]).panels[0]
    assert panel.plan["size"] == [10.0, 8.0]
    assert panel.plan["rooms"][2] == {"name": "Pasillo", "points": [[6.0, 0.0], [10.0, 0.0], [10.0, 8.0]]}
    assert panel.plan["outside"] == [0.0, 8.0, 10.0, 2.0]
    assert panel.plan["doors"] == [{"name": "Entrada", "from": [6.0, 4.0], "to": [6.0, 6.0], "swing": -1, "leaves": 2}]
    door = config(PLAN, [{"entity": "binary_sensor.puerta", "door": "Entrada"}]).panels[0]
    assert door.items[0]["door"] == "Entrada"
    assert panel.plan["rooms"][0]["label"] == [3.0, 2.0] and panel.plan["rooms"][1]["furniture"] is True
    washer = config(PLAN, [{"entity": "sensor.lavadora", "appliance": {"kind": "washer", "at": [2, 7]}}]).panels[0]
    assert washer.items[0]["appliance"] == {"kind": "washer", "at": [2.0, 7.0]}


@pytest.mark.parametrize("plan, items", [
    (PLAN, [{"entity": "sensor.t", "room": "Cocina"}]),  # no such room
    ({**PLAN, "outside": None}, [{"entity": "sensor.t", "room": "fuera"}]),  # nowhere outside
    ({"size": [10], "rooms": []}, []),
    ({"size": [10, 8], "rooms": [{"name": "Salón"}]}, []),
    ({"size": [10, 8], "rooms": [{"name": "Salón", "rect": [0, 0, "x", 1]}]}, []),
    ({"size": [10, 8], "rooms": [{"name": "Salón", "points": [[0, 0], [1, 1]]}]}, []),
    (PLAN, [{"entity": "binary_sensor.puerta", "door": "Garaje"}]),  # no such door
    (PLAN, [{"entity": "sensor.lavadora", "appliance": {"kind": "nevera", "at": [2, 7]}}]),
    (PLAN, [{"entity": "sensor.lavadora", "appliance": {"kind": "washer"}}]),
    ({**PLAN, "doors": [{"name": "Entrada", "from": [0, 0], "to": [1, 1], "swing": 2}]}, []),
    ({**PLAN, "doors": [{"name": "Entrada", "from": [0, 0], "to": [1, 1], "leaves": 3}]}, []),
    ({**PLAN, "doors": [{"from": [0, 0], "to": [1, 1]}]}, []),
])
def test_wrong_plans(plan, items):
    with pytest.raises(ConfigError):
        config(plan, items)

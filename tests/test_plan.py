import pytest

from marianne.config import ConfigError, parse_config


def config(plan, items):
    return parse_config({"sources": {"homeassistant": {}},
                         "panels": [{"title": "Casa", "plan": plan, "items": items}]}, None)


PLAN = {"size": [10, 8], "rooms": [{"name": "Salón", "rect": [0, 0, 6, 8]},
                                   {"name": "Pasillo", "points": [[6, 0], [10, 0], [10, 8]]},
                                   {"name": "", "rect": [6, 6, 1, 1]}],
        "outside": [0, 8, 10, 2]}


def test_plan_is_read_and_sent_with_the_layout():
    panel = config(PLAN, [{"entity": "sensor.t", "room": "Salón"}, {"entity": "sensor.f", "room": "fuera"}]).panels[0]
    assert panel.plan["size"] == [10.0, 8.0]
    assert panel.plan["rooms"][1] == {"name": "Pasillo", "points": [[6.0, 0.0], [10.0, 0.0], [10.0, 8.0]]}
    assert panel.plan["outside"] == [0.0, 8.0, 10.0, 2.0]


@pytest.mark.parametrize("plan, items", [
    (PLAN, [{"entity": "sensor.t", "room": "Cocina"}]),  # no such room
    ({**PLAN, "outside": None}, [{"entity": "sensor.t", "room": "fuera"}]),  # nowhere outside
    ({"size": [10], "rooms": []}, []),
    ({"size": [10, 8], "rooms": [{"name": "Salón"}]}, []),
    ({"size": [10, 8], "rooms": [{"name": "Salón", "rect": [0, 0, "x", 1]}]}, []),
    ({"size": [10, 8], "rooms": [{"name": "Salón", "points": [[0, 0], [1, 1]]}]}, []),
])
def test_wrong_plans(plan, items):
    with pytest.raises(ConfigError):
        config(plan, items)

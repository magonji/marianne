from datetime import datetime, timezone

import pytest

from marianne.config import ConfigError, parse_config
from marianne.sources.moon import moon_reading, phases_around


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


@pytest.mark.parametrize(
    "known, fraction",
    [
        (utc(2024, 4, 8, 18, 21), 0.0),  # new Moon of the total solar eclipse
        (utc(2024, 9, 18, 2, 34), 0.5),  # full Moon of the partial lunar eclipse
        (utc(1977, 2, 18, 3, 37), 0.0),  # Meeus, example 49.a
    ],
)
def test_principal_phases_within_minutes(known, fraction):
    closest = min(phases_around(known), key=lambda phase: abs((phase[0] - known).total_seconds()))
    assert closest[1] == fraction
    assert abs((closest[0] - known).total_seconds()) < 5 * 60


def test_phase_names_and_illumination():
    assert moon_reading({"field": "phase"}, utc(2024, 9, 18, 6)).value == "○ LUNA LLENA 100 %"
    assert moon_reading({"field": "phase"}, utc(2024, 9, 22, 12)).value.startswith("○ GIBOSA MENGUANTE")
    assert moon_reading({"field": "phase"}, utc(2024, 4, 9, 0, 21)).value == "● LUNA NUEVA 0 %"
    assert moon_reading({"field": "phase"}, utc(2024, 4, 9, 18, 21)).value == "● CRECIENTE 1 %"


def test_next_phase_label_and_days():
    reading = moon_reading({"field": "next_phase"}, utc(2024, 9, 18, 6))
    # Last quarter: 2024-09-24 18:50 UTC.
    assert reading.label == "◑ Cuarto menguante"
    assert reading.value == "en 6 días · 24/09"


def test_items_can_use_their_own_source():
    sources = {"homeassistant": {}, "luna": {"type": "moon"}}
    panel = {"items": ["sun.sun", {"source": "luna", "field": "phase"}]}
    (parsed,) = parse_config({"sources": sources, "panels": [panel]}, None).panels
    assert [item["source"] for item in parsed.items] == ["homeassistant", "luna"]
    with pytest.raises(ConfigError, match="field"):
        parse_config({"sources": sources, "panels": [{"items": [{"source": "luna", "field": "x"}]}]}, None)

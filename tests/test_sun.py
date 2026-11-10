from datetime import date, datetime, timedelta, timezone

import pytest

from marianne.sun import crossings, daylight_minutes, day_curve, elevation, sun_path

GLASGOW = (55.86, -4.26)
UTC = timezone.utc


def test_elevation_at_noon_through_the_year():
    # The Sun's height at solar noon: 90 - latitude + declination (±23.44° at the solstices)
    highest = max(elevation(*GLASGOW, datetime(2026, 6, 21, 12, 17, tzinfo=UTC) + timedelta(minutes=m)) for m in range(-30, 31))
    lowest = max(elevation(*GLASGOW, datetime(2026, 12, 21, 12, 17, tzinfo=UTC) + timedelta(minutes=m)) for m in range(-30, 31))
    assert highest == pytest.approx(90 - 55.86 + 23.44, abs=0.3)
    assert lowest == pytest.approx(90 - 55.86 - 23.44, abs=0.3)
    assert elevation(*GLASGOW, datetime(2026, 6, 21, 0, 17, tzinfo=UTC)) < 0  # midnight


def test_daylight_lengths():
    summer = daylight_minutes(day_curve(*GLASGOW, date(2026, 6, 21), UTC))
    winter = daylight_minutes(day_curve(*GLASGOW, date(2026, 12, 21), UTC))
    assert summer == pytest.approx(17 * 60 + 35, abs=10)
    assert winter == pytest.approx(6 * 60 + 58, abs=10)


def test_sun_path_has_today_and_both_solstices():
    path = sun_path(*GLASGOW, datetime(2026, 10, 26, 13, 5, tzinfo=UTC))
    assert path["now"] == 13 * 60 + 5 and len(path["today"]) == 24 * 6 + 1
    top = lambda curve: max(e for _, e in curve)
    assert top(path["winter"]) < top(path["today"]) < top(path["summer"])
    assert path["light"] + path["dark"] == 24 * 60
    # In the south, the summer solstice is December's
    south = sun_path(-33.9, 18.4, datetime(2026, 10, 26, 12, tzinfo=UTC))
    assert top(south["summer"]) > top(south["winter"])


def test_the_moon_rises_and_sets_and_is_lit_by_its_phase():
    # Full Moon of 24 November 2026: all lit, rising around sunset and setting in the morning
    full = sun_path(*GLASGOW, datetime(2026, 11, 24, 15, 0, tzinfo=UTC))["moon"]
    assert full["lit"] > 0.99 and len(full["today"]) == 24 * 6 + 1
    assert 14 * 60 < full["rise"] < 16 * 60 and 7 * 60 < full["set"] < 9 * 60
    # The day after the new Moon of 9 November: a thin crescent, up in the day close to the Sun
    young = sun_path(*GLASGOW, datetime(2026, 11, 10, 12, 0, tzinfo=UTC))["moon"]
    assert young["lit"] < 0.05 and young["waxing"]
    assert young["rise"] < 12 * 60 < young["set"] and young["height"] > 0
    assert not sun_path(*GLASGOW, datetime(2026, 11, 30, 12, tzinfo=UTC))["moon"]["waxing"]


def test_venus_rises_before_the_sun_as_the_morning_star():
    # November 2026, Venus 25° west of the Sun: it rises over two hours before it
    path = sun_path(*GLASGOW, datetime(2026, 11, 10, 12, 0, tzinfo=UTC))
    venus_rise, _ = crossings(path["venus"]["today"])
    sun_rise, _ = crossings(path["today"])
    assert 90 < sun_rise - venus_rise < 200
    assert len(path["venus"]["today"]) == 24 * 6 + 1

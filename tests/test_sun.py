from datetime import date, datetime, timedelta, timezone

import pytest

from marianne.sun import daylight_minutes, day_curve, elevation, sun_path

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

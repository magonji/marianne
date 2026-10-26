"""The Sun diagram: its roles, and the Sun's height through a day, computed locally."""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta

ROLES = {"dawn", "rising", "noon", "setting", "dusk", "elevation", "azimuth"}
# The Sun's centre this far below the horizon (refraction and its radius) is sunrise and sunset.
HORIZON = -0.833
STEP_MINUTES = 10


def elevation(latitude: float, longitude: float, when: datetime) -> float:
    """The Sun's height in degrees over the horizon at a time, from the usual low-precision
    formulas (within a few tenths of a degree, plenty for a diagram)."""
    days = when.timestamp() / 86400 + 2440587.5 - 2451545.0
    mean_longitude = (280.460 + 0.9856474 * days) % 360
    anomaly = math.radians((357.528 + 0.9856003 * days) % 360)
    ecliptic = math.radians(mean_longitude + 1.915 * math.sin(anomaly) + 0.020 * math.sin(2 * anomaly))
    obliquity = math.radians(23.439 - 0.0000004 * days)
    declination = math.asin(math.sin(obliquity) * math.sin(ecliptic))
    right_ascension = math.atan2(math.cos(obliquity) * math.sin(ecliptic), math.cos(ecliptic))
    sidereal = math.radians(((18.697374558 + 24.06570982441908 * days) % 24) * 15 + longitude)
    hour_angle = sidereal - right_ascension
    lat = math.radians(latitude)
    return math.degrees(math.asin(math.sin(lat) * math.sin(declination)
                                  + math.cos(lat) * math.cos(declination) * math.cos(hour_angle)))


def day_curve(latitude: float, longitude: float, day: date, tz) -> list[list[float]]:
    """[minute of the local day, elevation] every STEP_MINUTES, from 00:00 to 24:00."""
    start = datetime(day.year, day.month, day.day, tzinfo=tz)
    return [[minute, round(elevation(latitude, longitude, start + timedelta(minutes=minute)), 2)]
            for minute in range(0, 24 * 60 + 1, STEP_MINUTES)]


def daylight_minutes(curve: list[list[float]]) -> float:
    """How long the Sun is up, from where the curve crosses the horizon."""
    total = 0.0
    for (m1, e1), (m2, e2) in zip(curve, curve[1:]):
        if e1 >= HORIZON and e2 >= HORIZON:
            total += m2 - m1
        elif (e1 >= HORIZON) != (e2 >= HORIZON):
            cross = m1 + (HORIZON - e1) * (m2 - m1) / (e2 - e1)
            total += (m2 - cross) if e2 >= HORIZON else (cross - m1)
    return total


def sun_path(latitude: float, longitude: float, now: datetime) -> dict:
    """Today's curve and those of the solstices (the year's highest and lowest), for the diagram."""
    tz = now.tzinfo
    today = day_curve(latitude, longitude, now.date(), tz)
    # The solstice the Sun is highest at, by hemisphere.
    june, december = date(now.year, 6, 21), date(now.year, 12, 21)
    summer, winter = (june, december) if latitude >= 0 else (december, june)
    light = daylight_minutes(today)
    return {
        "now": now.hour * 60 + now.minute,
        "today": today,
        "summer": day_curve(latitude, longitude, summer, tz),
        "winter": day_curve(latitude, longitude, winter, tz),
        "light": light,
        "dark": 24 * 60 - light,
    }

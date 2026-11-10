"""The Sun diagram: its roles, and the Sun's and the Moon's height through a day, computed locally."""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta

ROLES = {"dawn", "rising", "noon", "setting", "dusk", "elevation", "azimuth"}
# The Sun's centre this far below the horizon (refraction and its radius) is sunrise and sunset.
HORIZON = -0.833
STEP_MINUTES = 10
# The Moon's horizontal parallax, in degrees (it varies between 0.9 and 1.0).
MOON_PARALLAX = 0.95


def days_since_j2000(when: datetime) -> float:
    return when.timestamp() / 86400 + 2440587.5 - 2451545.0


def sun_longitude(days: float) -> float:
    """The Sun's ecliptic longitude in degrees (the usual low-precision formulas)."""
    mean_longitude = (280.460 + 0.9856474 * days) % 360
    anomaly = math.radians((357.528 + 0.9856003 * days) % 360)
    return (mean_longitude + 1.915 * math.sin(anomaly) + 0.020 * math.sin(2 * anomaly)) % 360


def moon_ecliptic(days: float) -> tuple[float, float]:
    """The Moon's geocentric ecliptic longitude and latitude in degrees, from the largest terms of its
    motion (within a few tenths of a degree)."""
    sin = lambda degrees: math.sin(math.radians(degrees))
    mean_longitude = 218.316 + 13.176396 * days
    anomaly = 134.963 + 13.064993 * days
    sun_anomaly = 357.529 + 0.98560028 * days
    elongation = 297.850 + 12.190749 * days
    node = 93.272 + 13.229350 * days
    longitude = (mean_longitude + 6.289 * sin(anomaly) + 1.274 * sin(2 * elongation - anomaly)
                 + 0.658 * sin(2 * elongation) + 0.214 * sin(2 * anomaly) - 0.186 * sin(sun_anomaly)
                 - 0.114 * sin(2 * node))
    latitude = (5.128 * sin(node) + 0.281 * sin(anomaly + node) + 0.278 * sin(anomaly - node)
                + 0.173 * sin(2 * elongation - node))
    return longitude % 360, latitude


def altitude(latitude: float, longitude: float, days: float, ecliptic_longitude: float,
             ecliptic_latitude: float = 0.0) -> float:
    """The height over the horizon, in degrees, of a point of the sky given on the ecliptic."""
    obliquity = math.radians(23.439 - 0.0000004 * days)
    lam, beta = math.radians(ecliptic_longitude), math.radians(ecliptic_latitude)
    declination = math.asin(math.sin(beta) * math.cos(obliquity)
                            + math.cos(beta) * math.sin(obliquity) * math.sin(lam))
    right_ascension = math.atan2(math.sin(lam) * math.cos(obliquity) - math.tan(beta) * math.sin(obliquity),
                                 math.cos(lam))
    sidereal = math.radians(((18.697374558 + 24.06570982441908 * days) % 24) * 15 + longitude)
    hour_angle = sidereal - right_ascension
    lat = math.radians(latitude)
    return math.degrees(math.asin(math.sin(lat) * math.sin(declination)
                                  + math.cos(lat) * math.cos(declination) * math.cos(hour_angle)))


def elevation(latitude: float, longitude: float, when: datetime) -> float:
    """The Sun's height in degrees over the horizon at a time, from the usual low-precision
    formulas (within a few tenths of a degree, plenty for a diagram)."""
    days = days_since_j2000(when)
    return altitude(latitude, longitude, days, sun_longitude(days))


def moon_elevation(latitude: float, longitude: float, when: datetime) -> float:
    """The Moon's height as seen from where we are: being so close, it looks up to a degree lower
    (its parallax) than from the Earth's centre."""
    days = days_since_j2000(when)
    height = altitude(latitude, longitude, days, *moon_ecliptic(days))
    return height - MOON_PARALLAX * math.cos(math.radians(height))


def moon_light(when: datetime) -> tuple[float, bool]:
    """How much of the Moon is lit (0 to 1) and whether it's waxing, from how far it is from the Sun."""
    days = days_since_j2000(when)
    apart = (moon_ecliptic(days)[0] - sun_longitude(days)) % 360
    return (1 - math.cos(math.radians(apart))) / 2, apart < 180


def day_curve(latitude: float, longitude: float, day: date, tz, height=elevation) -> list[list[float]]:
    """[minute of the local day, elevation] every STEP_MINUTES, from 00:00 to 24:00."""
    start = datetime(day.year, day.month, day.day, tzinfo=tz)
    return [[minute, round(height(latitude, longitude, start + timedelta(minutes=minute)), 2)]
            for minute in range(0, 24 * 60 + 1, STEP_MINUTES)]


def crossings(curve: list[list[float]]) -> tuple[float | None, float | None]:
    """The minutes at which the curve rises over the horizon and sets under it, if it does today."""
    rise = set_ = None
    for (m1, e1), (m2, e2) in zip(curve, curve[1:]):
        if (e1 >= HORIZON) != (e2 >= HORIZON):
            cross = round(m1 + (HORIZON - e1) * (m2 - m1) / (e2 - e1), 1)
            if e2 >= HORIZON:
                rise = cross if rise is None else rise
            else:
                set_ = cross if set_ is None else set_
    return rise, set_


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
        "moon": moon_path(latitude, longitude, now),
    }


def moon_path(latitude: float, longitude: float, now: datetime) -> dict:
    """The Moon's curve today, where it is now, when it rises and sets, and how much of it is lit."""
    curve = day_curve(latitude, longitude, now.date(), now.tzinfo, moon_elevation)
    rise, set_ = crossings(curve)
    lit, waxing = moon_light(now)
    return {"today": curve, "height": round(moon_elevation(latitude, longitude, now), 2), "rise": rise, "set": set_,
            "lit": round(lit, 3), "waxing": waxing}

"""Moon phases computed locally (Jean Meeus, Astronomical Algorithms, ch. 49), and where Venus is
around the Sun: no API needed."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .base import Reading, Source

SYNODIC_MONTH = 29.530588861
# Principal phases by the fraction of the lunation at which they happen.
PRINCIPAL = {0.0: "Luna nueva", 0.25: "Cuarto creciente", 0.5: "Luna llena", 0.75: "Cuarto menguante"}
# Phase between two principal ones, named after the one it comes from.
BETWEEN = {0.0: "Creciente", 0.25: "Gibosa creciente", 0.5: "Gibosa menguante", 0.75: "Menguante"}
# Single-width symbols, as seen from the northern hemisphere.
SYMBOLS = {0.0: "●", 0.25: "◐", 0.5: "○", 0.75: "◑"}
# Within this many hours of a principal phase, the Moon is "at" it.
AT_PHASE_HOURS = 12

FIELDS = {"phase", "next_phase", "venus"}

# Orbits (J2000 and their change per century, from JPL's approximate elements): semi-major axis in
# AU, eccentricity, mean longitude and longitude of the perihelion in degrees.
ORBITS = {
    "venus": (0.72333566, 0.00677672, (181.97909950, 58517.81538729), (131.60246718, 0.00268329)),
    "earth": (1.00000261, 0.01671123, (100.46457166, 35999.37244981), (102.93768193, 0.32327364)),
}
# Closer to the Sun than this, Venus is lost in its glare.
VENUS_HIDDEN_BELOW = 10


class MoonSource(Source):
    kind = "moon"
    remote = False

    def describe(self) -> str:
        return "cálculo local"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        self.mark_ok()
        now = datetime.now(timezone.utc)
        return [venus_reading(item, now) if item["field"] == "venus" else moon_reading(item, now) for item in items]


def phase_time(k: float) -> datetime:
    """Time of the principal phase k (integer: new Moon, +0.25 first quarter, +0.5 full, +0.75 last quarter)."""
    t = k / 1236.85
    jde = 2451550.09766 + SYNODIC_MONTH * k + 0.00015437 * t**2 - 0.000000150 * t**3 + 0.00000000073 * t**4
    e = 1 - 0.002516 * t - 0.0000074 * t**2
    m = math.radians(2.5534 + 29.10535670 * k - 0.0000014 * t**2 - 0.00000011 * t**3)
    mp = math.radians(201.5643 + 385.81693528 * k + 0.0107582 * t**2 + 0.00001238 * t**3 - 0.000000058 * t**4)
    f = math.radians(160.7108 + 390.67050284 * k - 0.0016118 * t**2 - 0.00000227 * t**3 + 0.000000011 * t**4)

    fraction = round(k % 1, 2)
    if fraction in (0.0, 0.5):
        new = fraction == 0.0
        jde += (
            (-0.40720 if new else -0.40614) * math.sin(mp)
            + (0.17241 if new else 0.17302) * e * math.sin(m)
            + (0.01608 if new else 0.01614) * math.sin(2 * mp)
            + (0.01039 if new else 0.01043) * math.sin(2 * f)
            + (0.00739 if new else 0.00734) * e * math.sin(mp - m)
            - (0.00514 if new else 0.00515) * e * math.sin(mp + m)
            + (0.00208 if new else 0.00209) * e**2 * math.sin(2 * m)
            - 0.00111 * math.sin(mp - 2 * f)
            - 0.00057 * math.sin(mp + 2 * f)
            + 0.00056 * e * math.sin(2 * mp + m)
            - 0.00042 * math.sin(3 * mp)
        )
    else:
        jde += (
            -0.62801 * math.sin(mp)
            + 0.17172 * e * math.sin(m)
            - 0.01183 * e * math.sin(mp + m)
            + 0.00862 * math.sin(2 * mp)
            + 0.00804 * math.sin(2 * f)
            + 0.00454 * e * math.sin(mp - m)
            + 0.00204 * e**2 * math.sin(2 * m)
            - 0.00180 * math.sin(mp - 2 * f)
            - 0.00070 * math.sin(mp + 2 * f)
            - 0.00040 * math.sin(3 * mp)
        )
        w = (
            0.00306
            - 0.00038 * e * math.cos(m)
            + 0.00026 * math.cos(mp)
            - 0.00002 * math.cos(mp - m)
            + 0.00002 * math.cos(mp + m)
            + 0.00002 * math.cos(2 * f)
        )
        jde += w if fraction == 0.25 else -w
    return datetime.fromtimestamp((jde - 2440587.5) * 86400, timezone.utc)


def phases_around(now: datetime) -> list[tuple[datetime, float]]:
    """Principal phases from a little before `now` to a little after, in order."""
    year = now.year + (now.timetuple().tm_yday - 1) / 365.25
    base = math.floor((year - 2000) * 12.3685) - 1
    return [(phase_time(base + step / 4), (step / 4) % 1) for step in range(12)]


def moon_reading(item: dict[str, Any], now: datetime) -> Reading:
    phases = phases_around(now)
    previous = max((p for p in phases if p[0] <= now), key=lambda p: p[0])
    upcoming = min((p for p in phases if p[0] > now), key=lambda p: p[0])

    if item["field"] == "phase":
        age = (now - phase_time_of_new(phases, now)).total_seconds() / 86400
        lit = (1 - math.cos(2 * math.pi * age / SYNODIC_MONTH)) / 2 * 100
        near = min(phases, key=lambda p: abs((p[0] - now).total_seconds()))
        if abs((near[0] - now).total_seconds()) <= AT_PHASE_HOURS * 3600:
            name, symbol = PRINCIPAL[near[1]], SYMBOLS[near[1]]
        else:
            name, symbol = BETWEEN[previous[1]], SYMBOLS[previous[1]]
        return Reading(item.get("name", "Luna"), f"{symbol} {name.upper()} {lit:.0f} %")

    # next_phase: the label is the coming phase itself, the value says when.
    when = upcoming[0].astimezone()
    days = (when.date() - now.astimezone().date()).days
    if days == 0:
        value = f"hoy {when:%H:%M}"
    elif days == 1:
        value = f"mañana {when:%H:%M}"
    else:
        value = f"en {days} días · {when:%d/%m}"
    return Reading(f"{SYMBOLS[upcoming[1]]} {PRINCIPAL[upcoming[1]]}", value)


def phase_time_of_new(phases: list[tuple[datetime, float]], now: datetime) -> datetime:
    """The last new Moon before `now` (for the Moon's age)."""
    return max(when for when, fraction in phases if fraction == 0.0 and when <= now)


def orbit_position(planet: str, when: datetime) -> tuple[float, float]:
    """A planet's heliocentric ecliptic longitude (degrees) and distance from the Sun (AU), on its
    orbit's ellipse (its tilt left out: a few degrees that don't change the picture)."""
    a, e, (mean, mean_rate), (perihelion, perihelion_rate) = ORBITS[planet]
    centuries = ((when.timestamp() / 86400 + 2440587.5) - 2451545.0) / 36525
    anomaly = math.radians((mean + mean_rate * centuries - perihelion - perihelion_rate * centuries) % 360)
    eccentric = anomaly
    for _ in range(6):
        eccentric -= (eccentric - e * math.sin(eccentric) - anomaly) / (1 - e * math.cos(eccentric))
    x, y = a * (math.cos(eccentric) - e), a * math.sqrt(1 - e * e) * math.sin(eccentric)
    longitude = (math.degrees(math.atan2(y, x)) + perihelion + perihelion_rate * centuries) % 360
    return longitude, math.hypot(x, y)


def venus_reading(item: dict[str, Any], now: datetime) -> Reading:
    """"♀ Venus …… lucero del alba · 24° del sol", with both planets around the Sun for a drawing."""
    venus, earth = orbit_position("venus", now), orbit_position("earth", now)
    point = lambda longitude, distance: (distance * math.cos(math.radians(longitude)),
                                         distance * math.sin(math.radians(longitude)))
    (vx, vy), (ex, ey) = point(*venus), point(*earth)
    # From the Earth: the direction to the Sun and to Venus, and the angle between them.
    to_sun = math.degrees(math.atan2(-ey, -ex))
    to_venus = math.degrees(math.atan2(vy - ey, vx - ex))
    east = (to_venus - to_sun + 180) % 360 - 180
    apart = abs(east)
    if apart < VENUS_HIDDEN_BELOW:
        seen = "junto al sol"
    else:
        # East of the Sun it sets after it: in the evening; west, it rises before it.
        seen = "lucero de la tarde" if east > 0 else "lucero del alba"
    venus_data = {"venus": [round(venus[0], 1), round(venus[1], 4)], "earth": [round(earth[0], 1), round(earth[1], 4)],
                  "apart": round(apart, 1), "seen": seen}
    return Reading(f"♀ {item.get('name', 'Venus')}", f"{seen} · {apart:.0f}° del sol", venus=venus_data)

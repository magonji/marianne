"""How well the house and its boiler do: a model of the house fitted to its history, and what the
boiler's heating dial should be.

The house, as one room (its rooms' mean temperature T, the outside's To), every half hour:

        dT/dt = a·heating − b·(T − To) + Σ s_side·sun_side

gives how fast the boiler warms its air while it runs (a, K/h at the dial's water temperature) and
how much the sun does through each side's windows (s). Its b isn't the house's loss: the thick walls
give back heat as the air cools, so over hours the air seems to lose little. The losses come from
the balance over days instead: the heat the radiators gave out is the heat the house lost, so the
boiler has to run a fraction of the time for each degree of difference with the outside. No meter
of gas or of the water is needed, so the boiler's figures are estimates.

The dial sets the water's flow temperature; the radiators give out heat as (mean water − room)^1.3
(EN 442), and the water comes back cooler by an amount that grows with what they give out. Below
about 55 °C of return the boiler condenses the steam of its flue gases and gets their heat back.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

STEP = timedelta(minutes=30)
# How many days of history (the recorder keeps about ten), the coldest day the boiler has to hold
# (Glasgow's, for sizing heating) and the temperature it has to hold then.
DAYS, DESIGN_OUTSIDE, COMFORT = 10, -3.0, 20.0
# Where the dial's moves are kept (data/ is the container's volume).
DIAL_FILE = "data/caldera.json"
# Greenstar 24i/28i Junior: the dial's positions and their flow temperatures (user instructions,
# 6 720 802 048, fig. 2: "approximate"). "off" is the snowflake: no central heating.
DIALS = {
    "greenstar-junior": [("off", None), ("min", 40), ("1", 47), ("2", 53), ("3", 61), ("4", 68), ("5", 74),
                         ("6", 80), ("max", 82)],
}
# Radiators at the design point the fixed pump gives: water 15 K cooler on the way back with them
# giving out what they give at 75 °C of flow and 20 °C in the room (a usual 70-ish/60-ish system).
DESIGN_FLOW, DESIGN_ROOM, DESIGN_DROP = 75.0, 20.0, 15.0
RADIATOR_EXPONENT = 1.3
# A condensing boiler's efficiency (gross, %) by its return temperature: the usual curve.
EFFICIENCY = [(25, 97.0), (30, 96.5), (35, 95.5), (40, 94.5), (45, 93.0), (50, 91.5), (55, 89.0),
              (60, 87.5), (65, 87.0), (80, 86.5)]
CONDENSING_BELOW = 55.0
# Room the boiler should have over the losses on the coldest day, to warm the house back up.
MARGIN = 0.85
# How much longer than with today's dial a lower one may take to warm the house up.
SLOWER_WARMING = 1.35
# Mould grows where the air touching a surface is over 80 % humid (ISO 13788); the coldest inner
# surfaces of an outside wall (its corners) are at fRsi = 0.75 of the way from outside to inside.
MOULD_HUMIDITY, CORNER_FACTOR = 80.0, 0.75
# A room cooling faster than this (K/h) with the heating off has a window open.
WINDOW_OPEN_DROP = 1.0


@dataclass
class History:
    """What the fit needs, on the STEP grid: None where a value is missing."""
    times: list[datetime]
    rooms: dict[str, list[float | None]]
    humidity: dict[str, list[float | None]]
    outside: list[float | None]
    heating: list[float]  # fraction of each step the boiler ran
    target: list[float | None]
    wind: list[float | None]  # km/h
    sun: dict[str, list[float]]  # by side: sin(elevation) · clear sky, while it shines on that side
    flow: list[float | None]  # the dial's flow temperature (°C) at each step, if known
    cycles: list[float] = field(default_factory=list)  # minutes of each burner run


def on_grid(series: list[tuple[datetime, Any]], times: list[datetime]) -> list[Any]:
    """The last value before each time (a step function, as Home Assistant's states are)."""
    out, i, last = [], 0, None
    for t in times:
        while i < len(series) and series[i][0] <= t:
            last = series[i][1]
            i += 1
        out.append(last)
    return out


def fraction_on(changes: list[tuple[datetime, bool]], times: list[datetime]) -> tuple[list[float], list[float]]:
    """For each step, the fraction of it the boiler was on; and how long each run lasted (min)."""
    fractions, runs = [], []
    state, since = False, None
    events = iter(changes)
    nxt = next(events, None)
    for t0 in times:
        t1 = t0 + STEP
        on_time, cursor = 0.0, t0
        while nxt is not None and nxt[0] < t1:
            when, value = nxt
            if when > cursor:
                on_time += (when - cursor).total_seconds() if state else 0
                cursor = when
            if value != state:
                if value:
                    since = when
                elif since is not None:
                    runs.append((when - since).total_seconds() / 60)
            state = value
            nxt = next(events, None)
        on_time += (t1 - cursor).total_seconds() if state else 0
        fractions.append(on_time / STEP.total_seconds())
    return fractions, runs


def radiator_output(flow: float, room: float) -> tuple[float, float]:
    """The radiators' output, as a fraction of the design one, and the return temperature."""
    x = 1.0
    excess = DESIGN_FLOW - DESIGN_DROP / 2 - DESIGN_ROOM
    for _ in range(50):
        mean = flow - DESIGN_DROP * x / 2 - room
        x = (max(mean, 0.0) / excess) ** RADIATOR_EXPONENT
    return x, flow - DESIGN_DROP * x


def efficiency(back: float) -> float:
    """The boiler's efficiency (%) for a return temperature, along the usual curve."""
    if back <= EFFICIENCY[0][0]:
        return EFFICIENCY[0][1]
    for (t1, e1), (t2, e2) in zip(EFFICIENCY, EFFICIENCY[1:]):
        if back <= t2:
            return e1 + (e2 - e1) * (back - t1) / (t2 - t1)
    return EFFICIENCY[-1][1]


def solve(rows: list[list[float]], ys: list[float]) -> tuple[list[float], list[float]] | None:
    """Least squares by the normal equations (a handful of unknowns), with a touch of ridge so an
    unknown the data says nothing about stays at 0; also each one's standard error."""
    n = len(rows[0])
    normal = [[sum(r[i] * r[j] for r in rows) + (1e-6 if i == j else 0) for j in range(n)] for i in range(n)]
    # Gauss-Jordan on [normal | right side | identity]: the coefficients and the inverse at once.
    m = [normal[i] + [sum(r[i] * y for r, y in zip(rows, ys))] + [1.0 if i == j else 0.0 for j in range(n)]
         for i in range(n)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            return None
        m[c], m[p] = m[p], m[c]
        m[c] = [v / m[c][c] for v in m[c]]
        for r in range(n):
            if r != c:
                f = m[r][c]
                m[r] = [a - f * b for a, b in zip(m[r], m[c])]
    coef = [m[i][n] for i in range(n)]
    residual = sum((y - sum(c * x for c, x in zip(coef, r))) ** 2 for r, y in zip(rows, ys))
    variance = residual / max(1, len(rows) - n)
    return coef, [math.sqrt(max(0.0, variance * m[i][n + 1 + i])) for i in range(n)]


@dataclass
class Fit:
    heat: float  # a: K/h of the air with the boiler running, at the reference flow
    loss: float  # b: 1/h, the air's (its walls hold heat: not the house's losses over days)
    sun: dict[str, tuple[float, float]]  # by side: K/h with the sun full on it, and its standard error
    r2: float
    samples: int


def fit(temps: list[float | None], history: History, reference_flow: float | None) -> Fit | None:
    """The half-hour model's coefficients for one series of temperatures (the house's or a room's):
    how fast the heating and the sun warm its air."""
    sides = sorted(history.sun)
    rows, ys = [], []
    for k in range(1, len(history.times)):
        t0, t1, out = temps[k - 1], temps[k], history.outside[k - 1]
        if t0 is None or t1 is None or out is None:
            continue
        diff = (t0 + t1) / 2 - out
        rows.append([history.heating[k - 1] * output_weight(history.flow[k - 1], reference_flow, t0), -diff,
                     *(history.sun[s][k - 1] for s in sides)])
        ys.append((t1 - t0) / (STEP.total_seconds() / 3600))
    if len(rows) < 48 or sum(r[0] for r in rows) < 4:
        return None
    solved = solve(rows, ys)
    if solved is None:
        return None
    coef, errors = solved
    mean = sum(ys) / len(ys)
    total = sum((y - mean) ** 2 for y in ys) or 1.0
    residual = sum((y - sum(c * x for c, x in zip(coef, r))) ** 2 for r, y in zip(rows, ys))
    return Fit(coef[0], coef[1], {side: (coef[2 + i], errors[2 + i]) for i, side in enumerate(sides)},
               1 - residual / total, len(rows))


def output_weight(flow: float | None, reference_flow: float | None, room: float) -> float:
    """What the radiators gave out with the dial of the time, against what they give with today's."""
    if not flow or not reference_flow:
        return 1.0
    return radiator_output(flow, room)[0] / radiator_output(reference_flow, room)[0]


def balance(temps: list[float | None], history: History, reference_flow: float | None) -> dict[str, Any] | None:
    """Over days the heat the radiators gave out is the heat the house lost (what its walls stored
    at the start they still hold at the end): so the fraction of the time the boiler has to run,
    with today's dial, for each degree of difference with the outside. The sun and the people in it
    help, and are in it. With enough days, how much more is needed with wind."""
    heating = degrees = 0.0
    days: dict[Any, list[float]] = {}
    for k, (temp, out) in enumerate(zip(temps, history.outside)):
        if temp is None or out is None:
            continue
        on = history.heating[k] * output_weight(history.flow[k], reference_flow, temp)
        heating += on
        degrees += temp - out
        day = days.setdefault(history.times[k].date(), [0.0, 0.0, 0.0, 0])
        day[0] += on
        day[1] += temp - out
        day[2] += history.wind[k] or 0.0
        day[3] += 1
    if degrees <= 0 or heating * STEP.total_seconds() / 3600 < 4:
        return None
    result: dict[str, Any] = {"per_degree": heating / degrees}
    # Wind: each full day's need for each degree, against its mean wind.
    full = [(d[0] / d[1], d[2] / d[3] / 10) for d in days.values() if d[3] >= 44 and d[1] > 0]
    if len(full) >= 7:
        solved = solve([[1.0, wind] for _, wind in full], [need for need, _ in full])
        if solved and solved[0][0] > 0:
            (base, slope), (_, error) = solved
            result["wind"] = (slope / base, error / base)
    return result


def dew_humidity(temp: float, humidity: float, surface: float) -> float:
    """The humidity of the air touching a surface at `surface` °C, from the room's (Magnus)."""
    psat = lambda t: 6.112 * math.exp(17.62 * t / (243.12 + t))  # noqa: E731
    return humidity * psat(temp) / psat(surface)


def analyse(history: History, dial: str | None, dials: list[tuple[str, float | None]], design_outside: float,
            comfort: float, thermostat_room: str | None = None) -> dict[str, Any]:
    """Everything the window shows: the boiler, the house, its rooms. In plain numbers; the page
    words them."""
    flows = dict(dials)
    flow = flows.get(dial) if dial else None
    house = [mean_of([series[k] for series in history.rooms.values()]) for k in range(len(history.times))]
    result: dict[str, Any] = {"comfort": comfort, "days": round(len(history.times) * STEP.total_seconds() / 86400, 1),
                              "heating_hours": round(sum(history.heating) * STEP.total_seconds() / 3600, 1)}
    model = fit(house, history, flow)
    whole = balance(house, history, flow)
    last = lambda series: next((v for v in reversed(series) if v is not None), None)  # noqa: E731
    now_in, now_out = last(house), last(history.outside)
    if history.cycles:
        result["cycles"] = {"count": len(history.cycles), "mean": round(sum(history.cycles) / len(history.cycles)),
                            "short": sum(1 for c in history.cycles if c <= 15)}
    if whole is None:
        result["model"] = None
        return result
    need = whole["per_degree"]
    result["model"] = {"per_degree": round(need, 4), "r2": round(model.r2, 2) if model else None,
                       "warming": round(model.heat, 3) if model and model.heat > 0 else None}
    if "wind" in whole:
        share, error = whole["wind"]
        result["wind"] = {"share": round(share, 3), "sure": abs(share) > 2 * error}
    if model and model.heat > 0:
        # The sun by side, only where the data says something clear (twice its standard error).
        result["sun"] = {side: {"warms": round(v, 2), "share": round(v / model.heat, 2)}
                         for side, (v, error) in model.sun.items() if v > 0 and v > 2 * error}
    if now_in is not None and now_out is not None:
        duty = need * (now_in - now_out)
        recent = history.heating[-48:]
        result["now"] = {"inside": round(now_in, 1), "outside": round(now_out, 1), "duty": round(duty, 2),
                         "ratio": round(1 / duty, 1) if duty > 0 else None,
                         "duty_seen": round(sum(recent) / len(recent), 2) if recent else None}
    # The outside temperature down to which the boiler, running all the time, would hold the comfort.
    result["limit"] = round(comfort - 1 / need, 1)
    # The dial: what each position gives, and the lowest that still holds the comfort on a cold day
    # with room to spare, and how long each takes to warm the house 2 °C.
    coldest = min((v for v in history.outside[-6 * 48:] if v is not None), default=None)
    positions = []
    for name, temp in dials:
        if temp is None:
            continue
        output, back = radiator_output(temp, comfort)
        entry = {"dial": name, "flow": temp, "back": round(back), "efficiency": round(efficiency(back), 1),
                 "condensing": back < CONDENSING_BELOW}
        if flow:
            share = output / radiator_output(flow, comfort)[0]
            entry["need"] = round(need / share, 5)
            if model and model.heat > 0 and now_in is not None and now_out is not None:
                rate = model.heat * (share - need * (now_in - now_out))
                entry["warm_two"] = round(2 / rate, 1) if rate > 0 else None
        positions.append(entry)
    result["dials"] = positions
    if flow:
        def lowest(outside: float) -> str | None:
            return next((p["dial"] for p in positions if p["need"] * (comfort - outside) <= MARGIN), None)

        result["advice"] = {"design": lowest(design_outside), "design_outside": design_outside,
                            "week": lowest(coldest) if coldest is not None else None,
                            "week_outside": round(coldest, 1) if coldest is not None else None}
        # The one to have: the lowest that condenses and holds a cold day without taking much
        # longer than now to warm the house up (the slow warming of a low flow is its price).
        current = next((p for p in positions if p["dial"] == dial), None)
        result["advice"]["best"] = None
        if current and current.get("warm_two"):
            fine = [p for p in positions if p["condensing"] and p["need"] * (comfort - design_outside) <= MARGIN
                    and p.get("warm_two") and p["warm_two"] <= current["warm_two"] * SLOWER_WARMING]
            result["advice"]["best"] = fine[0]["dial"] if fine else None
        for p in positions:
            p["saving"] = round(100 * (1 - (current or p)["efficiency"] / p["efficiency"]), 1) if current else None
    # The rooms: how fast each loses heat and how well its radiator keeps up (both against the
    # house's), how far it stays behind the thermostat's room once the heating has run an hour, and
    # how humid its outside walls' corners get (mould).
    thermostat = history.rooms.get(thermostat_room) if thermostat_room else None
    warm = [k for k in range(2, len(history.times)) if min(history.heating[k - 2:k + 1]) > 0.9]
    rooms = []
    for name, temps in history.rooms.items():
        room = fit(temps, history, flow)
        entry: dict[str, Any] = {
            "name": name,
            # How fast its air warms with the heating, against the house's: its radiator's size
            # for it (a room without one, near 0).
            "heat": round(room.heat / model.heat, 2) if room and model and room.heat > 0 and model.heat > 0 else None,
            "mean": round(mean_of(temps[-48:]), 1) if mean_of(temps[-48:]) is not None else None,
        }
        if thermostat is not None and name != thermostat_room:
            behind = [temps[k] - thermostat[k] for k in warm if temps[k] is not None and thermostat[k] is not None]
            entry["behind"] = round(sum(behind) / len(behind), 1) if len(behind) >= 4 else None
        # How fast it cools at night with the heating off, against the house: its losses (walls to
        # the street, draughts), since all the rooms share the same night.
        night = cooling(temps, history)
        whole_night = cooling(house, history)
        entry["cools"] = round(night / whole_night, 2) if night and whole_night else None
        entry["opened"] = window_openings(temps, history)
        humidity = history.humidity.get(name)
        if humidity:
            corners = []
            for k in range(max(0, len(history.times) - 3 * 48), len(history.times)):
                t, h, out = temps[k], humidity[k], history.outside[k]
                if t is not None and h is not None and out is not None and t > out:
                    corners.append(dew_humidity(t, h, out + CORNER_FACTOR * (t - out)))
            if corners:
                entry["corner"] = round(max(corners))
                entry["mould"] = round(100 * sum(1 for c in corners if c >= MOULD_HUMIDITY) / len(corners))
        rooms.append(entry)
    result["rooms"] = rooms
    return result


def cooling(temps: list[float | None], history: History) -> float | None:
    """The night's cooling, in K/h for each degree of difference with the outside: the sun down
    and the heating off for over an hour (the radiators cold)."""
    drop = degree_hours = 0.0
    hours = STEP.total_seconds() / 3600
    for k in range(3, len(history.times)):
        t0, t1, out = temps[k - 1], temps[k], history.outside[k - 1]
        if t0 is None or t1 is None or out is None or t0 - out < 2 or max(history.heating[k - 3:k + 1]) > 0:
            continue
        # A window open (a sharp drop, as no wall gives): not the room's losses.
        if (t0 - t1) / hours > WINDOW_OPEN_DROP:
            continue
        if any(series[k] > 0 for series in history.sun.values()):
            continue
        drop += t0 - t1
        degree_hours += (t0 - out) * hours
    return drop / degree_hours if degree_hours > 20 and drop > 0 else None


def window_openings(temps: list[float | None], history: History) -> int:
    """How many times a window was opened: drops sharper than walls give, with the heating off
    (one each time, however long it stayed open)."""
    count, opened = 0, False
    hours = STEP.total_seconds() / 3600
    for k in range(1, len(history.times)):
        t0, t1 = temps[k - 1], temps[k]
        sharp = t0 is not None and t1 is not None and history.heating[k - 1] == 0 and (t0 - t1) / hours > WINDOW_OPEN_DROP
        count += sharp and not opened
        opened = sharp
    return count


def mean_of(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return sum(present) / len(present) if present else None


def entities(item: dict[str, Any]) -> list[str]:
    """The entities whose history the analysis reads."""
    found = [item["heating"], item["outside"], item.get("sun_elevation", "sensor.sun_solar_elevation")]
    for spec in item["rooms"].values():
        spec = spec if isinstance(spec, dict) else {"temperature": spec}
        found += [spec["temperature"]] + ([spec["humidity"]] if spec.get("humidity") else [])
    found += [item.get("sun_azimuth", "sensor.sun_solar_azimuth")]
    found += [item["weather"]] if item.get("weather") else []
    return list(dict.fromkeys(found))


def read_dial_log(path: str) -> list[tuple[datetime, str]]:
    """The dial's moves, oldest first: [(when, position)]."""
    try:
        rows = json.loads(Path(path).read_text()).get("dial", [])
    except (OSError, ValueError, AttributeError):
        return []
    log = []
    for row in rows if isinstance(rows, list) else []:
        try:
            log.append((datetime.fromisoformat(row["at"]), str(row["position"])))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(log, key=lambda row: row[0])


def add_to_dial_log(path: str, position: str) -> None:
    rows = [{"at": when.isoformat(), "position": dial} for when, dial in read_dial_log(path)]
    rows.append({"at": datetime.now().astimezone().isoformat(timespec="seconds"), "position": position})
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps({"dial": rows}, ensure_ascii=False, indent=1) + "\n")
    temporary.replace(file)


def number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def history_from(states: dict[str, list[dict[str, Any]]], item: dict[str, Any], now: datetime, days: float,
                 dial_log: list[tuple[datetime, str]], dials: list[tuple[str, float | None]]) -> History:
    """The STEP grid from Home Assistant's history (its /api/history answer, by entity)."""
    start = now - timedelta(days=days)
    times = []
    t = start.replace(minute=0, second=0, microsecond=0)
    while t < now:
        times.append(t)
        t += STEP

    def changes(entity: str, attribute: str | None = None, convert=number) -> list[tuple[datetime, Any]]:
        out = []
        for row in states.get(entity, []):
            raw = row.get("attributes", {}).get(attribute) if attribute else row.get("state")
            value = convert(raw)
            if value is None:
                continue
            when = datetime.fromisoformat(row.get("last_updated") or row["last_changed"])
            out.append((when, value))
        return out

    rooms, humidity = {}, {}
    for name, spec in item["rooms"].items():
        spec = spec if isinstance(spec, dict) else {"temperature": spec}
        rooms[name] = on_grid(changes(spec["temperature"]), times)
        if spec.get("humidity"):
            humidity[name] = on_grid(changes(spec["humidity"]), times)
    climate = item["heating"]
    running = changes(climate, "hvac_action", lambda v: None if v is None else v == "heating")
    heating, cycles = fraction_on(running, times)
    weather = item.get("weather")
    clouds = on_grid(changes(weather, "cloud_coverage"), times) if weather else [None] * len(times)
    wind = on_grid(changes(weather, "wind_speed"), times) if weather else [None] * len(times)
    elevation = on_grid(changes(item.get("sun_elevation", "sensor.sun_solar_elevation")), times)
    azimuth = on_grid(changes(item.get("sun_azimuth", "sensor.sun_solar_azimuth")), times)
    # The sun on each side's windows: how straight it comes at them (the cosine of its angle with
    # the wall's outward line, flat on the horizon for a wall), less what the clouds take.
    sun: dict[str, list[float]] = {}
    for side, facing in (item.get("facades") or {"sol": None}).items():
        values = []
        for height, bearing, cloud in zip(elevation, azimuth, clouds):
            if height is None or height <= 0:
                values.append(0.0)
                continue
            clear = 1 - (cloud or 0) / 100
            if facing is None or bearing is None:
                values.append(math.sin(math.radians(height)) * clear)
                continue
            straight = math.cos(math.radians(height)) * math.cos(math.radians(bearing - float(facing)))
            values.append(max(0.0, straight) * clear)
        sun[side] = values
    flows = dict(dials)
    flow = on_grid([(when, flows.get(dial)) for when, dial in dial_log], times)
    return History(times, rooms, humidity, on_grid(changes(item["outside"]), times), heating,
                   on_grid(changes(climate, "temperature"), times), wind, sun, flow, cycles)


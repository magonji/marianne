import os
import asyncio
from datetime import date, datetime

import pytest

from marianne.config import ConfigError, parse_config
from marianne.sources.dates import DatesSource, date_reading, days_until, progress_reading
from marianne.sources.pomodoro import PomodoroSource

ITEMS = [{"field": "timer"}, {"field": "status"}, {"field": "count"}]


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def pomodoro(**options):
    clock = Clock()
    return PomodoroSource("pomo", clock=clock, **options), clock


def show(source):
    timer, status, count = asyncio.run(source.fetch(ITEMS))
    return timer, status, count


def test_pomodoro_counts_down_pauses_and_resumes():
    source, clock = pomodoro()
    timer, status, _ = show(source)
    assert (timer.value, timer.label, status.value) == ("25:00", "Trabajo · 1/4", "PARADO")
    source.toggle()
    clock.now += 61
    timer, status, _ = show(source)
    assert (timer.value, status.value, status.switch) == ("23:59", "EN MARCHA", True)
    source.toggle()
    clock.now += 600  # paused: time does not run
    timer, status, _ = show(source)
    assert (timer.value, status.value) == ("23:59", "EN PAUSA")


def test_work_ends_rings_and_starts_the_break():
    source, clock = pomodoro()
    source.toggle()
    clock.now += 25 * 60
    timer, status, count = show(source)
    assert (timer.label, timer.value, count.value) == ("Descanso corto", "05:00", "1")
    assert timer.ring and timer.notice == "Pomodoro 1 terminado · descanso corto"
    timer, _, _ = show(source)
    assert not timer.ring  # rings only once


def test_break_ends_and_waits_for_the_next_pomodoro():
    source, clock = pomodoro()
    source.toggle()
    clock.now += 25 * 60
    show(source)
    clock.now += 5 * 60
    timer, status, _ = show(source)
    assert (timer.label, timer.value, status.value) == ("Trabajo · 2/4", "25:00", "PARADO")
    assert timer.ring and "pulsa P" in timer.notice
    source.toggle()
    timer, _, _ = show(source)
    assert timer.notice is None


def test_every_fourth_break_is_long_and_reset_keeps_the_count():
    source, clock = pomodoro(work=1, short_break=1, long_break=3, long_every=2)
    for _ in range(2):
        source.toggle()
        clock.now += 60
        show(source)
        if source.phase == "short":
            clock.now += 60
            show(source)
    assert source.phase == "long" and source.left() == 180
    source.reset()
    timer, _, count = show(source)
    assert (timer.value, count.value) == ("01:00", "2")


TODAY = date(2026, 10, 19)


def test_dates_fixed_yearly_and_birthdays():
    assert days_until({"date": date(2026, 12, 25)}, TODAY) == 67
    assert days_until({"date": "10-18"}, TODAY) == 364  # yearly, already passed this year
    birthday = date_reading({"name": "Cumple", "date": date(1986, 10, 20), "yearly": True}, TODAY)
    assert (birthday.value, birthday.switch) == ("MAÑANA · 40 años", True)
    later = date_reading({"name": "Navidad", "date": "12-25"}, TODAY)
    assert (later.value, later.switch) == ("en 67 días · 25/12", None)
    past = date_reading({"name": "Viaje", "date": date(2026, 10, 1)}, TODAY)
    assert past.value == "hace 18 días"


def test_today_gives_a_notice():
    reading = date_reading({"name": "Aniversario", "date": "10-19"}, TODAY)
    assert (reading.value, reading.switch, reading.notice) == ("¡HOY!", True, "★ Hoy: Aniversario")


def test_29_february_in_a_normal_year():
    assert days_until({"date": "02-29"}, date(2027, 2, 27)) == 1


def test_dates_are_sorted_by_proximity():
    items = [{"name": "Lejos", "date": "12-25"}, {"name": "Pasada", "date": date(2020, 1, 1)}, {"name": "Cerca", "date": "11-01"}]
    readings = asyncio.run(DatesSource("fechas").fetch(items))
    assert [r.label for r in readings] == ["Cerca", "Lejos", "Pasada"]


def test_config_validates_tools():
    sources = {"pomo": {"type": "pomodoro"}, "fechas": {"type": "dates"}}
    with pytest.raises(ConfigError, match="field"):
        parse_config({"sources": sources, "panels": [{"source": "pomo", "items": [{"field": "nope"}]}]}, None)
    with pytest.raises(ConfigError, match="date"):
        parse_config({"sources": sources, "panels": [{"source": "fechas", "items": [{"name": "x"}]}]}, None)


NOW = datetime(2026, 10, 19, 13, 6)  # a Monday


def bar(kind, **options):
    return progress_reading({"progress": kind, **options}, NOW)


def test_progress_of_day_week_month_and_year():
    day = bar("day")
    assert (day.label, day.value, day.unit) == ("Día", "55", "%") and round(day.fraction, 3) == 0.546
    assert bar("week").value == "8"  # Monday 13:06 of a week starting on Monday
    assert bar("month").value == "60"  # 18.5 of 31 days
    assert bar("year").value == "80"


def test_life_progress_counts_days_left():
    life = bar("life", birth=date(1986, 3, 14), end=date(2063, 8, 22))
    assert life.value == "52.4" and life.note == "" and life.wide_bar
    with_days = bar("life", birth=date(1986, 3, 14), end=date(2063, 8, 22), days_left=True)
    assert with_days.note == "quedan 13456 días"


def test_progress_bars_stay_on_top():
    items = [{"name": "Navidad", "date": "12-25"}, {"progress": "day"}, {"progress": "year"}]
    readings = asyncio.run(DatesSource("fechas").fetch(items))
    assert [r.label for r in readings] == ["Día", "Año", "Navidad"]


def test_config_checks_progress():
    sources = {"fechas": {"type": "dates"}}
    with pytest.raises(ConfigError, match="birth"):
        parse_config({"sources": sources, "panels": [{"source": "fechas", "items": [{"progress": "life"}]}]}, None)
    with pytest.raises(ConfigError, match="progress"):
        parse_config({"sources": sources, "panels": [{"source": "fechas", "items": [{"progress": "siglo"}]}]}, None)


def test_config_checks_sun_roles():
    data = {"sources": {"homeassistant": {}}, "panels": [{"items": [{"entity": "sensor.x", "sun": "moon"}]}]}
    with pytest.raises(ConfigError, match="sun"):
        parse_config(data, None)


def test_pages_need_a_key():
    data = {"sources": {"homeassistant": {}}, "panels": [{"pages": [{"items": ["sensor.x"]}]}]}
    with pytest.raises(ConfigError, match="page_key"):
        parse_config(data, None)


def test_load_env_does_not_override_the_shell(tmp_path, monkeypatch):
    from marianne.config import load_env

    (tmp_path / ".env").write_text("# secretos\nCLAVE_NUEVA='abc'\nCLAVE_SHELL=del_fichero\nVACIA=\n")
    monkeypatch.delenv("CLAVE_NUEVA", raising=False)
    monkeypatch.setenv("CLAVE_SHELL", "de_la_shell")
    load_env(tmp_path / ".env", tmp_path / "no_existe")
    assert os.environ["CLAVE_NUEVA"] == "abc"
    assert os.environ["CLAVE_SHELL"] == "de_la_shell"
    monkeypatch.delenv("CLAVE_NUEVA")
    monkeypatch.delenv("VACIA")


def test_a_popup_with_pages_needs_no_page_key():
    data = {"sources": {"homeassistant": {"type": "homeassistant"}},
            "panels": [{"title": "Móvil", "key": "m", "pages": [{"name": "Uno", "items": ["sensor.a"]},
                                                                 {"name": "Dos", "items": ["sensor.b"]}]}]}
    assert parse_config(data, None).panels[0].page_key is None
    del data["panels"][0]["key"]
    with pytest.raises(ConfigError):
        parse_config(data, None)

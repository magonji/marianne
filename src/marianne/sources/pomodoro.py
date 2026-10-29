"""Pomodoro timer: work / break countdown driven from the keyboard."""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import date
from typing import Any

from .base import Reading, Source

FIELDS = {"timer", "status", "count"}
PHASE_NAMES = {"work": "Trabajo", "short": "Descanso corto", "long": "Descanso largo"}


class PomodoroSource(Source):
    kind = "pomodoro"
    remote = False

    def __init__(
        self,
        name: str,
        work: float = 25,
        short_break: float = 5,
        long_break: float = 15,
        long_every: int = 4,
        start_key: str = "p",
        reset_key: str = "o",
        sound: str | None = "Glass",
        chimes: int = 3,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(name)
        self.durations = {"work": work * 60, "short": short_break * 60, "long": long_break * 60}
        self.long_every = long_every
        self.start_key = start_key
        self.reset_key = reset_key
        # Played `chimes` times when a phase ends; None leaves only the terminal bell.
        self.sound = sound
        self.chimes = chimes
        self.clock = clock
        self.phase = "work"
        self.running = False
        self.remaining = self.durations["work"]
        self.ends_at = 0.0
        self.done_today = 0
        self.day = date.today()
        # Set when a phase has just finished: the app rings the bell once.
        self.ring = False
        self.notice_text: str | None = None

    def describe(self) -> str:
        return f"{self.durations['work'] / 60:g}/{self.durations['short'] / 60:g}/{self.durations['long'] / 60:g} min"

    def toggle(self) -> None:
        """Start, pause or resume."""
        now = self.clock()
        if self.running:
            self.remaining = max(0.0, self.ends_at - now)
            self.running = False
        else:
            self.ends_at = now + self.remaining
            self.running = True
            if self.phase == "work":
                self.notice_text = None

    def reset(self) -> None:
        """Back to the start of a work period, stopped. Today's count is kept."""
        self.phase, self.running, self.notice_text = "work", False, None
        self.remaining = self.durations["work"]

    def left(self) -> float:
        return max(0.0, self.ends_at - self.clock()) if self.running else self.remaining

    def advance(self) -> None:
        """Move on to the next phase if the current one is over."""
        if date.today() != self.day:
            self.day, self.done_today = date.today(), 0
        if not self.running or self.clock() < self.ends_at:
            return
        self.ring = True
        if self.phase == "work":
            self.done_today += 1
            self.phase = "long" if self.done_today % self.long_every == 0 else "short"
            self.ends_at = self.clock() + self.durations[self.phase]
            name = "descanso largo" if self.phase == "long" else "descanso corto"
            self.notice_text = f"Pomodoro {self.done_today} terminado · {name}"
        else:
            self.phase, self.running = "work", False
            self.remaining = self.durations["work"]
            self.notice_text = f"Descanso terminado · pulsa {self.start_key.upper()} para el siguiente pomodoro"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        self.advance()
        self.mark_ok()
        readings = [self._reading(item) for item in items]
        if readings:
            readings[0].notice = self.notice_text
            readings[0].ring, self.ring = self.ring, False
        return readings

    def _reading(self, item: dict[str, Any]) -> Reading:
        field = item["field"]
        if field == "timer":
            minutes, seconds = divmod(int(self.left() + 0.999), 60)
            position = self.done_today % self.long_every + (1 if self.phase == "work" else 0)
            label = PHASE_NAMES[self.phase]
            if self.phase == "work":
                label += f" · {position or self.long_every}/{self.long_every}"
            return Reading(item.get("name", label), f"{minutes:02d}:{seconds:02d}")
        if field == "status":
            if self.running:
                text, on = "EN MARCHA", True
            elif self.left() < self.durations[self.phase]:
                text, on = "EN PAUSA", False
            else:
                text, on = "PARADO", False
            return Reading(item.get("name", "Estado"), text, switch=on)
        return Reading(item.get("name", "Pomodoros hoy"), str(self.done_today))

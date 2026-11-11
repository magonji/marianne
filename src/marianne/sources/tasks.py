"""Tasks of the server marianne runs on (updating its containers...), asked for from the actions.

Marianne runs in a container and can't run anything of the server's: it only leaves a request,
`<folder>/<task>.request`, and a systemd unit of the server runs the task's own script when it
appears (see tasks/ in the repository), leaving how it went in `<task>.status`. So the page can
only ask for the tasks the server has, never say what to run.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .base import Reading, Source

# A task's name: also the name of its files and of the server's systemd unit.
TASK_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$")


class TasksSource(Source):
    kind = "tasks"
    remote = False

    def __init__(self, name: str, folder: str = "data/tasks") -> None:
        super().__init__(name)
        self.folder = Path(folder)

    def describe(self) -> str:
        return "tareas del servidor"

    def _status(self, task: str) -> dict[str, Any]:
        """{"state": "running" | "ok" | "error", "at": ISO time}, as the server left it; {} if never run."""
        try:
            status = json.loads((self.folder / f"{task}.status").read_text())
        except (OSError, ValueError):
            return {}
        return status if isinstance(status, dict) else {}

    def _asked(self, task: str) -> bool:
        return (self.folder / f"{task}.request").exists()

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        self.mark_ok()
        return [self._reading(item) for item in items]

    def _reading(self, item: dict[str, Any]) -> Reading:
        task = item["task"]
        status = self._status(task)
        running = self._asked(task) or status.get("state") == "running"
        note = ""
        if not running and status.get("state") in ("ok", "error"):
            note = f"{'hecho' if status['state'] == 'ok' else 'falló'} {when(status.get('at'))}".strip()
        return Reading(item.get("name", task), "running" if running else str(status.get("state", "")),
                       switch=running, note=note, icon=item.get("icon", "mdi:console"))

    async def run_task(self, item: dict[str, Any]) -> None:
        """Leave the request for the server; once only while the task is waiting or running."""
        task = item["task"]
        if self._asked(task) or self._status(task).get("state") == "running":
            raise ValueError("ya está en marcha")
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / f"{task}.request").write_text(f"{datetime.now().astimezone().isoformat()}\n")


def when(text: Any) -> str:
    """"10:02" today, "09/11 10:02" another day; "" if it isn't a time."""
    try:
        moment = datetime.fromisoformat(str(text)).astimezone()
    except ValueError:
        return ""
    return moment.strftime("%H:%M" if moment.date() == datetime.now().astimezone().date() else "%d/%m %H:%M")

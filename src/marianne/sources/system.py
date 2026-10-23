"""The machine marianne runs on: CPU, memory, disk, temperature... like Glance's server-stats."""

from __future__ import annotations

import os
import platform
import socket
import time
from pathlib import Path
from typing import Any

import psutil

from .base import Reading, Source, check_alert, format_number, make_fraction

FIELDS = {"cpu", "load", "memory", "swap", "disk", "temperature", "uptime", "hostname", "platform"}
LABELS = {
    "cpu": "CPU", "load": "Carga", "memory": "Memoria", "swap": "Swap", "disk": "Disco",
    "temperature": "Temperatura", "uptime": "Encendido", "hostname": "Equipo", "platform": "Sistema",
}


class SystemSource(Source):
    kind = "system"
    remote = False

    def __init__(self, name: str, host_root: str | None = None) -> None:
        super().__init__(name)
        # In Docker, the server's / mounted read-only (e.g. /host), for its disks, hostname and
        # system name. CPU, memory, load and uptime come from /proc, which is already the host's.
        self.host = Path(host_root) if host_root and Path(host_root).is_dir() else None
        # The first cpu_percent() call has nothing to compare with and returns 0.
        psutil.cpu_percent()

    def describe(self) -> str:
        return "este equipo"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        self.mark_ok()
        return [self._reading(item) for item in items]

    def _reading(self, item: dict[str, Any]) -> Reading:
        field = item["field"]
        label = item.get("name", LABELS[field] + (f" {item['path']}" if field == "disk" and "path" in item else ""))
        hidden = bool(item.get("hidden"))
        try:
            if field in ("hostname", "platform", "uptime"):
                return Reading(label, text_value(field, self.host), hidden=hidden)
            if field == "load":
                loads = os.getloadavg()
                # 1, 5 and 15 minutes.
                return Reading(label, " · ".join(f"{load:.2f}" for load in loads),
                               alert=check_alert(item, loads[0]), hidden=hidden)
            number, note = measure(field, item, self.host)
        except (OSError, KeyError) as exc:
            return Reading(label, "ERROR", error=True, note=str(exc)[:40], hidden=hidden)
        if number is None:
            return Reading(label, "N/D", hidden=hidden)
        unit = "°C" if field == "temperature" else "%"
        value = format_number(number, item.get("decimals", 0))
        if field == "temperature":
            item = {"max": 100, **item}
        return Reading(label, value, unit, fraction=make_fraction(number, item, unit), note=note,
                       alert=check_alert(item, number), hidden=hidden, wide_bar=unit == "%")


def measure(field: str, item: dict[str, Any], host: Path | None = None) -> tuple[float | None, str]:
    """A percentage (or °C) and a note with the amounts behind it."""
    if field == "cpu":
        return psutil.cpu_percent(), f"{psutil.cpu_count()} núcleos"
    if field == "memory":
        memory = psutil.virtual_memory()
        return memory.percent, f"{gigabytes(memory.total - memory.available)}/{gigabytes(memory.total)} GB"
    if field == "swap":
        swap = psutil.swap_memory()
        return (swap.percent, f"{gigabytes(swap.used)}/{gigabytes(swap.total)} GB") if swap.total else (None, "")
    if field == "disk":
        path = item.get("path", "/")
        disk = psutil.disk_usage(str(host / path.lstrip("/")) if host else path)
        return disk.percent, f"{gigabytes(disk.used)}/{gigabytes(disk.total)} GB"
    return cpu_temperature(), ""


def cpu_temperature() -> float | None:
    """The hottest CPU sensor; None where psutil can't read them (macOS, some containers)."""
    sensors = getattr(psutil, "sensors_temperatures", lambda: {})()
    for name in ("coretemp", "k10temp", "cpu_thermal", "cpu-thermal", "zenpower", "acpitz"):
        if sensors.get(name):
            return max(sensor.current for sensor in sensors[name])
    readings = [sensor.current for group in sensors.values() for sensor in group]
    return max(readings) if readings else None


def text_value(field: str, host: Path | None = None) -> str:
    if field == "hostname":
        name = read_text(host / "etc/hostname") if host else ""
        return (name or socket.gethostname()).split(".")[0]
    if field == "platform":
        release = os_release(host / "etc/os-release") if host else ""
        return release or f"{platform.system()} {platform.release()}"
    seconds = int(time.time() - psutil.boot_time())
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    return f"{days} d {hours} h" if days else f"{hours} h {rest // 60} min"


def gigabytes(size: float) -> str:
    return f"{size / 1024**3:.1f}"


def read_text(path: Path) -> str:
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def os_release(path: Path) -> str:
    """PRETTY_NAME from /etc/os-release (e.g. "Debian GNU/Linux 12 (bookworm)")."""
    for line in read_text(path).splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip('"')
    return ""

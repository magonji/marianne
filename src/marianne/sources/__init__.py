from __future__ import annotations

import os
from typing import Any

from .base import Reading, Source
from .demo import DemoSource
from .dates import DatesSource
from .homeassistant import HomeAssistantSource
from .monitor import MonitorSource
from .ical import IcalSource
from .metoffice import MetOfficeSource
from .moon import MoonSource
from .music import MusicSource
from .openweather import OpenWeatherSource
from .pomodoro import PomodoroSource
from .rss import RssSource
from .system import SystemSource
from .web import WebSource

__all__ = ["Reading", "Source", "build_source"]


def build_source(name: str, spec: dict[str, Any], demo: bool = False) -> Source:
    kind = spec.get("type", name)
    if demo and kind == "homeassistant":
        return DemoSource(name)
    if kind == "homeassistant":
        token = secret(spec.get("token", "${HASS_TOKEN}"))
        return HomeAssistantSource(
            name,
            url=spec.get("url", "http://homeassistant.local:8123"),
            token=token,
            verify_ssl=spec.get("verify_ssl", True),
            timeout=spec.get("timeout", 10),
        )
    if kind == "web":
        return WebSource(name, timeout=spec.get("timeout", 15), headers=spec.get("headers"))
    if kind == "openweather":
        return OpenWeatherSource(
            name,
            api_key=secret(spec.get("api_key", "${OPENWEATHER_KEY}")),
            city=spec.get("city", "Glasgow,GB"),
            lang=spec.get("lang", "es"),
            history_file=spec.get("history"),
            hourly=spec.get("hourly"),
        )
    if kind == "monitor":
        return MonitorSource(name, timeout=spec.get("timeout", 5), verify_ssl=spec.get("verify_ssl", True),
                             wud=spec.get("wud"))
    if kind == "ical":
        calendars = [{"name": str(c.get("name", "")), "url": secret(c.get("url", ""))} for c in spec.get("calendars") or []]
        return IcalSource(name, calendars, timeout=spec.get("timeout", 20))
    if kind == "metoffice":
        if not spec.get("region"):
            raise ValueError(f"source '{name}': falta 'region', el código de la región del Met Office (st para Strathclyde)")
        return MetOfficeSource(name, region=str(spec["region"]), area=spec.get("area"), timeout=spec.get("timeout", 15))
    if kind == "rss":
        return RssSource(name, timeout=spec.get("timeout", 15))
    if kind == "system":
        return SystemSource(name, host_root=spec.get("host_root"))
    if kind == "moon":
        return MoonSource(name)
    if kind == "pomodoro":
        return PomodoroSource(
            name,
            work=float(spec.get("work", 25)),
            short_break=float(spec.get("short_break", 5)),
            long_break=float(spec.get("long_break", 15)),
            long_every=int(spec.get("long_every", 4)),
            start_key=str(spec.get("start_key", "p")).lower(),
            reset_key=str(spec.get("reset_key", "o")).lower(),
            sound=str(spec.get("sound", "Glass")) if spec.get("sound", "Glass") else None,
            chimes=int(spec.get("chimes", 3)),
        )
    if kind == "dates":
        return DatesSource(name, sort=bool(spec.get("sort", True)), file=spec.get("file"),
                           edit_key=str(spec.get("edit_key", "f")).lower())
    if kind == "music":
        if not spec.get("folder"):
            raise ValueError(f"source '{name}': falta 'folder', la carpeta de la música")
        key = str(spec["key"]).lower() if spec.get("key") else None
        return MusicSource(name, folder=str(spec["folder"]), key=key, cache=spec.get("cache"),
                           rescan_hours=float(spec.get("rescan_hours", 6)))
    if kind == "demo":
        return DemoSource(name)
    raise ValueError(f"source '{name}': tipo desconocido '{kind}'")


def secret(value: Any) -> str:
    """Expand ${ENV_VARS}; an unset variable means the secret is missing."""
    expanded = os.path.expandvars(str(value))
    return "" if expanded.startswith("$") else expanded

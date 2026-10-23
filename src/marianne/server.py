"""Marianne: a retro dashboard in the browser. This small server reads config.yaml, asks the
sources (Home Assistant, OpenWeather...) and hands the readings to the page in static/ as JSON.

    uv run marianne                  # http://127.0.0.1:1111
    uv run marianne --demo
    uv run marianne --host 0.0.0.0   # reachable from other devices

The Home Assistant token and the other keys stay here: the page only sees the readings.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import asdict
from datetime import datetime
from importlib import resources
from pathlib import Path
from typing import Any

import yaml
from aiohttp import web

from .config import Config, ConfigError, PanelConfig, load_config, parse_config
from .sources import Source, build_source
from .sources.pomodoro import PomodoroSource

STATIC = Path(__file__).parent / "static"
POMODORO_TICK = 0.5


class Dashboard:
    """Polls every page of every panel at its own refresh rate and keeps the latest readings."""

    def __init__(self, config: Config, demo: bool) -> None:
        self.config = config
        self.demo = demo
        self.sources: dict[str, Source] = {
            name: build_source(name, spec or {}, demo) for name, spec in config.sources.items()
        }
        # Per panel, per page: {"readings": [...], "updated": "HH:MM:SS", "error": str | None}.
        self.panels: list[list[dict[str, Any]]] = [
            [{"readings": [], "updated": None, "error": None} for _ in self.pages(panel)] for panel in config.panels
        ]
        # Goes up by one each time a pomodoro phase ends, so every open page rings once.
        self.rings = 0
        self.tasks: list[asyncio.Task] = []

    @staticmethod
    def pages(panel: PanelConfig) -> list[list[dict[str, Any]]]:
        return [items for _, items in panel.pages] if panel.pages else [panel.items]

    def pomodoros(self) -> dict[str, PomodoroSource]:
        return {name: source for name, source in self.sources.items() if isinstance(source, PomodoroSource)}

    async def start(self) -> None:
        for index, panel in enumerate(self.config.panels):
            for page in range(len(self.pages(panel))):
                self.tasks.append(asyncio.create_task(self.poll(index, page)))
        self.tasks.append(asyncio.create_task(self.tick()))

    async def stop(self) -> None:
        for task in self.tasks:
            task.cancel()
        for source in self.sources.values():
            await source.close()

    async def poll(self, index: int, page: int) -> None:
        while True:
            await self.load(index, page)
            await asyncio.sleep(self.config.panels[index].refresh)

    async def load(self, index: int, page: int) -> None:
        # Consecutive items from the same source go in one request; sources are asked in parallel.
        runs: list[tuple[str, list[dict[str, Any]]]] = []
        for item in self.pages(self.config.panels[index])[page]:
            if runs and runs[-1][0] == item["source"]:
                runs[-1][1].append(item)
            else:
                runs.append((item["source"], [item]))
        state = self.panels[index][page]
        try:
            chunks = await asyncio.gather(*(self.sources[name].fetch(items) for name, items in runs))
        except Exception as exc:
            state["error"] = str(exc)[:60] or "ERROR"
            return
        readings = [reading for chunk in chunks for reading in chunk]
        for reading in readings:
            for part in reading.parts():
                # A pomodoro panel may notice the end of a phase before tick() does.
                if part.ring:
                    self.rings += 1
                    part.ring = False
        state.update(readings=[asdict(reading) for reading in readings], updated=f"{datetime.now():%H:%M:%S}", error=None)

    async def tick(self) -> None:
        while True:
            for source in self.pomodoros().values():
                source.advance()
                if source.ring:
                    source.ring = False
                    self.rings += 1
            await asyncio.sleep(POMODORO_TICK)

    async def reload(self, source: str | None = None) -> None:
        """Fetch again now, every panel or only those that use `source`."""
        jobs = [
            self.load(index, page)
            for index, panel in enumerate(self.config.panels)
            for page, items in enumerate(self.pages(panel))
            if source is None or any(item["source"] == source for item in items)
        ]
        await asyncio.gather(*jobs)

    def layout(self) -> dict[str, Any]:
        """What the page needs to know to draw itself; never the items, keys or URLs."""
        return {
            "theme": self.config.theme,
            "columns": self.config.columns,
            "boot": self.config.boot,
            "uppercase": self.config.uppercase,
            "bell": self.config.bell,
            "demo": self.demo,
            "boot_lines": self.boot_lines(),
            "panels": [
                {
                    "title": panel.title,
                    "big": panel.big,
                    "span": panel.column_span,
                    "rows": panel.row_span,
                    "key": panel.key,
                    "page_key": panel.page_key,
                    "pages": [name for name, _ in panel.pages] or [panel.title],
                }
                for panel in self.config.panels
            ],
            "pomodoros": [
                {"name": name, "start_key": source.start_key, "reset_key": source.reset_key}
                for name, source in self.pomodoros().items()
            ],
        }

    def boot_lines(self) -> list[str]:
        lines = [
            "MARIANNE BIOS v0.1                (C) 1986-2026 MARIANNE SYSTEMS",
            "",
            "MEMORY TEST ............................ 640K OK",
            f"CONFIG ................................. {self.config.path.name if self.config.path else 'DEMO'}",
        ]
        for name, source in self.sources.items():
            lines.append(f"SOURCE {name.upper():<14} ........... {source.kind}")
        lines += [f"PANELS ................................. {len(self.config.panels)}", "", "READY."]
        return lines

    def state(self) -> dict[str, Any]:
        used = {item["source"] for panel in self.config.panels for item in panel.items}
        return {
            "now": time.time(),
            "panels": self.panels,
            "rings": self.rings,
            "sources": [
                {"name": name, "ok": source.ok}
                for name, source in self.sources.items()
                if name in used and source.remote
            ],
            "pomodoro": self.pomodoro_state(),
        }

    def pomodoro_state(self) -> dict[str, Any] | None:
        source = next(iter(self.pomodoros().values()), None)
        if source is None:
            return None
        timer = source._reading({"field": "timer"})
        status = source._reading({"field": "status"})
        return {
            # In use: running, paused halfway or on a break. Stopped at the start, it goes away.
            "active": source.running or source.phase != "work" or source.left() < source.durations["work"],
            "running": source.running,
            "left": source.left(),
            "label": timer.label,
            "status": status.value,
            "notice": source.notice_text,
        }


def make_app(dashboard: Dashboard) -> web.Application:
    routes = web.RouteTableDef()

    @routes.get("/")
    async def index(request: web.Request) -> web.FileResponse:
        return web.FileResponse(STATIC / "index.html")

    @routes.get("/api/layout")
    async def layout(request: web.Request) -> web.Response:
        return web.json_response(dashboard.layout())

    @routes.get("/api/state")
    async def state(request: web.Request) -> web.Response:
        return web.json_response(dashboard.state())

    @routes.post("/api/reload")
    async def reload(request: web.Request) -> web.Response:
        await dashboard.reload()
        return web.json_response(dashboard.state())

    @routes.post("/api/pomodoro/{name}/{action}")
    async def pomodoro(request: web.Request) -> web.Response:
        source = dashboard.pomodoros().get(request.match_info["name"])
        action = request.match_info["action"]
        if source is None or action not in ("toggle", "reset"):
            raise web.HTTPNotFound()
        source.toggle() if action == "toggle" else source.reset()
        await dashboard.reload(request.match_info["name"])
        return web.json_response(dashboard.state())

    app = web.Application()
    app.add_routes(routes)
    app.router.add_static("/static", STATIC)

    async def lifecycle(app: web.Application):
        await dashboard.start()
        yield
        await dashboard.stop()

    app.cleanup_ctx.append(lifecycle)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(prog="marianne", description="Panel retro en el navegador.")
    parser.add_argument("-c", "--config", help="ruta a config.yaml")
    parser.add_argument("--demo", action="store_true", help="usa datos simulados en lugar de Home Assistant")
    parser.add_argument("--theme", help="phosphor | amber | c64")
    parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 para abrirlo desde otros dispositivos")
    parser.add_argument("--port", type=int, default=1111)
    args = parser.parse_args()

    try:
        if args.demo and not args.config:
            example = resources.files("marianne").joinpath("demo.yaml").read_text()
            config = parse_config(yaml.safe_load(example), None)
        else:
            config = load_config(args.config)
        if args.theme:
            config.theme = args.theme
        dashboard = Dashboard(config, args.demo)
    except (ConfigError, ValueError) as exc:
        sys.exit(f"marianne: {exc}")
    web.run_app(make_app(dashboard), host=args.host, port=args.port, print=lambda _: print(
        f"marianne en http://{args.host}:{args.port}  (Ctrl+C para salir)"))


if __name__ == "__main__":
    main()

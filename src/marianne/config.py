"""Loading and normalising config.yaml."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .sources.dates import PROGRESS
from .sources.moon import FIELDS as MOON_FIELDS
from .sources.openweather import FIELDS as OPENWEATHER_FIELDS
from .sources.pomodoro import FIELDS as POMODORO_FIELDS
from .sources.system import FIELDS as SYSTEM_FIELDS
from .icons import parse as parse_icon
from .sun import ROLES as SUN_ROLES

RESERVED_KEYS = {"a", "c", "h", "q", "r"}
SEARCH_PATHS = [Path("config.yaml"), Path.home() / ".config" / "marianne" / "config.yaml"]


@dataclass
class PanelConfig:
    title: str
    source: str
    items: list[dict[str, Any]]
    refresh: float = 10
    column_span: int = 1
    row_span: int = 1
    # Draw the first item with big seven-segment digits.
    big: bool = False
    # Draw the items as a grid of icons (`icon: mdi:dolphin`) instead of rows.
    icons: bool = False
    # Shown by the `history` command (its key, H): the max and min of its values over a period.
    history: bool = False
    # If set, the panel is not in the grid: this key opens it as a pop-up window.
    key: str | None = None
    # Several sets of items shown one at a time, as (name, items); `page_key` goes to the next.
    # `items` then holds all of them, so the sources of every page count as in use.
    pages: list[tuple[str, list[dict[str, Any]]]] = field(default_factory=list)
    page_key: str | None = None


@dataclass
class Config:
    path: Path | None
    theme: str = "amber"
    columns: int = 3
    # Relative height of each row of the grid (rows left out are 1): [1.25, 1, 1] makes the first taller.
    row_heights: list[float] = field(default_factory=list)
    boot: bool = True
    uppercase: bool = True
    bell: bool = False
    # The `history` command's key.
    history_key: str = "h"
    sources: dict[str, dict[str, Any]] = field(default_factory=dict)
    panels: list[PanelConfig] = field(default_factory=list)


class ConfigError(Exception):
    pass


def find_config(explicit: str | None) -> Path | None:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.exists():
            raise ConfigError(f"No existe el fichero de configuración: {path}")
        return path
    return next((path for path in SEARCH_PATHS if path.exists()), None)


def load_env(*paths: Path) -> None:
    """Read KEY=value lines from .env files; variables already set in the shell win."""
    for path in paths:
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            name, sep, value = line.strip().partition("=")
            if sep and name and not name.startswith("#"):
                os.environ.setdefault(name.strip(), value.strip().strip("'\""))


def load_config(explicit: str | None = None) -> Config:
    path = find_config(explicit)
    if path is not None:
        # Secrets for ${...}: a .env next to config.yaml or in the current directory.
        load_env(path.parent / ".env", Path(".env"))
    if path is None:
        raise ConfigError(
            "No encuentro config.yaml (ni en el directorio actual ni en ~/.config/marianne/).\n"
            "Copia config.example.yaml a config.yaml, o prueba con: marianne --demo"
        )
    try:
        data = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path} no es YAML válido:\n{exc}") from exc
    return parse_config(data, path)


def parse_config(data: dict[str, Any], path: Path | None) -> Config:
    sources = data.get("sources") or {}
    panels = [_parse_panel(i, raw, sources) for i, raw in enumerate(data.get("panels") or [])]
    return Config(
        path=path,
        theme=data.get("theme", "amber"),
        columns=int(data.get("columns", 3)),
        row_heights=_row_heights(data.get("row_heights")),
        boot=bool(data.get("boot", True)),
        uppercase=bool(data.get("uppercase", True)),
        bell=bool(data.get("bell", False)),
        history_key=str(data.get("history_key", "h")).lower(),
        sources=sources,
        panels=panels,
    )


def _parse_panel(index: int, raw: dict[str, Any], sources: dict[str, Any]) -> PanelConfig:
    title = raw.get("title", f"Panel {index + 1}")
    source = raw.get("source", "homeassistant")
    if source not in sources:
        raise ConfigError(f"Panel '{title}': la fuente '{source}' no está definida en 'sources'")
    pages = [(str(page.get("name", f"{n + 1}")), _parse_items(title, page.get("items"), source, sources))
             for n, page in enumerate(raw.get("pages") or [])]
    items = [item for _, page in pages for item in page] if pages else _parse_items(title, raw.get("items"), source, sources)
    key = _key(title, raw, "key")
    page_key = _key(title, raw, "page_key")
    # A pop-up with pages goes through them with its own key, so it needs no page_key.
    if pages and page_key is None and key is None:
        raise ConfigError(f"Panel '{title}': con 'pages' hace falta 'page_key', la tecla para cambiar de página")
    return PanelConfig(
        title=title,
        source=source,
        items=items,
        refresh=float(raw.get("refresh", 10)),
        column_span=int(raw.get("span", 1)),
        row_span=int(raw.get("rows", 1)),
        big=bool(raw.get("big", False)),
        icons=bool(raw.get("icons", False)),
        history=bool(raw.get("history", False)),
        key=key,
        pages=pages,
        page_key=page_key,
    )


def _row_heights(raw: Any) -> list[float]:
    try:
        heights = [float(height) for height in raw or []]
    except (TypeError, ValueError):
        heights = []
    if not isinstance(raw, (list, type(None))) or any(height <= 0 for height in heights) or len(heights) != len(raw or []):
        raise ConfigError("'row_heights' debe ser una lista de números mayores que 0, como [1.25, 1, 1]")
    return heights


def _key(title: str, raw: dict[str, Any], option: str) -> str | None:
    key = str(raw[option]).lower() if option in raw else None
    if key is not None and (len(key) != 1 or key in RESERVED_KEYS):
        raise ConfigError(f"Panel '{title}': '{option}' debe ser una sola tecla distinta de {', '.join(sorted(RESERVED_KEYS))}")
    return key


def _parse_items(title: str, raw_items: list[Any] | None, source: str, sources: dict[str, Any]) -> list[dict[str, Any]]:
    # A bare string is shorthand for a Home Assistant entity id.
    items = [{"entity": item} if isinstance(item, str) else dict(item) for item in raw_items or []]
    for item in items:
        # Each item may come from its own source; by default, the panel's.
        item["source"] = item.get("source", source)
        if item["source"] not in sources:
            raise ConfigError(f"Panel '{title}': la fuente '{item['source']}' no está definida en 'sources'")
        kind = (sources[item["source"]] or {}).get("type", item["source"])
        # `also`: one or more extra values for the same row, from the same source. A bare
        # string is an entity for Home Assistant and a field for OpenWeather (`also: [max, min]`).
        if "also" in item:
            extras = item["also"] if isinstance(item["also"], list) else [item["also"]]
            key = "field" if kind == "openweather" else "entity"
            item["also"] = [{key: extra} if isinstance(extra, str) else dict(extra) for extra in extras]
        if kind == "web" and not {"url", "selector"} <= item.keys():
            raise ConfigError(f"Panel '{title}': cada elemento web necesita 'url' y 'selector'")
        if kind == "rss" and not ("url" in item or item.get("feeds")):
            raise ConfigError(f"Panel '{title}': cada elemento rss necesita 'url' (un feed) o 'feeds' (varios)")
        if kind == "monitor" and "url" not in item:
            raise ConfigError(f"Panel '{title}': cada servicio necesita 'url'")
        if kind == "dates" and "progress" in item:
            if item["progress"] not in PROGRESS:
                raise ConfigError(f"Panel '{title}': 'progress' debe ser uno de {', '.join(sorted(PROGRESS))}")
            if item["progress"] == "life" and not {"birth", "end"} <= item.keys():
                raise ConfigError(f"Panel '{title}': la barra de vida necesita 'birth' y 'end'")
        elif kind == "dates" and "date" not in item:
            raise ConfigError(f"Panel '{title}': cada fecha necesita 'date' (2026-12-25, o 12-25 para todos los años)")
        if "icon" in item and parse_icon(item["icon"]) is None:
            raise ConfigError(f"Panel '{title}': 'icon' debe ser mdi:nombre o si:nombre (como en Glance), no '{item['icon']}'")
        if "sun" in item and item["sun"] not in SUN_ROLES:
            raise ConfigError(f"Panel '{title}': 'sun' debe ser uno de {', '.join(sorted(SUN_ROLES))}")
        fields = {"openweather": OPENWEATHER_FIELDS, "moon": MOON_FIELDS, "pomodoro": POMODORO_FIELDS,
                  "system": SYSTEM_FIELDS}.get(kind)
        if fields and any(part.get("field") not in fields for part in [item, *item.get("also", [])]):
            raise ConfigError(f"Panel '{title}': 'field' debe ser uno de {', '.join(sorted(fields))}")
    return items

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

RESERVED_KEYS = {"c", "h", "q", "r", "v"}
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
    # While a pomodoro is under way, it takes this panel's place (and leaves the header alone).
    pomodoro: bool = False
    # A grid of buttons (icon and name) that run Home Assistant scripts (`script:` in its items).
    actions: bool = False
    # Its icon ("mdi:shield-home") on the phone's round button that opens it (with `key`).
    icon: str | None = None
    # A plan of the house instead of rows: its rooms, and the items' values in them (`room:`).
    plan: dict[str, Any] | None = None
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
        pomodoro=bool(raw.get("pomodoro", False)),
        actions=bool(raw.get("actions", False)),
        icon=str(raw["icon"]) if raw.get("icon") else None,
        plan=_parse_plan(title, raw.get("plan"), items),
        key=key,
        pages=pages,
        page_key=page_key,
    )


OUTSIDE = "fuera"
# What an item can draw on the plan while it's on (`appliance: {kind, at}`).
APPLIANCES = {"washer"}
# The colour of the path on a Roborock's map in Home Assistant.
ROBOROCK_PATH = [147, 194, 238]
VACUUM_COMMANDS = {"start", "pause", "stop", "return_to_base", "locate", "clean_rooms"}


def _parse_plan(title: str, raw: Any, items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A house drawn in lines: `size` [width, height] in any unit, its `rooms` (each a `name`, which
    may be empty, and a `rect` [x, y, width, height] or `points` [[x, y], ...]) and `outside`, the
    rect where the values of `room: fuera` go. The items say in which room their value goes."""
    if raw is None:
        return None
    problem = f"Panel '{title}': en 'plan', "

    def numbers(value: Any, count: int | None, what: str) -> list[float]:
        try:
            values = [float(number) for number in value]
        except (TypeError, ValueError):
            raise ConfigError(problem + f"{what} debe ser una lista de números") from None
        if count is not None and len(values) != count:
            raise ConfigError(problem + f"{what} debe tener {count} números")
        return values

    if not isinstance(raw, dict):
        raise ConfigError(problem + "hacen falta 'size' y 'rooms'")
    plan: dict[str, Any] = {"size": numbers(raw.get("size"), 2, "'size'"), "rooms": []}
    for room in raw.get("rooms") or []:
        name = str(room.get("name") or "")
        if "rect" in room:
            shape: dict[str, Any] = {"name": name, "rect": numbers(room["rect"], 4, f"el 'rect' de '{name}'")}
        elif "points" in room:
            points = [numbers(point, 2, f"cada punto de '{name}'") for point in room["points"] or []]
            if len(points) < 3:
                raise ConfigError(problem + f"'{name}' necesita al menos 3 puntos")
            shape = {"name": name, "points": points}
        else:
            raise ConfigError(problem + f"'{name}' necesita 'rect' o 'points'")
        # `label`: where its name (and values) go, if not in its middle; `furniture`: a piece of
        # furniture (a kitchen island), drawn fainter than the walls.
        if room.get("label") is not None:
            shape["label"] = numbers(room["label"], 2, f"el 'label' de '{name}'")
        # `lights`: where its first light bulb goes (the rest, leftwards), if not its top right corner.
        if room.get("lights") is not None:
            shape["lights"] = numbers(room["lights"], 2, f"el 'lights' de '{name}'")
        if room.get("furniture"):
            shape["furniture"] = True
        plan["rooms"].append(shape)
    if raw.get("outside") is not None:
        plan["outside"] = numbers(raw["outside"], 4, "'outside'")
    # `lines`: dotted lines that don't close (the edge of the kitchen counters), each its `points`.
    plan["lines"] = []
    for line in raw.get("lines") or []:
        points = [numbers(point, 2, "cada punto de 'lines'") for point in (line or {}).get("points") or []]
        if len(points) < 2:
            raise ConfigError(problem + "cada línea de 'lines' necesita al menos 2 puntos")
        plan["lines"].append({"points": points})
    if raw.get("map") is not None:
        # A robot vacuum's path on the plan, taken from its map (an image entity): `box`, the house
        # in that picture in pixels [left, top, right, bottom]; `rotate` it 0, 90, 180 or 270
        # degrees; `to`, where that box goes on the plan [x, y, width, height]; `path_color`, the
        # colour of the path in the picture.
        picture = raw["map"]
        if not str(picture.get("entity", "")).startswith(("image.", "camera.")):
            raise ConfigError(problem + "'map' necesita 'entity', una entidad image.… o camera.…")
        rotate = int(picture.get("rotate", 0))
        if rotate not in (0, 90, 180, 270):
            raise ConfigError(problem + "'rotate' debe ser 0, 90, 180 o 270")
        plan["map"] = {"entity": str(picture["entity"]), "box": numbers(picture.get("box"), 4, "el 'box' de 'map'"),
                       "rotate": rotate, "to": numbers(picture.get("to") or [0, 0, *plan["size"]], 4, "el 'to' de 'map'"),
                       "path_color": [int(value) for value in numbers(picture.get("path_color", ROBOROCK_PATH), 3, "'path_color'")]}
    # Doors: a `name`, the two ends of its gap (`from`, `to`) and to which side it opens (`swing`,
    # 1 or -1). An item with `door: <name>` (a contact sensor) opens it, red if it's alerting.
    plan["doors"] = []
    for door in raw.get("doors") or []:
        name = str(door.get("name") or "")
        if not name:
            raise ConfigError(problem + "cada puerta necesita 'name'")
        swing = int(door.get("swing", 1))
        if swing not in (1, -1):
            raise ConfigError(problem + f"el 'swing' de '{name}' debe ser 1 o -1")
        leaves = int(door.get("leaves", 1))
        if leaves not in (1, 2):
            raise ConfigError(problem + f"las 'leaves' de '{name}' deben ser 1 o 2 (puerta doble)")
        plan["doors"].append({"name": name, "from": numbers(door.get("from"), 2, f"el 'from' de '{name}'"),
                              "to": numbers(door.get("to"), 2, f"el 'to' de '{name}'"), "swing": swing, "leaves": leaves})
    names = {room["name"] for room in plan["rooms"] if room["name"]} | ({OUTSIDE} if "outside" in plan else set())
    doors = {door["name"] for door in plan["doors"]}
    for item in items:
        if "room" in item and item["room"] not in names:
            raise ConfigError(problem + f"no hay ninguna habitación '{item['room']}' (son {', '.join(sorted(names))})")
        if "light" in item and item["light"] not in names:
            raise ConfigError(problem + f"no hay ninguna habitación '{item['light']}' para la luz (son {', '.join(sorted(names))})")
        if "door" in item and item["door"] not in doors:
            raise ConfigError(problem + f"no hay ninguna puerta '{item['door']}' (son {', '.join(sorted(doors)) or 'ninguna'})")
        if "appliance" in item:
            appliance = item["appliance"] if isinstance(item["appliance"], dict) else {}
            if appliance.get("kind") not in APPLIANCES:
                raise ConfigError(problem + f"'appliance' necesita 'kind', uno de {', '.join(sorted(APPLIANCES))}")
            item["appliance"] = {"kind": appliance["kind"], "at": numbers(appliance.get("at"), 2, "el 'at' de 'appliance'")}
    return plan


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
        if "vacuum" in item:
            if item.get("command") not in VACUUM_COMMANDS:
                raise ConfigError(f"Panel '{title}': 'command' de la aspiradora debe ser uno de {', '.join(sorted(VACUUM_COMMANDS))}")
            if item["command"] == "clean_rooms" and not item.get("rooms"):
                raise ConfigError(f"Panel '{title}': 'clean_rooms' necesita 'rooms': los números de las habitaciones, "
                                  "o sus nombres con su número para elegirlas al pulsar")
        if "script" in item and not str(item["script"]).startswith("script."):
            raise ConfigError(f"Panel '{title}': 'script' debe ser un script de Home Assistant (script.…), no '{item['script']}'")
        if kind == "monitor" and "url" not in item:
            raise ConfigError(f"Panel '{title}': cada servicio necesita 'url'")
        if kind == "dates" and "progress" in item:
            if item["progress"] not in PROGRESS:
                raise ConfigError(f"Panel '{title}': 'progress' debe ser uno de {', '.join(sorted(PROGRESS))}")
            if item["progress"] == "life" and not {"birth", "end"} <= item.keys():
                raise ConfigError(f"Panel '{title}': la barra de vida necesita 'birth' y 'end'")
        elif kind == "dates" and "date" not in item and not item.get("calendar"):
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

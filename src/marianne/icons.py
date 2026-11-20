"""Icons by name, as in Glance: `mdi:dolphin` (Material Design Icons) or `si:jellyfin` (Simple Icons),
or from any other of Iconify's sets by its prefix (`game-icons:owl`).

The server downloads each SVG once (from jsDelivr, or Iconify's API) and keeps it in memory, so the
page only talks to marianne. The page paints them with the theme colour, as a mask.
"""

from __future__ import annotations

import re

import httpx

SETS = {
    "mdi": "https://cdn.jsdelivr.net/npm/@mdi/svg@7.4.47/svg/{name}.svg",
    "si": "https://cdn.jsdelivr.net/npm/simple-icons@16.35.0/icons/{name}.svg",
}
# Any other set: Iconify's, by its prefix.
ICONIFY = "https://api.iconify.design/{kind}/{name}.svg"
NAME = re.compile(r"^[a-z0-9-]{1,64}$")
# Shown when an icon can't be downloaded: a hollow square, like a missing glyph.
FALLBACK = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    '<path d="M4 4h16v16H4zm2 2v12h12V6z"/></svg>'
)


def parse(icon: str) -> tuple[str, str] | None:
    """('mdi', 'dolphin') for 'mdi:dolphin'; None if it isn't a valid set and name."""
    kind, _, name = str(icon).partition(":")
    return (kind, name) if NAME.match(kind) and NAME.match(name) else None


class Icons:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.client = httpx.AsyncClient(timeout=10, follow_redirects=True, transport=transport)
        self.cache: dict[tuple[str, str], str] = {}

    async def get(self, kind: str, name: str) -> str | None:
        """The SVG, FALLBACK if it couldn't be downloaded, None if the name isn't valid."""
        if not NAME.match(kind) or not NAME.match(name):
            return None
        key = (kind, name)
        if key not in self.cache:
            try:
                response = await self.client.get(SETS.get(kind, ICONIFY).format(kind=kind, name=name))
                response.raise_for_status()
                svg = response.text
            except httpx.HTTPError:
                # Not cached: it may work next time.
                return FALLBACK
            self.cache[key] = svg if "<svg" in svg else FALLBACK
        return self.cache[key]

    async def close(self) -> None:
        await self.client.aclose()

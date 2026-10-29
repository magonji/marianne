"""A folder of music (MP3, FLAC, AAC...) for the page's iPod: its songs by their tags, and the files."""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import mutagen

from .base import Reading, Source

# What browsers can play (see the README): others are left out of the library.
EXTENSIONS = {".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wav"}
# An album's picture, when its songs have none inside: these names first, then any image.
COVER_NAMES = ("cover", "folder", "front", "album", "albumart")
IMAGES = {".jpg", ".jpeg", ".png", ".webp"}
# A file's number at the start of its name: "03 Song", "03 - Song", "03. Song".
LEADING_NUMBER = re.compile(r"^\d{1,3}\s*[-._)]?\s+")
# Pictures kept in memory, so the iPod's list of albums doesn't read them again and again.
COVER_CACHE = 200


@dataclass
class Track:
    id: str
    path: str  # relative to the folder; never sent to the page
    title: str
    artist: str
    album: str
    album_artist: str
    track: int
    disc: int
    year: str
    length: float
    album_id: str = ""


class MusicSource(Source):
    kind = "music"
    # It's a folder on this machine: nothing to show in the status bar.
    remote = False

    def __init__(self, name: str, folder: str, key: str | None = None, cache: str | None = None,
                 rescan_hours: float = 6, ratings: str | None = None) -> None:
        super().__init__(name)
        self.folder = Path(folder)
        self.key = key
        # The tags already read (by path, size and time), so a new look only reads new files.
        self.cache = Path(cache) if cache else None
        self.rescan_seconds = rescan_hours * 3600
        # The stars given on the iPod (by song id), kept in this file: the music is read-only.
        self.ratings_file = Path(ratings) if ratings else None
        self.ratings: dict[str, int] = self._load_ratings()
        self.tracks: dict[str, Track] = {}
        self.albums: list[dict[str, Any]] = []
        self._order: list[str] = []
        self._scanned_at = 0.0
        self._lock = asyncio.Lock()
        self._rescanning: asyncio.Task | None = None
        # The library as sent to the page, made once after each look at the folder.
        self._payload: dict[str, Any] | None = None
        self._covers: dict[str, tuple[bytes, str] | None] = {}

    def describe(self) -> str:
        # Not the folder: its path says nothing useful on screen and may have names in it.
        return "carpeta de música"

    async def fetch(self, items: list[dict[str, Any]]) -> list[Reading]:
        try:
            await self.library()
        except Exception as exc:
            self.mark_error(exc)
            return [Reading(item.get("name", "iPod"), "ERROR", error=True, icon=item.get("icon", "mdi:ipod"),
                            note=str(exc)[:40]) for item in items]
        self.mark_ok()
        count = f"{len(self.tracks)} canciones"
        # A button (in a panel of actions) that opens the iPod.
        return [Reading(item.get("name", "iPod"), count, icon=item.get("icon", "mdi:ipod"), opens=f"music:{self.name}")
                for item in items]

    async def library(self) -> dict[str, Any]:
        """The songs and albums, as the page wants them (short lists, not objects: there may be
        thousands). Read again from the folder every few hours, in the background: meanwhile the
        page gets the library it already had (reading thousands of songs takes a while)."""
        async with self._lock:
            if not self._scanned_at:
                await self._rescan()
        stale = time.monotonic() - self._scanned_at > self.rescan_seconds
        if stale and (self._rescanning is None or self._rescanning.done()):
            self._rescanning = asyncio.create_task(self._rescan_quietly())
        if self._payload is None:
            album_index = {album["id"]: number for number, album in enumerate(self.albums)}
            self._payload = {
                "albums": [[album["id"], album["title"], album["artist"], album["year"]] for album in self.albums],
                "tracks": [[track.id, track.title, track.artist, album_index[track.album_id], track.track,
                            round(track.length)] for track in (self.tracks[id] for id in self._order)],
            }
        # The stars apart: they change without the library changing.
        return {**self._payload, "ratings": dict(self.ratings)} if self.ratings_file else self._payload

    def rate(self, track_id: str, stars: int) -> None:
        """0 to 5 stars for a song (0, none); saved at once."""
        if not self.ratings_file:
            raise PermissionError("las valoraciones no están activadas")
        if track_id not in self.tracks:
            raise KeyError(track_id)
        if not 0 <= stars <= 5:
            raise ValueError("de 0 a 5 estrellas")
        if stars:
            self.ratings[track_id] = stars
        else:
            self.ratings.pop(track_id, None)
        self.ratings_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.ratings_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.ratings, indent=1, sort_keys=True))
        temporary.replace(self.ratings_file)

    def _load_ratings(self) -> dict[str, int]:
        if not self.ratings_file:
            return {}
        try:
            data = json.loads(self.ratings_file.read_text())
        except (OSError, ValueError):
            return {}
        return {str(id): int(stars) for id, stars in data.items() if isinstance(stars, int) and 1 <= stars <= 5}

    async def _rescan(self) -> None:
        if not self.folder.is_dir():
            raise FileNotFoundError("no está la carpeta de música")
        tracks = await asyncio.to_thread(self._scan)
        self._index(tracks)
        self._scanned_at = time.monotonic()

    async def _rescan_quietly(self) -> None:
        # If the folder is gone for a moment (a disk not mounted), the old library stays.
        async with self._lock:
            try:
                await self._rescan()
            except OSError:
                self._scanned_at = time.monotonic()

    def track_path(self, track_id: str) -> Path | None:
        track = self.tracks.get(track_id)
        if track is None:
            return None
        path = (self.folder / track.path).resolve()
        # Only files inside the folder, whatever the index says.
        return path if path.is_relative_to(self.folder.resolve()) and path.is_file() else None

    def cover(self, album_id: str) -> tuple[bytes, str] | None:
        """An album's picture: the first of its songs that has one inside, or an image in its folder."""
        if album_id in self._covers:
            return self._covers[album_id]
        album = next((album for album in self.albums if album["id"] == album_id), None)
        picture = None
        if album:
            paths = [path for path in (self.track_path(id) for id in album["tracks"]) if path]
            picture = next(filter(None, (embedded_picture(path) for path in paths[:3])), None)
            if picture is None and paths:
                picture = folder_picture(paths[0].parent)
        if len(self._covers) >= COVER_CACHE:
            self._covers.pop(next(iter(self._covers)))
        self._covers[album_id] = picture
        return picture

    def _scan(self) -> list[Track]:
        known = self._load_cache()
        found, tracks = {}, []
        for root, dirs, files in os.walk(self.folder):
            # Not the hidden ones (.Trash, macOS's ._ copies of every file).
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for file in sorted(files):
                if file.startswith(".") or Path(file).suffix.lower() not in EXTENSIONS:
                    continue
                path = Path(root) / file
                relative = str(path.relative_to(self.folder))
                try:
                    stat = path.stat()
                except OSError:
                    continue
                stamp = [stat.st_size, int(stat.st_mtime)]
                entry = known.get(relative)
                if not entry or entry.get("stamp") != stamp:
                    entry = {"stamp": stamp, "tags": read_tags(path)}
                found[relative] = entry
                tracks.append(make_track(relative, entry["tags"]))
        self._save_cache(found)
        return tracks

    def _index(self, tracks: list[Track]) -> None:
        albums: dict[str, dict[str, Any]] = {}
        for track in tracks:
            artist = track.album_artist or track.artist
            # By the album's artist and title: two albums called "Greatest Hits" are two albums.
            track.album_id = short_id(f"{artist.lower()}\0{track.album.lower()}")
            album = albums.setdefault(track.album_id, {"id": track.album_id, "title": track.album, "artist": artist,
                                                       "year": track.year, "tracks": []})
            album["tracks"].append(track)
            album["year"] = album["year"] or track.year
        for album in albums.values():
            album["tracks"].sort(key=lambda t: (t.disc, t.track, t.title.lower()))
            album["tracks"] = [track.id for track in album["tracks"]]
        self.albums = sorted(albums.values(), key=lambda a: (sort_key(a["artist"]), a["year"], sort_key(a["title"])))
        self.tracks = {track.id: track for track in tracks}
        # The songs in the order of their albums.
        self._order = [id for album in self.albums for id in album["tracks"]]
        self._payload = None
        self._covers.clear()

    def _load_cache(self) -> dict[str, Any]:
        if not self.cache:
            return {}
        try:
            return json.loads(self.cache.read_text())
        except (OSError, ValueError):
            return {}

    def _save_cache(self, entries: dict[str, Any]) -> None:
        if not self.cache:
            return
        try:
            self.cache.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.cache.with_suffix(".tmp")
            temporary.write_text(json.dumps(entries, ensure_ascii=False))
            temporary.replace(self.cache)
        except OSError:
            pass


def read_tags(path: Path) -> dict[str, Any]:
    """Title, artist, album... and the length, as far as the file says (empty if it can't be read)."""
    try:
        audio = mutagen.File(path, easy=True)
    except Exception:
        return {}
    if audio is None:
        return {}
    first = lambda name: str((audio.tags or {}).get(name, [""])[0]).strip() if audio.tags else ""
    return {
        "title": first("title"), "artist": first("artist"), "album": first("album"),
        "album_artist": first("albumartist"), "track": first("tracknumber"), "disc": first("discnumber"),
        "year": first("date")[:4], "length": float(getattr(audio.info, "length", 0) or 0),
    }


def make_track(relative: str, tags: dict[str, Any]) -> Track:
    """Without tags, the names of the file and its folders: Artist/Album/01 Song.mp3."""
    parts = Path(relative).parts
    folder_album = parts[-2] if len(parts) >= 2 else "Sin álbum"
    folder_artist = parts[-3] if len(parts) >= 3 else "Desconocido"
    return Track(
        id=short_id(relative), path=relative,
        title=tags.get("title") or LEADING_NUMBER.sub("", Path(relative).stem) or Path(relative).stem,
        artist=tags.get("artist") or tags.get("album_artist") or folder_artist,
        album=tags.get("album") or folder_album,
        album_artist=tags.get("album_artist", ""),
        track=leading_number(tags.get("track", "")) or leading_number(Path(relative).stem),
        disc=leading_number(tags.get("disc", "")) or 1,
        year=tags.get("year", ""),
        length=tags.get("length", 0.0),
    )


def embedded_picture(path: Path) -> tuple[bytes, str] | None:
    try:
        audio = mutagen.File(path)
    except Exception:
        return None
    if audio is None:
        return None
    for picture in getattr(audio, "pictures", None) or []:  # FLAC
        return picture.data, picture.mime or "image/jpeg"
    tags = audio.tags or {}
    if hasattr(tags, "getall"):  # MP3 (ID3)
        for frame in tags.getall("APIC"):
            return frame.data, frame.mime or "image/jpeg"
    covers = tags.get("covr") if hasattr(tags, "get") else None
    for cover in covers or []:  # M4A
        return bytes(cover), "image/png" if getattr(cover, "imageformat", 0) == 14 else "image/jpeg"
    return None


def folder_picture(folder: Path) -> tuple[bytes, str] | None:
    try:
        images = sorted(path for path in folder.iterdir() if path.suffix.lower() in IMAGES and not path.name.startswith("."))
    except OSError:
        return None
    images.sort(key=lambda path: (path.stem.lower() not in COVER_NAMES, path.name.lower()))
    for image in images:
        try:
            return image.read_bytes(), mimetypes.guess_type(image.name)[0] or "image/jpeg"
        except OSError:
            continue
    return None


def short_id(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:12]


def leading_number(text: str) -> int:
    """'3/12' → 3, '07 Song' → 7, '' → 0."""
    digits = ""
    for char in str(text).strip():
        if not char.isdigit():
            break
        digits += char
    return int(digits) if digits else 0


def sort_key(text: str) -> str:
    """Artists and albums as on an iPod: "The Beatles" under B."""
    text = text.lower().strip()
    for article in ("the ", "los ", "las ", "el ", "la "):
        if text.startswith(article):
            return text[len(article):]
    return text

import asyncio
import json

from aiohttp.test_utils import TestClient, TestServer
from mutagen.easyid3 import EasyID3
from mutagen.id3 import APIC, ID3

from marianne.config import parse_config
from marianne.server import Dashboard, make_app
from marianne.sources.music import MusicSource, leading_number, sort_key

# One MPEG-1 Layer III frame (128 kbit/s, 44.1 kHz) of silence: 417 bytes, about 26 ms.
FRAME = b"\xff\xfb\x90\x00" + bytes(413)


def song(path, seconds=1, **tags):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(FRAME * int(seconds / 0.026))
    if tags:
        audio = EasyID3()
        for name, value in tags.items():
            audio[name] = value
        audio.save(path)
    return path


def library(tmp_path):
    music = tmp_path / "musica"
    song(music / "Los Inventados" / "Primero" / "02 b.mp3", title="Segunda", artist="Los Inventados",
         album="Primero", tracknumber="2/9", date="2001")
    first = song(music / "Los Inventados" / "Primero" / "01 a.mp3", seconds=2, title="Primera",
                 artist="Los Inventados", album="Primero", tracknumber="1/9", date="2001")
    tags = ID3(first)
    tags.add(APIC(mime="image/png", type=3, data=b"\x89PNG portada"))
    tags.save(first)
    # Without tags: the names of the folders and of the file
    song(music / "Banda Sin Etiquetas" / "Disco Suelto" / "03 Canción suelta.mp3")
    # Not music, hidden, and macOS's copy of a file: left out
    (music / "Los Inventados" / "Primero" / "notas.txt").write_text("x")
    (music / "Los Inventados" / "Primero" / "._01 a.mp3").write_bytes(b"x")
    song(music / ".Trash" / "borrada.mp3", title="Borrada")
    return music


def test_library_from_tags_and_folders(tmp_path):
    source = MusicSource("musica", str(library(tmp_path)), cache=str(tmp_path / "data" / "musica.json"))
    data = asyncio.run(source.library())
    albums = [(title, artist, year) for _, title, artist, year in data["albums"]]
    # "Los Inventados" goes under I, after "Banda"
    assert albums == [("Disco Suelto", "Banda Sin Etiquetas", ""), ("Primero", "Los Inventados", "2001")]
    tracks = [(title, artist, album, number) for _, title, artist, album, number, _ in data["tracks"]]
    assert tracks == [("Canción suelta", "Banda Sin Etiquetas", 0, 3), ("Primera", "Los Inventados", 1, 1),
                      ("Segunda", "Los Inventados", 1, 2)]
    assert data["tracks"][1][5] == 2  # seconds
    assert "mp3" not in str(data) and str(tmp_path) not in str(data)
    assert (tmp_path / "data" / "musica.json").exists()

    # The files only by their ids, and only inside the folder
    first_id = data["tracks"][1][0]
    assert source.track_path(first_id).name == "01 a.mp3"
    assert source.track_path("../../etc/passwd") is None
    # The picture inside the first song
    assert source.cover(data["albums"][1][0]) == (b"\x89PNG portada", "image/png")
    assert source.cover(data["albums"][0][0]) is None


def test_a_picture_in_the_album_folder(tmp_path):
    music = tmp_path / "musica"
    song(music / "Artista" / "Disco" / "01.mp3", title="Una", artist="Artista", album="Disco")
    (music / "Artista" / "Disco" / "otra.png").write_bytes(b"otra")
    (music / "Artista" / "Disco" / "Folder.jpg").write_bytes(b"jpeg")
    source = MusicSource("musica", str(music))
    album = asyncio.run(source.library())["albums"][0][0]
    assert source.cover(album) == (b"jpeg", "image/jpeg")


def test_music_api(tmp_path):
    music = library(tmp_path)
    data = {"boot": False, "sources": {"musica": {"type": "music", "folder": str(music), "key": "i"}},
            "panels": [{"title": "Acciones", "actions": True, "key": "o", "source": "musica",
                        "items": [{"name": "iPod", "icon": "mdi:ipod"}]}]}
    dashboard = Dashboard(parse_config(data, None), demo=False)

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            layout = await (await client.get("/api/layout")).json()
            assert layout["music"] == [{"name": "musica", "key": "i", "ratings": False}]
            assert str(music) not in str(layout)
            await dashboard.reload()
            (button,) = dashboard.state()["panels"][0][0]["readings"]
            assert (button["label"], button["value"], button["opens"]) == ("iPod", "3 canciones", "music:musica")

            library_data = await (await client.get("/api/music/musica/library")).json()
            first = library_data["tracks"][1][0]
            response = await client.get(f"/api/music/musica/track/{first}", headers={"Range": "bytes=0-99"})
            assert response.status == 206 and response.content_type == "audio/mpeg"
            assert len(await response.read()) == 100
            cover = await client.get(f"/api/music/musica/cover/{library_data['albums'][1][0]}")
            assert cover.status == 200 and await cover.read() == b"\x89PNG portada"
            for path in ("/api/music/musica/track/nada", "/api/music/otra/library",
                         f"/api/music/musica/cover/{library_data['albums'][0][0]}"):
                assert (await client.get(path)).status == 404

    asyncio.run(run())


def test_helpers():
    assert leading_number("3/12") == 3 and leading_number("07 Canción") == 7 and leading_number("") == 0
    assert sort_key("The Beatles") == "beatles" and sort_key("Los Planetas") == "planetas"


def test_a_new_look_at_the_folder_doesnt_make_the_page_wait(tmp_path):
    music = library(tmp_path)
    source = MusicSource("musica", str(music), rescan_hours=0)

    async def run():
        assert len((await source.library())["tracks"]) == 3
        song(music / "Nueva" / "Disco" / "01.mp3", title="Nueva", artist="Nueva", album="Disco")
        # Out of date: the old library at once, and the new one once the folder is read again
        assert len((await source.library())["tracks"]) == 3
        await source._rescanning
        source.rescan_seconds = 3600
        assert len((await source.library())["tracks"]) == 4

    asyncio.run(run())


def test_ratings(tmp_path):
    music = library(tmp_path)
    ratings = tmp_path / "data" / "valoraciones.json"
    data = {"boot": False, "sources": {"musica": {"type": "music", "folder": str(music), "ratings": str(ratings)},
                                       "sin": {"type": "music", "folder": str(music)}},
            "panels": [{"title": "A", "source": "musica", "items": [{"name": "iPod"}, {"source": "sin"}]}]}
    dashboard = Dashboard(parse_config(data, None), demo=False)

    async def run():
        async with TestClient(TestServer(make_app(dashboard))) as client:
            layout = await (await client.get("/api/layout")).json()
            assert [m["ratings"] for m in layout["music"]] == [True, False]
            library_data = await (await client.get("/api/music/musica/library")).json()
            assert library_data["ratings"] == {}
            first, second = library_data["tracks"][1][0], library_data["tracks"][2][0]
            assert (await client.put(f"/api/music/musica/rating/{first}", json={"stars": 5})).status == 200
            assert (await client.put(f"/api/music/musica/rating/{second}", json={"stars": 3})).status == 200
            assert (await client.put(f"/api/music/musica/rating/{second}", json={"stars": 0})).status == 200
            assert (await (await client.get("/api/music/musica/library")).json())["ratings"] == {first: 5}
            assert json.loads(ratings.read_text()) == {first: 5}
            assert (await client.put(f"/api/music/musica/rating/{first}", json={"stars": 6})).status == 400
            assert (await client.put(f"/api/music/musica/rating/{first}", json={"stars": "x"})).status == 400
            assert (await client.put("/api/music/musica/rating/nada", json={"stars": 2})).status == 404
            assert (await client.put(f"/api/music/sin/rating/{first}", json={"stars": 2})).status == 403
        # Read back on the next start
        assert MusicSource("musica", str(music), ratings=str(ratings)).ratings == {first: 5}

    asyncio.run(run())

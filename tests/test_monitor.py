import asyncio
from datetime import datetime, timedelta

import httpx
import pytest

from marianne.config import ConfigError, parse_config
from marianne.sources.monitor import MonitorSource


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.host == "caido.test":
        raise httpx.ConnectError("connection refused")
    if request.url.host == "roto.test":
        return httpx.Response(502)
    if request.url.host == "redirige.test":
        return httpx.Response(302, headers={"Location": "https://login.test/"})
    return httpx.Response(200, text="ok")


def source() -> MonitorSource:
    return MonitorSource("servicios", transport=httpx.MockTransport(handler))


def test_monitor_up_down_and_errors():
    items = [
        {"url": "https://bien.test", "name": "Bien"},
        {"url": "https://redirige.test", "name": "Redirige"},
        {"url": "https://roto.test", "name": "Roto"},
        {"url": "https://caido.test", "name": "Caído", "alert": False},
    ]
    bien, redirige, roto, caido = asyncio.run(source().fetch(items))
    assert bien.switch and bien.value.endswith(" ms") and not bien.alert and bien.link == "https://bien.test"
    assert redirige.switch
    assert roto.switch is False and roto.value == "ERROR 502" and roto.alert
    assert caido.switch is False and caido.value == "CAÍDO" and not caido.alert


def test_monitor_alarm_after_minutes_down():
    monitor = source()
    item = {"url": "https://caido.test", "name": "Jellyfin", "alarm_after": 5}
    assert asyncio.run(monitor.fetch([item]))[0].alarm is None
    monitor._down_since[item["url"]] = datetime.now() - timedelta(minutes=6)
    assert asyncio.run(monitor.fetch([item]))[0].alarm == "Jellyfin CAÍDO · desde hace 6 min"


def test_monitor_items_need_url():
    data = {"sources": {"servicios": {"type": "monitor"}},
            "panels": [{"title": "Servicios", "source": "servicios", "items": [{"name": "Sin url"}]}]}
    with pytest.raises(ConfigError):
        parse_config(data, None)


def test_icons_are_downloaded_once_and_validated():
    from marianne.icons import FALLBACK, Icons

    calls = []

    def cdn(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if "missing" in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, text='<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>')

    async def run():
        icons = Icons(transport=httpx.MockTransport(cdn))
        assert "<svg" in await icons.get("mdi", "dolphin")
        assert "<svg" in await icons.get("mdi", "dolphin")
        assert await icons.get("si", "missing") == FALLBACK
        assert await icons.get("mdi", "../secret") is None
        assert await icons.get("fa", "dolphin") is None
        await icons.close()

    asyncio.run(run())
    assert calls == ["/npm/@mdi/svg@7.4.47/svg/dolphin.svg", "/npm/simple-icons@16.35.0/icons/missing.svg"]


def test_icon_names_are_checked_in_the_config():
    data = {"sources": {"servicios": {"type": "monitor"}},
            "panels": [{"title": "Servicios", "source": "servicios", "icons": True,
                        "items": [{"name": "Jellyfin", "url": "https://jellyfin.test", "icon": "jellyfin"}]}]}
    with pytest.raises(ConfigError):
        parse_config(data, None)
    data["panels"][0]["items"][0]["icon"] = "si:jellyfin"
    assert parse_config(data, None).panels[0].icons


def test_services_with_an_update_in_whats_up_docker():
    def wud(request: httpx.Request) -> httpx.Response:
        if request.url.host == "wud.test":
            return httpx.Response(200, json=[
                {"name": "bookorbit-db", "updateAvailable": True},
                {"name": "bookorbit-app", "updateAvailable": False},
                {"name": "jellyfin", "updateAvailable": False},
            ])
        return handler(request)

    monitor = MonitorSource("servicios", wud="https://wud.test/", transport=httpx.MockTransport(wud))
    items = [
        {"url": "https://bien.test", "name": "Bookorbit", "containers": ["bookorbit-app", "bookorbit-db"]},
        {"url": "https://bien.test", "name": "Jellyfin", "container": "jellyfin"},
        {"url": "https://bien.test", "name": "Sin contenedor"},
    ]
    bookorbit, jellyfin, other = asyncio.run(monitor.fetch(items))
    assert bookorbit.update and not jellyfin.update and not other.update
    # An update is not an alert: the service is up
    assert not bookorbit.alert and bookorbit.switch


def test_whats_up_docker_down_marks_nothing():
    def wud(request: httpx.Request) -> httpx.Response:
        if request.url.host == "wud.test":
            raise httpx.ConnectError("refused")
        return handler(request)

    monitor = MonitorSource("servicios", wud="https://wud.test", transport=httpx.MockTransport(wud))
    (reading,) = asyncio.run(monitor.fetch([{"url": "https://bien.test", "name": "X", "container": "x"}]))
    assert not reading.update and reading.switch

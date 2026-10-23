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
    assert bien.switch and bien.value.endswith(" ms") and not bien.alert
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

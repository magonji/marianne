import asyncio
from collections import namedtuple

import pytest

from marianne.config import ConfigError, parse_config
from marianne.sources import system
from marianne.sources.system import SystemSource

GB = 1024**3
Memory = namedtuple("Memory", "total available percent")
Swap = namedtuple("Swap", "total used percent")
Disk = namedtuple("Disk", "total used percent")
Sensor = namedtuple("Sensor", "current")


@pytest.fixture
def fake_machine(monkeypatch):
    psutil = system.psutil
    monkeypatch.setattr(psutil, "cpu_percent", lambda: 37.0)
    monkeypatch.setattr(psutil, "cpu_count", lambda: 4)
    monkeypatch.setattr(psutil, "virtual_memory", lambda: Memory(16 * GB, 4 * GB, 75.0))
    monkeypatch.setattr(psutil, "swap_memory", lambda: Swap(0, 0, 0.0))
    monkeypatch.setattr(psutil, "disk_usage", lambda path: Disk(500 * GB, 450 * GB, 90.0))
    monkeypatch.setattr(psutil, "sensors_temperatures", lambda: {"coretemp": [Sensor(48.0), Sensor(52.5)]}, raising=False)
    monkeypatch.setattr(psutil, "boot_time", lambda: system.time.time() - 3 * 86400 - 5.5 * 3600)
    monkeypatch.setattr(system.os, "getloadavg", lambda: (0.5, 0.75, 1.0))


def test_system_readings(fake_machine):
    items = [{"field": f} for f in ("cpu", "memory", "swap", "temperature", "uptime", "load")]
    items.append({"field": "disk", "path": "/datos", "alert_above": 85})
    cpu, memory, swap, temperature, uptime, load, disk = asyncio.run(SystemSource("equipo").fetch(items))
    assert (cpu.value, cpu.unit, cpu.fraction, cpu.note) == ("37", "%", 0.37, "4 núcleos")
    assert (memory.value, memory.note) == ("75", "12.0/16.0 GB")
    assert swap.value == "N/D"
    assert (temperature.value, temperature.unit, temperature.fraction) == ("52", "°C", None)
    assert uptime.value == "3 d 5 h"
    assert load.value == "0.50 · 0.75 · 1.00"
    assert disk.label == "Disco /datos" and disk.alert and disk.note == "450.0/500.0 GB"


def test_system_fields_are_checked():
    data = {"sources": {"equipo": {"type": "system"}},
            "panels": [{"title": "Servidor", "source": "equipo", "items": [{"field": "gpu"}]}]}
    with pytest.raises(ConfigError):
        parse_config(data, None)


def test_system_reads_the_host_mounted_in_docker(fake_machine, tmp_path, monkeypatch):
    (tmp_path / "etc").mkdir()
    (tmp_path / "etc/hostname").write_text("servidor\n")
    (tmp_path / "etc/os-release").write_text('NAME="Debian"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n')
    paths = []
    monkeypatch.setattr(system.psutil, "disk_usage", lambda path: paths.append(path) or Disk(GB, GB, 100.0))
    items = [{"field": "hostname"}, {"field": "platform"}, {"field": "disk", "path": "/mnt/datos"}]
    hostname, platform, _ = asyncio.run(SystemSource("equipo", host_root=str(tmp_path)).fetch(items))
    assert hostname.value == "servidor" and platform.value == "Debian GNU/Linux 12 (bookworm)"
    assert paths == [str(tmp_path / "mnt/datos")]
    # Without the mount (outside Docker), the local machine.
    assert SystemSource("equipo", host_root="/no/existe").host is None


def test_big_disks_in_terabytes():
    from marianne.sources.system import sizes

    assert sizes(450 * GB, 500 * GB) == "450.0/500.0 GB"
    assert sizes(3.5 * 1024 * GB, 4.6 * 1024 * GB) == "3.5/4.6 TB"

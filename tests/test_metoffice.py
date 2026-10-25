import asyncio
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

from marianne.sources.metoffice import MetOfficeSource, parse_warnings, warning_reading

UK = ZoneInfo("Europe/London")


def feed(*items):
    entries = "".join(f"""<item><title>{title}</title><link>https://www.metoffice.gov.uk/w#{n}</link>
        <description>{description}</description></item>""" for n, (title, description) in enumerate(items))
    return f"""<?xml version="1.0"?><rss version="2.0"><channel><title>Met Office warnings for Strathclyde</title>
        <pubDate>Sun, 25 Oct 2026 10:00:27 GMT</pubDate>{entries}</channel></rss>""".encode()


AMBER = ("Amber warning of wind affecting Strathclyde",
         "Amber warning of wind affecting Strathclyde: Glasgow, Inverclyde valid from 2000 Sat 24 Oct to 2100 Sun 25 Oct")
YELLOW = ("Yellow warning of rain and wind affecting Strathclyde",
          "Yellow warning of rain and wind affecting Strathclyde: Argyll and Bute, Glasgow valid from 0600 Mon 26 Oct to 1800 Mon 26 Oct")
ELSEWHERE = ("Yellow warning of snow affecting Strathclyde",
             "Yellow warning of snow affecting Strathclyde: Argyll and Bute valid from 0000 Sun 25 Oct to 2359 Sun 25 Oct")


def test_parse_warnings_in_uk_time():
    amber, yellow, _ = parse_warnings(feed(AMBER, YELLOW, ELSEWHERE))
    assert (amber.level, amber.kind) == ("amber", "viento")
    assert amber.starts == datetime(2026, 10, 24, 20, tzinfo=UK) and amber.ends == datetime(2026, 10, 25, 21, tzinfo=UK)
    assert yellow.kind == "lluvia, viento"


def test_amber_goes_to_the_alarm_strip_and_yellow_only_to_a_row():
    amber, yellow, _ = parse_warnings(feed(AMBER, YELLOW, ELSEWHERE))
    during = datetime(2026, 10, 25, 12, tzinfo=UK)
    reading = warning_reading({}, amber, during)
    assert reading.label == "⚠ ámbar · viento" and reading.value == "hasta dom 21:00"
    assert reading.alert and reading.alarm == "Aviso ámbar por viento · hasta dom 21:00"
    assert reading.detail["text"].startswith("Amber warning") and reading.link
    later = warning_reading({}, yellow, during)
    assert later.value == "desde lun 06:00" and not later.alert and later.alarm is None
    # alarm_from: yellow makes even the yellow ones an alarm; red, only the red ones
    assert warning_reading({"alarm_from": "yellow"}, yellow, during).alarm
    assert warning_reading({"alarm_from": "red"}, amber, during).alarm is None


def test_only_the_area_the_current_ones_and_the_worst_first():
    from marianne.sources.metoffice import current_warnings

    warnings = parse_warnings(feed(YELLOW, AMBER, ELSEWHERE))
    during = datetime(2026, 10, 25, 12, tzinfo=UK)
    assert [(w.level, w.kind) for w in current_warnings(warnings, "Glasgow", during)] == [("amber", "viento"), ("yellow", "lluvia, viento")]
    # The amber one is over by Monday morning
    monday = datetime(2026, 10, 26, 8, tzinfo=UK)
    assert [w.level for w in current_warnings(warnings, "Glasgow", monday)] == ["yellow"]
    assert len(current_warnings(warnings, None, during)) == 3


def test_no_warnings():
    content = feed()
    source = MetOfficeSource("avisos", "st", transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content)))
    (reading,) = asyncio.run(source.fetch([{}]))
    assert reading.label == "Sin avisos" and reading.switch is False and not reading.alert

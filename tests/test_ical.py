import asyncio
from datetime import date

import httpx
import pytest

from marianne.sources.ical import IcalSource, parse_events

ICS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:1
SUMMARY:Dentista
DTSTART;TZID=Europe/London:20261027T100000
DTEND;TZID=Europe/London:20261027T110000
END:VEVENT
BEGIN:VEVENT
UID:2
SUMMARY:Yoga
DTSTART;TZID=Europe/London:20261026T183000
DTEND;TZID=Europe/London:20261026T193000
RRULE:FREQ=WEEKLY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:3
SUMMARY:Viaje a Madrid
DTSTART;VALUE=DATE:20261102
DTEND;VALUE=DATE:20261105
END:VEVENT
END:VCALENDAR
"""


def test_parse_events_with_repeats_and_all_day():
    events = parse_events(ICS, "Personal", date(2026, 10, 1), date(2026, 12, 1))
    names = [(e["name"], e["start"][:10]) for e in sorted(events, key=lambda e: e["start"])]
    assert names == [("Yoga", "2026-10-26"), ("Dentista", "2026-10-27"), ("Viaje a Madrid", "2026-11-02"),
                     ("Yoga", "2026-11-02"), ("Yoga", "2026-11-09")]
    trip = next(e for e in events if e["name"] == "Viaje a Madrid")
    assert trip["all_day"] and trip["end"] == "2026-11-05" and trip["calendar"] == "Personal"


def test_source_keeps_the_links_secret_and_survives_a_broken_calendar():
    def handler(request):
        return httpx.Response(500) if "roto" in request.url.host else httpx.Response(200, content=ICS)

    source = IcalSource("agenda", [{"name": "Personal", "url": "webcal://cal.test/secreto.ics"},
                                   {"name": "Roto", "url": "https://roto.test/x.ics"}],
                        transport=httpx.MockTransport(handler))
    assert "secreto" not in source.describe()
    (reading,) = asyncio.run(source.fetch([{"name": "Eventos"}]))
    # One reading with every event: the page lists today's, or tomorrow's
    assert reading.label == "Eventos" and len(reading.agenda) == 5 and not reading.hidden
    with pytest.raises(ValueError):
        IcalSource("agenda", [{"name": "Sin url", "url": ""}])

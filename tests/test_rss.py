import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from marianne.config import ConfigError, parse_config
from marianne.sources.rss import RssSource, age, parse_feed

RSS = b"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Diario</title>
  <item><title>Antigua</title><link>https://diario.test/1</link><pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate></item>
  <item><title>Con &lt;b&gt;etiquetas&lt;/b&gt; &amp;amp; entidades</title><link>javascript:alert(1)</link>
        <dc:date>2026-10-23T09:00:00Z</dc:date></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
  <entry><title>Nueva</title><link rel="alternate" href="https://blog.test/nueva"/><updated>2026-10-23T11:00:00Z</updated></entry>
</feed>"""


def handler(request: httpx.Request) -> httpx.Response:
    if request.url.host == "roto.test":
        return httpx.Response(403)
    return httpx.Response(200, content=ATOM if request.url.host == "blog.test" else RSS)


def source() -> RssSource:
    return RssSource("noticias", transport=httpx.MockTransport(handler))


def test_parse_rss_and_atom():
    antigua, etiquetas = parse_feed(RSS)
    assert antigua.title == "Antigua" and antigua.link == "https://diario.test/1"
    assert antigua.published == datetime(2026, 10, 22, 10, tzinfo=timezone.utc)
    assert etiquetas.title == "Con etiquetas & entidades" and etiquetas.link is None
    (nueva,) = parse_feed(ATOM)
    assert nueva.title == "Nueva" and nueva.link == "https://blog.test/nueva"


def test_feeds_are_merged_newest_first_with_a_limit():
    item = {"feeds": ["https://diario.test/rss", "https://blog.test/atom", "https://roto.test/rss"], "limit": 2}
    readings = asyncio.run(source().fetch([item]))
    assert [r.label for r in readings] == ["Nueva", "Con etiquetas & entidades"]
    assert readings[0].link == "https://blog.test/nueva"


def test_a_broken_feed_alone_is_an_error():
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(source().fetch([{"url": "https://roto.test/rss"}]))


def test_age():
    now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
    assert age(now - timedelta(minutes=5), now) == "5 min"
    assert age(now - timedelta(hours=3, minutes=20), now) == "3 h"
    assert age(now - timedelta(days=2, hours=1), now) == "2 d"
    assert age(None, now) == ""


def test_rss_items_need_a_feed():
    data = {"sources": {"noticias": {"type": "rss"}},
            "panels": [{"title": "Noticias", "source": "noticias", "items": [{"limit": 7}]}]}
    with pytest.raises(ConfigError):
        parse_config(data, None)


def test_detail_has_the_feed_name_lede_and_text():
    feed = b"""<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>El Diario</title>
  <item><title>Titular</title><link>https://diario.test/1</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate>
    <description>La entradilla.</description>
    <content:encoded><![CDATA[<p>Primer <b>p&aacute;rrafo</b>.</p><img src="x.jpg"><p>Segundo<br>con salto.</p><p><a href="/1">Seguir leyendo</a></p>]]></content:encoded>
  </item>
</channel></rss>"""
    from marianne.sources.rss import detail

    (entry,) = parse_feed(feed)
    story = detail(entry)
    assert story["feed"] == "El Diario"
    assert story["text"] == "La entradilla.\n\nPrimer párrafo.\n\nSegundo\ncon salto."
    assert story["date"].startswith("23/10 ")


def test_republished_stories_keep_only_the_newest_version():
    from marianne.sources.rss import Entry, unique

    def entry(title, hour, link=None):
        return Entry(title, link, datetime(2026, 10, 23, hour, tzinfo=timezone.utc))

    entries = [  # newest first, as fetch() sorts them
        entry("El Gobierno aprueba los presupuestos de 2027", 12),
        entry("Muere el escritor Ryu Murakami", 11, "https://diario.test/murakami"),
        entry("El Gobeirno aprueba los presupuestos de 2027", 10),  # the typo they fixed
        entry("¡El Gobierno aprueba los presupuestos de 2027!", 9),  # only punctuation
        entry("Murakami, escritor japonés", 8, "https://diario.test/murakami"),  # same link
        entry("El Gobierno aprueba la reforma fiscal", 7),  # a different story
    ]
    assert [e.hour for e in (x.published for x in unique(entries, 7))] == [12, 11, 7]
    assert len(unique(entries, 2)) == 2


def test_duplicates_across_merged_feeds_and_the_limit():
    feed = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>D</title>
      <item><title>Primera noticia de hoy</title><link>https://d.test/1b</link><pubDate>Fri, 23 Oct 2026 12:00:00 GMT</pubDate></item>
      <item><title>Primera noticia de hoy.</title><link>https://d.test/1a</link><pubDate>Fri, 23 Oct 2026 09:00:00 GMT</pubDate></item>
      <item><title>Segunda noticia distinta</title><link>https://d.test/2</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate></item>
    </channel></rss>"""
    source = RssSource("n", transport=httpx.MockTransport(lambda request: httpx.Response(200, content=feed)))
    readings = asyncio.run(source.fetch([{"url": "https://d.test/rss", "limit": 7}]))
    assert [r.link for r in readings] == ["https://d.test/1b", "https://d.test/2"]

# MARIANNE

Panel retro en el navegador. Reúne en una sola pantalla la información que te importa de
casa: sensores de **Home Assistant**, la **previsión del tiempo** de OpenWeather, las
**fases de la luna** y valores **sacados de webs**.

Ámbar naranja (por defecto), fósforo verde o azul Commodore 64, con líneas de barrido de
monitor CRT, reloj grande y arranque tipo BIOS. En pantallas estrechas (el móvil) los paneles
se ponen en una columna.

Un pequeño servidor en Python consulta las fuentes y la página solo recibe los valores ya
calculados: el token de Home Assistant y las claves nunca llegan al navegador.

Marianne está basado en **elinor**, el mejor dashboard del mundo para tu terminal.

## Qué hace

- **Paneles configurables** en un `config.yaml`: filas con puntos guía, barras, indicadores
  ● encendido / ○ apagado, dígitos grandes y varios valores en la misma fila
  (temperatura y humedad de cada habitación, por ejemplo).
- **Alertas**: un valor que pasa de un umbral, una puerta abierta o una fase de la lavadora
  se pintan en rojo y parpadean, y el panel entero se enmarca en rojo.
- **Franja de alarma** a lo ancho de la pantalla cuando una alerta dura demasiado
  (el congelador lleva 2 minutos abierto, hay una fuga de agua…), con pitido opcional.
  Con la tecla `A` se da por vista: sigue en rojo, pero deja de parpadear.
- **Franja de aviso** en verde para buenas noticias, como que mañana va a hacer buen día.
- **Paneles emergentes**: los que no necesitas ver siempre (las baterías, por ejemplo) se
  abren con una tecla, y su opción del menú parpadea si tienen alguna alerta.
- **Home Assistant**: traducción de estados, horas en tu zona horaria, tendencia ▲▼ y
  máxima/mínima del día desde el historial, y aviso de sensores que han dejado de informar.
- **El tiempo** de OpenWeather (API gratuita): temperatura actual, resumen del día, máxima, mínima, lluvia,
  viento, próximas horas y si mañana hará buen día.
- **Esquema del sol**: el arco del día con el sol encima, las horas de alba, salida,
  mediodía, puesta y anochecer, y la elevación y el azimut.
- **Fases de la luna** calculadas localmente (algoritmo de Jean Meeus, sin internet).
- **Pomodoro**: cuenta atrás con descanso automático. Al terminar cada fase suenan tres
  campanadas y el aviso parpadea hasta pulsar una tecla. Basta con definir la fuente: mientras
  está en uso aparece centrada en la cabecera; también puede tener su propio panel.
- **Fechas señaladas**: cuántos días faltan para cumpleaños, viajes o fiestas, con aviso el
  mismo día, y barras de progreso del día, la semana, el mes, el año y la vida.
- **Scraping web**: cualquier valor de una página con un selector CSS.
- **El servidor**: CPU, carga, memoria, swap, disco, temperatura y tiempo encendido del
  equipo en el que corre Marianne.
- **Monitor de servicios**: comprueba que tus servicios web responden y cuánto tardan; si
  alguno se cae, sale en rojo.

## Probarlo ya

Hace falta [uv](https://docs.astral.sh/uv/).

```sh
uv run marianne --demo                  # datos simulados, en http://127.0.0.1:8080
uv run marianne --demo --theme phosphor
```

| Tecla | Acción |
|---|---|
| `R` | Refrescar todos los paneles |
| `T` | Cambiar de tema (ámbar → Commodore 64 → fósforo verde) |
| `A` | Alerta vista: deja de parpadear y sale de la franja de alarma (sigue en rojo); si se resuelve y vuelve, avisa de nuevo |
| `P` | Pomodoro: iniciar / pausar |
| `X` | Pomodoro: reiniciar |
| `B`… | Abrir / cerrar un panel emergente (la tecla la eliges tú con `key:`) |
| `M`… | Siguiente página de un panel con páginas (la tecla la eliges tú con `page_key:`; también con un clic en el título) |
| `Esc` | Cerrar el panel emergente |

Todas están también en la barra de abajo, para usarlas con el ratón o el dedo. El tema, la
página de cada panel y las alertas vistas se recuerdan en cada navegador. Los navegadores no
dejan sonar nada hasta la primera tecla o clic en la página.

## Con tu Home Assistant

1. Crea un token de larga duración en Home Assistant (tu perfil → Seguridad).
2. `export HASS_TOKEN=...` (por ejemplo en tu `~/.zshrc`).
3. `cp config.example.yaml config.yaml` y pon tu URL y tus entidades.
4. `uv run marianne` y abre http://127.0.0.1:8080.

El fichero de configuración se busca en `./config.yaml` y en `~/.config/marianne/config.yaml`,
o se indica con `marianne -c ruta.yaml`. `config.yaml` está en `.gitignore`: ahí pueden ir tus
claves sin miedo a subirlas.

Los `${VARIABLES}` de `config.yaml` salen del entorno o de un fichero `.env` (también en
`.gitignore`) junto a `config.yaml` o en el directorio actual, con líneas `OPENWEATHER_KEY=...`.
Si una variable está en los dos sitios, gana la de la shell.

| Opción | Para qué |
|---|---|
| `--host 0.0.0.0` | Abrirlo desde el móvil u otro ordenador (por defecto, solo desde este) |
| `--port 8080` | Puerto |
| `--theme c64` | Tema, en lugar del de `config.yaml` |
| `--demo` | Datos simulados en lugar de Home Assistant |

La página no pide contraseña: con `--host 0.0.0.0` la verá cualquiera que llegue a ese
puerto. Mejor solo en tu red o por una VPN como Tailscale.

Para saber los nombres de tus entidades: Herramientas para desarrolladores → Estados.

## Con Docker

```sh
cp config.example.yaml config.yaml   # y adáptalo
cp .env.example .env                 # y pon HASS_TOKEN (y OPENWEATHER_KEY si lo usas)
docker compose up -d --build         # http://<este equipo>:8080
```

- `config.yaml` se monta en el contenedor en solo lectura: tras cambiarlo basta con
  `docker compose restart`. Tiene que poder leerlo cualquier usuario (el contenedor corre con
  el uid 1000): `chmod 644 config.yaml`.
- Los secretos van en `.env` (está en `.gitignore`), y `config.yaml` los pide con `${HASS_TOKEN}`.
- `TZ` en `.env` fija la zona horaria de las horas que se muestran (`Europe/London` por defecto).
- La `url` de Home Assistant tiene que ser alcanzable desde el contenedor: una IP o nombre de
  la red, no `localhost`.
- El panel del servidor (`type: system`) lee CPU, memoria, carga y tiempo encendido del
  servidor desde el contenedor. Para los discos, el nombre y el sistema, `compose.yaml` monta
  el `/` del servidor en `/host` (solo lectura) y la fuente lo usa con `host_root: /host`;
  `path: /mnt/datos` se refiere entonces al disco del servidor. Fuera de Docker se ignora.
- Para actualizar tras un `git pull`: `docker compose up -d --build`.
- Para verlo solo desde el propio equipo, cambia el puerto en `compose.yaml` a `"127.0.0.1:8080:8080"`.

## Configuración

`config.example.yaml` tiene ejemplos comentados de todo. Resumen:

```yaml
theme: amber            # amber | phosphor | c64
columns: 3              # columnas de la rejilla
bell: false             # pitido cada 5 s mientras haya una alarma

sources:
  homeassistant:
    type: homeassistant
    url: http://homeassistant.local:8123
    token: ${HASS_TOKEN}
  tiempo:
    type: openweather
    api_key: ${OPENWEATHER_KEY}
    city: Glasgow,GB
  luna:
    type: moon

panels:
  - title: Clima
    source: homeassistant
    items:
      - entity: sensor.temperatura_salon
        name: Salón
        decimals: 1
        also:                           # humedad en la misma fila
          entity: sensor.humedad_salon
          alert_above: 65
```

### Fuentes

| `type` | Qué es | Elementos |
|---|---|---|
| `homeassistant` | REST API de Home Assistant (`url`, `token`, `verify_ssl`) | `entity:` |
| `openweather` | Previsión gratuita de openweathermap.org (`api_key`, `city`, `lang`) | `field:` `now` (temperatura actual, con un dibujo del tiempo que hace si va en grande), `summary`, `max`, `min`, `rain_probability`, `rain`, `next_rain` (cuándo vuelve a llover), `wind`, `hours`, `good_day` |
| `moon` | Fases de la luna calculadas en local | `field:` `phase`, `next_phase` |
| `web` | Descarga una página y extrae un valor | `url:` y `selector:` (CSS), opcionales `attr`, `regex`, `numeric` |
| `monitor` | Comprueba que unas webs responden (`timeout`, `verify_ssl`): ● y el tiempo de respuesta, o ○ `CAÍDO` / `ERROR 502` en rojo | `url:`, opcionales `alert: false`, `alarm_after`, `alarm_text` |
| `system` | El equipo en el que corre Marianne | `field:` `cpu`, `load`, `memory`, `swap`, `disk` (con `path`, `/` por defecto), `temperature` (no en macOS), `uptime`, `hostname`, `platform`. Opción de la fuente: `host_root` (ver Docker) |
| `pomodoro` | Temporizador (`work`, `short_break`, `long_break` en minutos, `long_every`, `start_key`, `reset_key`) | `field:` `timer`, `status`, `count` |
| `dates` | Días hasta fechas señaladas (`sort`) y barras de progreso | `date:` `2026-12-25` (fija) o `12-25` (cada año), opcionales `yearly`, `soon`; o `progress:` `day`, `week`, `month`, `year`, `life` (con `birth`, `end` y opcional `days_left`) |

### Opciones de panel

| Opción | Para qué |
|---|---|
| `title`, `source` | Título y fuente por defecto de sus elementos |
| `refresh` | Segundos entre actualizaciones (10 por defecto) |
| `span`, `rows` | Columnas y filas de la rejilla que ocupa |
| `big: true` | El primer valor, en dígitos grandes |
| `key: b` | Fuera de la rejilla: se abre como ventana con esa tecla (o con un clic en la barra de abajo) |
| `pages`, `page_key: m` | Varias páginas de elementos (`- name: …` con sus `items`) que se van alternando con esa tecla, p. ej. un teléfono por página; el nombre de la página es el título |

### Opciones de elemento

| Opción | Para qué |
|---|---|
| `name` | Etiqueta (si no, el nombre de la entidad) |
| `source` | Otra fuente distinta de la del panel |
| `attribute` | Mostrar un atributo en vez del estado |
| `unit`, `decimals`, `scale` | Unidad, decimales y factor (`0.001` para pasar de m a km) |
| `format` | Fechas: `time`, `date`, `datetime`, `auto` o un patrón `strftime` |
| `map` | Traducir estados de texto (`run: LAVANDO`) |
| `on_text`, `off_text`, `invert` | Textos para on/off; `invert` para sensores al revés |
| `on_states` | Estados de texto que cuentan como ● encendido (`[heating]`) |
| `since: true` | Añade la hora del último cambio |
| `on_today: true` | Tiempo que lleva encendido hoy desde medianoche (con `on_states`, `attribute`, `invert`) |
| `bar`, `min`, `max` | Barra (automática para %) y su escala |
| `also` | Uno o varios valores más en la misma fila (en OpenWeather, campos: `also: [max, min]`; junto a un valor grande van en pequeño a su lado) |
| `replace: true` | En un valor de `also`: sustituye al principal si no está vacío (`map: {none: "", eco: ECO}`) |
| `hidden: true` | No se muestra, pero sus alertas y alarmas siguen activas |
| `alert: true` | Alerta mientras esté encendido / abierto |
| `alert_above`, `alert_below` | Alerta por umbral numérico |
| `alert_states` | Alerta con ciertos estados de texto (`[finish]`) |
| `alarm_after`, `alarm_text` | Franja de alarma si la alerta dura N minutos, con este texto |
| `stale_after` | En rojo si el sensor lleva N minutos sin informar |
| `trend`, `trend_steady` | Flecha ▲▼► con el cambio respecto a hace N horas |
| `stats: true` | Filas con la máxima y la mínima de hoy (`stats: beside`: al lado del valor, ▲ ▼) |
| `records: true` | Filas con la máxima y la mínima de toda la historia, de las estadísticas a largo plazo de Home Assistant |
| `sun` | Parte del esquema del sol: `dawn`, `rising`, `noon`, `setting`, `dusk`, `elevation`, `azimuth` |

## Desarrollo

```sh
uv run pytest
```

```
Dockerfile, compose.yaml, .env.example   instalación con Docker
src/marianne/
  __init__.py          punto de entrada
  server.py            servidor (aiohttp): sondea las fuentes y sirve la página y su API
  config.py            carga y validación de config.yaml
  sun.py               papeles del esquema del sol
  demo.yaml            configuración del modo demo
  static/
    index.html         la página
    style.css          estilos y temas
    app.js             dibuja los paneles, teclas, sonido y arranque
  sources/
    base.py            interfaz Source y Reading, alertas
    homeassistant.py   estados, historial, alarmas
    openweather.py     previsión y "buen día mañana"
    moon.py            fases de la luna (Meeus)
    pomodoro.py        temporizador pomodoro
    dates.py           cuenta atrás de fechas señaladas
    web.py             scraping con selectores CSS
    monitor.py         monitor de servicios web
    system.py          CPU, memoria y disco de este equipo
    demo.py            datos simulados
```

API del servidor: `GET /api/layout` (paneles y opciones, sin entidades ni claves),
`GET /api/state` (lecturas de cada panel y página, estado de las fuentes y del pomodoro),
`POST /api/reload` y `POST /api/pomodoro/<fuente>/toggle|reset`.

Para añadir una fuente nueva: una subclase de `Source` con `async fetch(items) -> list[Reading]`,
registrada en `sources/__init__.py`.

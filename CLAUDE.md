# Marianne

Panel retro en el navegador: un servidor aiohttp (`src/marianne/server.py`) consulta las
fuentes y la página (`src/marianne/static/`: `index.html`, `style.css`, `app.js`, JS sin
dependencias) dibuja los paneles a partir de `GET /api/layout` y `GET /api/state` (sondeo
cada segundo). El README describe el uso, la configuración y la instalación con Docker.

## Origen: elinor

Marianne salió de **elinor**, el mismo panel para el terminal (Textual), en `../elinor`.
Desde octubre de 2026 son **proyectos independientes**: no toques elinor desde aquí ni
preguntes si llevar los cambios al otro proyecto. La página imita
el aspecto de elinor (filas con puntos guía, barras, dígitos grandes, esquema del sol,
franjas de alarma y aviso, cabecera con el pomodoro, barra de estado con las teclas).

## Forma de trabajar

- El usuario escribe en español; la interfaz y el README van en español, los comentarios
  del código en inglés.
- Cambios pequeños e iterativos; cuando diga "commit and push", hazlo (rama `main`).
- `uv run pytest` antes de cada commit.

## Datos personales: nunca en git

- `config.yaml` y `.env` están en `.gitignore` y deben seguir ahí: tienen la URL de Home
  Assistant, la clave de OpenWeather, la fecha de nacimiento (barra de vida) y los nombres
  de personas y dispositivos.
- Antes de cada commit revisa el diff preparado (`git diff --cached`) buscando valores
  sacados de `config.yaml`: la clave `api_key`, la IP/host de la `url` de Home Assistant,
  la fecha `birth`, `HASS_TOKEN=`, y nombres de teléfonos, personas, la calle y la red wifi
  que aparezcan en los valores reales. No copies esos valores a ficheros que se suban
  (tampoco a este).
- `config.example.yaml`, los tests y cualquier captura usan solo datos inventados o el
  modo `--demo`.

## Probar con datos reales

- Los secretos (`HASS_TOKEN`, `OPENWEATHER_KEY`, y `TZ` para Docker) están en `.env`, que
  Marianne lee al arrancar: basta con `uv run marianne --port 8797` (en segundo plano). No
  muestres sus valores (enmascáralos con `sed 's/=.*/=…/'`).
- El puerto 8765 lo ocupa otro proceso del usuario: no lo uses ni lo cierres.
- La fuente demo tarda hasta 0,4 s por petición (latencia simulada): tenlo en cuenta en tests.

## Capturas para revisar la página

`firefox --screenshot` captura al cargar, antes de que lleguen los datos. Lo que funciona:
guardar `/api/layout` y `/api/state` en JSON, generar una copia de `index.html` en un
directorio temporal con un `<script>` que sustituye `window.fetch` por una función que
devuelve esos JSON (y `boot: false`), apuntar `style.css` y `app.js` a
`http://localhost:<puerto>/static/...` y capturar:

```sh
/Applications/Firefox.app/Contents/MacOS/firefox --headless --no-remote \
  --profile <dir-temporal>/ffprof --window-size=1600,1000 \
  --screenshot <dir-temporal>/shot.png file://<dir-temporal>/snap.html
```

El perfil tiene que estar en un directorio temporal propio (con `mktemp -d` no guardó
nada). Prueba también `--window-size=400,1400` (móvil, una columna) y el tema `c64`.

Detalle de CSS: `color-mix(...)` dentro de un `repeating-linear-gradient` no se pinta bien
en Firefox; para el tramo vacío de las barras se usa el color sólido con `opacity`.

## Docker

`Dockerfile` + `compose.yaml` + `.env.example`. En este Mac Docker va con **colima**, que
normalmente está apagado: `colima start` para probar y `colima stop` al terminar. El
contenedor corre con el uid 1000, monta `config.yaml` en solo lectura y toma los secretos
de `.env`; desde colima llega a Home Assistant por la IP de Tailscale.

## Home Assistant (cosas aprendidas)

- Historial de atributos (p. ej. `hvac_action`): `significant_changes_only=0` y sin
  `no_attributes`.
- Máximas y mínimas de siempre: el recorder solo guarda unos 10 días; se usan las
  estadísticas a largo plazo por WebSocket (`recorder/statistics_during_period`).
- La estación meteorológica a veces deja de informar durante horas (sale en rojo, "hace N h");
  no es un fallo de Marianne.

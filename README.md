# MARIANNE

Panel retro en el navegador. Reúne en una sola pantalla la información que te importa de
casa: sensores de **Home Assistant**, la **previsión del tiempo** de OpenWeather, las
**fases de la luna** y valores **sacados de webs**.

Ámbar naranja (por defecto), fósforo verde o azul Commodore 64, con líneas de barrido de
monitor CRT, reloj grande y arranque tipo BIOS. El título, por la Marianne Dashwood de Jane
Austen, va en la caligrafía Mrs Saint Delafield, dibujada en píxeles como en un ordenador de los 80. Al
reducir la ventana todo se hace más pequeño en proporción; en el móvil los paneles se ponen en
una columna.

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
  Con la tecla `V` se da por vista: sigue en rojo, pero deja de parpadear.
- **Franja de aviso** en verde para buenas noticias, como que mañana va a hacer buen día.
- **Paneles emergentes**: los que no necesitas ver siempre (las baterías, por ejemplo) se
  abren con una tecla, y su opción del menú parpadea si tienen alguna alerta.
- **Home Assistant**: traducción de estados, horas en tu zona horaria, tendencia ▲▼ y
  máxima/mínima del día desde el historial, y aviso de sensores que han dejado de informar.
- **El tiempo** de OpenWeather (API gratuita): una gráfica del día (temperatura, viento,
  lluvia y nubes por horas, con lo observado en las horas ya pasadas y la previsión en las que
  faltan, y la tecla `M` para ver mañana), temperatura actual, resumen del día, máxima, mínima, lluvia,
  viento, próximas horas y si mañana hará buen día.
- **El camino del sol**: su altura real a lo largo del día (de 00 a 24 h, calculada donde está
  Home Assistant), con los solsticios de verano e invierno como referencia y el sol en su sitio;
  las horas de alba, salida, mediodía, puesta y anochecer, la elevación y el azimut, y cuántas
  horas de luz y de oscuridad tiene el día.
- **Fases de la luna** calculadas localmente (algoritmo de Jean Meeus, sin internet).
- **Pomodoro**: cuenta atrás con descanso automático. Al terminar cada fase suenan tres
  campanadas y el aviso parpadea hasta pulsar una tecla. Basta con definir la fuente: mientras
  está en uso aparece centrada en la cabecera, o, con `pomodoro: true`, en lugar de un panel
  (las noticias, para trabajar sin distracciones).
- **Fechas señaladas**: cuántos días faltan para cumpleaños, viajes o fiestas, con aviso el
  mismo día (se añaden y cambian desde la propia página, con la tecla `F`), y barras de progreso del día, la semana, el mes, el año y la vida.
- **Scraping web**: cualquier valor de una página con un selector CSS.
- **El servidor**: CPU, carga, memoria, swap, disco, temperatura y tiempo encendido del
  equipo en el que corre Marianne.
- **Noticias**: los últimos titulares de tus feeds RSS o Atom; un clic los abre en un lector con
  el texto que trae el feed y, al final, el enlace a la noticia en la web.
- **Avisos meteorológicos** del Met Office (amarillo, ámbar, rojo) de tu región: los ámbar y
  rojos salen también en la franja de alarma.
- **Tus calendarios** (Google, iCloud, Outlook… con su enlace iCal privado): los eventos de hoy, y
  con la tecla `M` los de mañana.
- **Monitor de servicios**: comprueba que tus servicios web responden y cuánto tardan; si
  alguno se cae, sale en rojo.

## Probarlo ya

Hace falta [uv](https://docs.astral.sh/uv/).

```sh
uv run marianne --demo                  # datos simulados, en http://127.0.0.1:1111
uv run marianne --demo --theme phosphor
```

| Tecla | Acción |
|---|---|
| `R` | Refrescar todos los paneles (no sale en la barra de abajo) |
| `C` | Cambiar de color (ámbar → Commodore 64 → fósforo verde) |
| `V` | Alerta vista: deja de parpadear y sale de la franja de alarma (sigue en rojo); si se resuelve y vuelve, avisa de nuevo |
| `P` | Pomodoro: iniciar / pausar |
| `O` | Pomodoro: reiniciar (en la barra de abajo, solo mientras hay un pomodoro en marcha) |
| `B`… | Abrir / cerrar un panel emergente (la tecla la eliges tú con `key:`) |
| `T`… | Siguiente página de un panel con páginas (la tecla la eliges tú con `page_key:`; también con un clic en el título) |
| `→` `↓` / `←` `↑` | Mover el cursor hacia delante / hacia atrás por un solo camino: las horas de la gráfica del tiempo, los servicios (de izquierda a derecha y de arriba abajo) y los titulares de noticias; al final vuelve a empezar. Con un día del calendario elegido (tocándolo), recorren los días |
| `Enter` | Abrir el enlace del cursor: un titular se abre en el lector, y ahí acepta la opción elegida; lo demás, en una pestaña nueva |
| `M` | Mañana: la gráfica del tiempo y los eventos de los calendarios de mañana, y vuelta a hoy |
| `H` | Historial: los paneles con `history: true` muestran sus últimos 7 días, día a día; otra `H` (o `Q`) vuelve a lo normal |
| `F` | Fechas: añadir, cambiar o borrar las de la cuenta atrás (`↑` `↓` para elegir, `Enter` para cambiar o guardar, `Q` para volver) |
| `Z` `X` | Calendario: mes anterior y siguiente (también `RePág` y `AvPág`); `Q` lo devuelve a este mes |
| `F1` | Ayuda: la lista de todas las teclas, que también se pueden pulsar ahí |
| `Q` | Salir: cerrar el lector; si no, quitar el cursor; si no, cerrar el panel emergente (`Esc` hace lo mismo) |

La barra de abajo muestra el estado de las fuentes de datos (■ bien, ✖ falla). Todas las teclas
están en la ayuda (`F1`, o el botón AYUDA de la barra, el único en el móvil), donde también se
pueden pulsar con el ratón o el dedo; en la barra solo salen las que avisan de algo (`[V]VISTO`,
una ventana con una alerta) y las del momento (`[Q]SALIR` con el cursor). El color, la página de
cada panel y las alertas vistas se recuerdan en cada navegador.

En el móvil, un botón redondo en la esquina de abajo a la derecha despliega una cuadrícula de
botones redondos con los comandos que necesitan una tecla (color, pomodoro, historial, mañana,
fechas, las ventanas, visto, refrescar, ayuda). Los que tienen algo por ver parpadean en rojo, y
el botón cerrado lo avisa con un punto rojo. Los navegadores no
dejan sonar nada hasta la primera tecla o clic en la página.

## Con tu Home Assistant

1. Crea un token de larga duración en Home Assistant (tu perfil → Seguridad).
2. `export HASS_TOKEN=...` (por ejemplo en tu `~/.zshrc`).
3. `cp config.example.yaml config.yaml` y pon tu URL y tus entidades.
4. `uv run marianne` y abre http://127.0.0.1:1111.

El fichero de configuración se busca en `./config.yaml` y en `~/.config/marianne/config.yaml`,
o se indica con `marianne -c ruta.yaml`. `config.yaml` está en `.gitignore`: ahí pueden ir tus
claves sin miedo a subirlas.

Los `${VARIABLES}` de `config.yaml` salen del entorno o de un fichero `.env` (también en
`.gitignore`) junto a `config.yaml` o en el directorio actual, con líneas `OPENWEATHER_KEY=...`.
Si una variable está en los dos sitios, gana la de la shell.

| Opción | Para qué |
|---|---|
| `--host 0.0.0.0` | Abrirlo desde el móvil u otro ordenador (por defecto, solo desde este) |
| `--port 1111` | Puerto |
| `--theme c64` | Tema, en lugar del de `config.yaml` |
| `--demo` | Datos simulados en lugar de Home Assistant |

La página no pide contraseña: con `--host 0.0.0.0` la verá cualquiera que llegue a ese
puerto. Mejor solo en tu red o por una VPN como Tailscale.

Para saber los nombres de tus entidades: Herramientas para desarrolladores → Estados.

## Con Docker

```sh
cp config.example.yaml config.yaml   # y adáptalo
cp .env.example .env                 # y pon HASS_TOKEN (y OPENWEATHER_KEY si lo usas)
docker compose up -d --build         # http://<este equipo>:1111
```

- Lo que se cambia desde la página (las fechas) se guarda en `data/`, que el contenedor necesita
  poder escribir: créala antes de arrancar con `mkdir data` (como el usuario con uid 1000, o
  `sudo chown 1000 data`). Está en `.gitignore`.
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
- La música del iPod (`type: music`): pon la ruta de la carpeta en `.env` como
  `MUSIC_FOLDER=/ruta/a/la/musica`; `compose.yaml` la monta en `/music` en solo lectura y la
  fuente usa `folder: /music`. El uid 1000 tiene que poder leerla.
- Para actualizar tras un `git pull`: `docker compose up -d --build`.
- Para verlo solo desde el propio equipo, cambia el puerto en `compose.yaml` a `"127.0.0.1:1111:1111"`.

## Configuración

`config.example.yaml` tiene ejemplos comentados de todo. Resumen:

```yaml
theme: amber            # amber | phosphor | c64
columns: 3              # columnas de la rejilla
row_heights: [1.25, 1, 1]  # alto relativo de cada fila (opcional; por defecto, iguales)
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
| `homeassistant` | REST API de Home Assistant (`url`, `token`, `verify_ssl`) | `entity:`; o `energy: true`, el bloque de energía (ver abajo) |
| `openweather` | Previsión gratuita de openweathermap.org (`api_key`, `city`, `lang`) | `field:` `chart` (gráfica del día, ver abajo), `now` (temperatura actual, con un dibujo del tiempo que hace si va en grande), `summary`, `max`, `min`, `rain_probability`, `rain`, `next_rain` (cuándo vuelve a llover), `wind`, `hours`, `good_day` |
| `moon` | Fases de la luna calculadas en local | `field:` `phase`, `next_phase` |
| `web` | Descarga una página y extrae un valor | `url:` y `selector:` (CSS), opcionales `attr`, `regex`, `numeric` |
| `monitor` | Comprueba que unas webs responden (`timeout`, `verify_ssl`; con `wud: <url>` pregunta además a What's Up Docker qué contenedores tienen actualización, y el icono de su servicio sale en rojo): ● y el tiempo de respuesta, o ○ `CAÍDO` / `ERROR 502` en rojo | `url:`, opcionales `link` (adónde lleva un clic, si no es la misma `url`), `container` o `containers` (sus contenedores en What's Up Docker), `alert: false`, `alarm_after`, `alarm_text` |
| `ical` | Eventos de calendarios por su enlace iCal privado (`calendars:` una lista de `name` y `url`, mejor como `${ICAL_PERSONAL}` en `.env`: el enlace da acceso a todo el calendario). Un elemento lista los eventos de hoy (con hora de inicio y fin, o "todo el día"; ● el que está en curso) y, con la tecla de mañana (`M`), los de mañana | sin campos; opcional `name`, el título de la lista |
| `metoffice` | Avisos meteorológicos del Met Office (`region`: el código de la región, `st` para Strathclyde; opcional `area`, solo los que la nombran, p. ej. `Glasgow`), del peor al más próximo, con hasta cuándo valen; un clic abre el texto completo | sin campos; opcionales `limit` (3), `alarm_from` (`amber`: desde qué nivel van a la franja de alarma) y `none_text` |
| `rss` | Titulares de feeds RSS o Atom, del más reciente al más antiguo, con su antigüedad (`5 min`, `3 h`, `2 d`); un clic abre la noticia en un lector con el texto que trae el feed y, al final, el enlace a la web | `url:` (un feed) o `feeds:` (varios juntos), opcional `limit` (7). Las noticias repetidas (mismo enlace o titular casi igual, como cuando se republica para corregir una errata) salen una vez, la más reciente; `similar` (0.85) es cuánto se tienen que parecer, de 0 a 1 |
| `system` | El equipo en el que corre Marianne | `field:` `cpu`, `load`, `memory`, `swap`, `disk` (con `path`, `/` por defecto), `temperature` (no en macOS), `uptime`, `hostname` (con `title: true`, como título del panel), `platform`, `summary` (tiempo encendido, carga y temperatura en una línea; opcionales `load_above` y `temperature_above`). Opción de la fuente: `host_root` (ver Docker) |
| `music` | Una carpeta de música para el iPod (ver abajo): `folder`, `key`, `cache`, `ratings`, `rescan_hours` | En un panel de acciones, un botón que abre el iPod (`name`, `icon`) |
| `pomodoro` | Temporizador (`work`, `short_break`, `long_break` en minutos, `long_every`, `start_key`, `reset_key`) | `field:` `timer`, `status`, `count` |
| `dates` | Días hasta fechas señaladas (`sort`) y barras de progreso. Con `file: data/fechas.yaml`, las fechas se añaden, cambian y borran desde la página con la tecla `F` (`edit_key`) y se guardan en ese fichero. Allí, una fecha sin año (`25/12`) es de todos los años; con año, si ya pasó (un cumpleaños) se repite cada año diciendo cuántos cumple, y si está por venir (un viaje) es de ese día | `date:` `2026-12-25` (fija) o `12-25` (cada año), opcionales `yearly`, `soon`; o `progress:` `day`, `week`, `month`, `year`, `life` (con `birth`, `end` y opcional `days_left`); o `calendar: true`, el mes en una columna a la izquierda, separada por una línea (encima en el móvil), con hoy en vídeo inverso y las fechas de la cuenta atrás en el color de acento; `‹` `›` o el cursor (ver Teclas) pasan a otros meses |

### La gráfica del tiempo

`field: chart` en un panel de OpenWeather dibuja el día de 00 a 24 h:

- **Temperatura**: línea gruesa, con la máxima y la mínima escritas; en rojo por debajo de 0 °C
  (y una raya roja discontinua en el 0). Rayas horizontales tenues en las temperaturas redondas.
- **Viento**: línea fina, con su escala en km/h a la derecha; en rojo los tramos desde `strong_wind`
  km/h (50 por defecto, "viento fuerte" en la escala de Beaufort). Encima, las rachas.
- **Lluvia**: una barra por tramo, tan alta como los mm por hora y tanto más sólida cuanto más
  probable (la observada, del todo); en rojo desde `heavy_rain` mm/h (4 por defecto, la "lluvia
  intensa" del Met Office).
- **Nubes**: un doble chevron (︽) por hora, a la altura de su porcentaje (0 % abajo, 100 % arriba).

A la izquierda de la raya de "ahora", lo observado; a la derecha, la previsión. El plan gratuito
de OpenWeather no da el pasado, así que Marianne guarda las condiciones de cada consulta (cada 10
minutos) en el fichero `history` de la fuente.

La previsión gratuita de OpenWeather va en tramos de 3 horas. Con `hourly: open-meteo` en la
fuente, la gráfica usa la de [Open-Meteo](https://open-meteo.com), hora a hora (gratis, sin clave,
de los modelos de los servicios meteorológicos nacionales; datos CC BY 4.0), en las coordenadas
de la ciudad que da OpenWeather; también rellena, como "estimado", las horas pasadas en las que
Marianne no observó nada. Si Open-Meteo no responde, vuelve a los tramos de 3 horas. El resto de
campos sigue con OpenWeather. Las líneas y los chevrones llevan un fino borde negro para que se distingan sobre las barras. La
tecla `day_key` (`M`) o el botón de la barra pasan a mañana y vuelven. La máxima y la mínima del
día van escritas sobre la línea de temperatura, y debajo de la gráfica, las condiciones de ahora
(temperatura, viento, lluvia y nubes).

Para ver las condiciones de una hora: pasa el ratón por la gráfica o tócala en el móvil, o usa
el cursor de las flechas, que empieza en ella y va de hora en hora; `Enter` cambia de día (sin
perder la hora) y `Q` sale. Debajo se lee entonces la hora, la
temperatura, el viento, la lluvia (y su probabilidad, si es previsión), las nubes y si es lo
observado, lo estimado o lo previsto.

### El iPod

Con una fuente `type: music` (`folder`, la carpeta; `key`, la tecla que lo abre; opcionales
`cache: data/musica.json` y `ratings: data/valoraciones.json`), un iPod classic aparece sobre la página con esa tecla, con el botón
redondo del móvil o con un botón en un panel de acciones (`- source: musica`, `name: iPod`,
`icon: mdi:ipod`). Sus menús son Artistas, Álbumes, Canciones, Aleatorio y Reproduciendo, con los
datos de las etiquetas de cada archivo (o, si no las tiene, los nombres de las carpetas:
`Artista/Álbum/01 Canción.mp3`). La carátula (de dentro del archivo o de un `cover.jpg` de su
carpeta) no sale en el iPod, pero sí en la pantalla de bloqueo del móvil y en los controles de
música del sistema.

- La rueda se gira con el dedo o el ratón para moverse por los menús (y, en Reproduciendo, para
  el volumen); el botón del centro elige; MENU vuelve atrás; ⏮ ⏭ cambian de canción y ⏯ pausa.
  Como el de verdad, hace clic en cada paso de la rueda y en cada botón (no al llegar al final de
  una lista).
  ⏮ (o `Z`) vuelve al principio de la canción; a la anterior, si está en sus 5 primeros segundos
  o si se pulsa dos veces seguidas.
- Con el teclado: `↑` `↓` moverse (volumen), `→` o `↵` elegir, `←` MENU, `Espacio` pausa,
  `Z` `X` canción anterior y siguiente; `-` lo minimiza (la música sigue) y `Q` lo cierra del
  todo (la música se para); `V` pone en su pantalla un visualizador psicodélico, como el de
  Winamp. Los tres están también como botones encima del iPod.
- Con `ratings`, cada canción puede tener de 0 a 5 estrellas: en Reproduciendo, el botón del
  centro (o `→`, `↵`) hace que la rueda las cambie en lugar del volumen durante unos segundos, y
  las teclas `0` a `5` las ponen directamente. Se guardan en ese fichero (la música está en solo
  lectura), así que valen en todos los dispositivos. El menú Favoritas tiene las de 4 y 5
  estrellas, en orden o en aleatorio.
- Como un iPod, recuerda en cada navegador lo que sonaba: la lista, la canción, el segundo y el
  volumen. Al volver a abrirlo (aunque se haya recargado la página o se cerrara con `Q`) está en
  esa canción, en pausa, donde se dejó.
- El visualizador sigue la música en el ordenador. En el móvil solo lo aparenta, porque en el
  iPhone una canción que pasa por el analizador de audio se para al bloquear la pantalla.
- Minimizado (con `-`, su tecla o un toque fuera de él), la barra de abajo dice qué suena y un
  clic lo vuelve a abrir. Mientras tanto sus teclas van antes que las de la página: `-` lo
  abre, `Espacio` pausa, `Z` `X` cambian de canción y `Q` lo cierra y para la música (así que
  los meses del calendario solo van con un clic mientras suena). Con la música en pausa vuelven a
  mandar las de la página, y al iPod le quedan `Espacio` para seguir y `-` para abrirlo. En
  el móvil se controla también desde la pantalla de bloqueo.
- La música suena en el navegador. Valen los formatos que entiende: MP3, AAC y FLAC en todos;
  ALAC solo en Safari; OGG y Opus no siempre en el iPhone. El servidor solo manda los archivos
  de esa carpeta, por un número de su índice, nunca por su ruta. Vuelve a mirar la carpeta cada
  6 horas (`rescan_hours`).

### El bloque de energía

Un elemento `energy: true` de Home Assistant dibuja, arriba del panel, el consumo de electricidad
de ahora en cifras grandes (con una llama mientras la calefacción calienta), una gráfica del día
con la potencia (medias de 5 minutos de las estadísticas de Home Assistant) y los ratos en que ha
calentado, y los totales de hoy: kWh y tiempo de calefacción. Debajo, el termostato: una escala
(`scale_min`, `scale_max`, 14 y 24 °C por defecto) con la temperatura de la habitación como barra
y el objetivo como una marca, y ▲ mientras calienta (▼ si no), `ECO` en modo eco; si está
apagado, lo dice sobre la gráfica.

```yaml
- energy: true
  name: Luz
  power: sensor.consumo_ahora            # W
  energy_today: sensor.consumo_hoy       # kWh de hoy
  climate: climate.termostato            # hvac_action, preset_mode, temperature
  room: sensor.temperatura_vestibulo
  room_name: Vestíbulo
  valid_max: 20000                       # descarta los picos falsos del medidor
```

Para que el historial de 7 días siga teniendo el consumo y la calefacción de cada día, sus
elementos pueden quedarse en el panel ocultos: `hidden: true` y, para un contador, `history: true`.

### El historial

Con la tecla `H` (`history_key` en `config.yaml`), los paneles con `history: true` muestran los
últimos 7 días en una tabla: un día por fila y un valor por columna, con la máxima y la mínima
de ese día (o, para un contador o la lluvia, el total del día). Otra `H`, o `Q`, vuelve a lo
normal. Si un panel tiene más de tres valores, van en páginas (los de una misma fila, juntos: la
temperatura y la humedad de una habitación) que pasan solas cada 10 segundos o con un clic en el
título.

- **Home Assistant**: salen de sus estadísticas a largo plazo (los sensores con `state_class`),
  hora a hora, sin las horas fuera de `valid_max`/`valid_min`; los días posteriores al último
  informe de un sensor salen como `--`. Un elemento `on_today` con `week: true` da su tiempo
  encendido de cada día (la calefacción).
- **El tiempo**: de lo que Marianne ha ido observando (el fichero `history` de la fuente):
  temperatura, viento y lluvia de cada día.

### Opciones de panel

| Opción | Para qué |
|---|---|
| `title`, `source` | Título y fuente por defecto de sus elementos |
| `refresh` | Segundos entre actualizaciones (10 por defecto) |
| `span`, `rows` | Columnas y filas de la rejilla que ocupa |
| `big: true` | El primer valor, en dígitos grandes |
| `history: true` | Sale con el historial (tecla `H`, ver abajo) |
| `pomodoro: true` | Mientras hay un pomodoro en marcha, este panel lo muestra en grande (cuenta atrás, fase y progreso) en lugar de su contenido, y la cabecera deja de mostrarlo: p. ej. en Noticias, para no distraerse |
| `actions: true` | Una cuadrícula de 3 × 3 botones con un icono y un nombre que lanzan scripts de Home Assistant (cada elemento con `script: script.nombre`, `name` e `icon`); se pulsan con un clic o con el cursor y Enter. Pensado con `key:` para abrirlo como ventana. Solo se pueden lanzar los scripts que estén en la configuración |
| `icons: true` | Los elementos, como una cuadrícula de iconos con su nombre y su valor debajo (cada uno con `icon: mdi:dolphin` o `si:jellyfin`, como en Glance); para muchos elementos cortos, como el monitor de servicios |
| `key: b` | Fuera de la rejilla: se abre como ventana con esa tecla (o con un clic en la barra de abajo). Si tiene `pages` y no `page_key`, la misma tecla pasa a la página siguiente y, tras la última, la cierra |
| `icon: mdi:battery` | El icono de su botón redondo en el móvil (con `key`) |
| `pages`, `page_key: t` | Varias páginas de elementos (`- name: …` con sus `items`) que se van alternando con esa tecla, p. ej. un teléfono por página; el nombre de la página es el título |

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
| `icon` | En un panel con `icons: true`: `mdi:nombre` ([Material Design Icons](https://pictogrammers.com/library/mdi/)) o `si:nombre` ([Simple Icons](https://simpleicons.org)). El servidor los descarga una vez de jsDelivr y la página los pinta con líneas de barrido en el color del tema |
| `history: false` | Deja este valor fuera del historial (`history: true`: lo deja dentro aunque esté oculto) |
| `week: false` | Lo deja fuera solo de la tabla de 7 días (p. ej. una potencia, para quedarse con su consumo) |
| `week: true` | En un elemento `on_today`: su tiempo encendido de cada día en la tabla de 7 días (la calefacción) |
| `week_name` | Su nombre en la tabla de 7 días ("Calefacción" en lugar de "Calefacción hoy") |
| `week_order` | Su lugar en la tabla de 7 días: 0 por defecto; cuanto mayor, más a la derecha |
| `valid_max`, `valid_min` | En el historial, descarta los valores por encima o por debajo (los picos falsos de un sensor) |
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
  icons.py             iconos mdi: y si: (descargados una vez y servidos en /api/icon)
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
    rss.py             titulares de feeds RSS y Atom
    metoffice.py       avisos meteorológicos del Met Office
    ical.py            eventos de calendarios iCal
    system.py          CPU, memoria y disco de este equipo
    demo.py            datos simulados
```

API del servidor: `GET /api/layout` (paneles y opciones, sin entidades ni claves),
`GET /api/state` (lecturas de cada panel y página, estado de las fuentes y del pomodoro),
`GET /api/icon/<mdi|si>/<nombre>` (el SVG de un icono), `GET /api/history` (los últimos 7 días de los paneles con historial), `POST /api/reload` y
`POST /api/pomodoro/<fuente>/toggle|reset`.

Para añadir una fuente nueva: una subclase de `Source` con `async fetch(items) -> list[Reading]`,
registrada en `sources/__init__.py`.

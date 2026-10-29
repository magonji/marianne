// Marianne: draws the readings that server.py collects, as a retro terminal screen.
"use strict";

const THEMES = ["amber", "c64", "phosphor"];
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const POLL_MS = 1000;
const NOTICE_FLASH_MS = 60_000;
const BELL_EVERY_MS = 5_000;

let layout = null;
let state = null;
let lastRings = null;
let noticeFlashUntil = 0;
let lastBell = 0;
let popup = null; // index of the open pop-up panel
let cursor = null; // href of the link under the keyboard cursor (arrows move it, Enter opens it)
let helpOpen = false; // the list of commands (F1)
let reader = null; // the story open in the reader: its reading, the title of its panel and the chosen option
const READER_CHOICES = ["read", "close"];
// The date editor (its key, F by default): the dates of one source, and the form when one is open.
let dates = null;
// Which day the weather chart shows: 0 today, 1 tomorrow (its key, D by default, switches).
let chartDay = 0;
// The hour picked on the chart (0-23) to read its conditions: by the cursor, the mouse or a tap.
let chartHour = null;
// The chart's place in the link cursor: it takes the cursor like a link, and then ← → pick the hour.
const CHART_CURSOR = "chart:";
// The calendar takes the cursor too: Enter goes into its days, and the arrows move through them.
const CALENDAR_CURSOR = "calendar:";
let calendarView = null; // { year, month } shown; null, this month
let calendarDay = null; // "YYYY-MM-DD" picked while going through the days
// The history command (its key, H): the last 7 days, day by day, in the panels that have it.
let history = null; // { data, at } while it's on
const HISTORY_REFRESH_MS = 5 * 60_000;
// The "7 days" table: at most this many values a page, which go by on their own.
// Six on a screen (three rooms with their temperature and humidity), three on a phone.
const weekColumns = () => (matchMedia("(max-width: 760px) and (pointer: coarse)").matches ? 3 : 6);
const WEEK_PAGE_MS = 10_000;
const weekPages = {}; // page shown, by panel
let weekTurned = 0;
let audio = null;

// Per viewer: the page shown in each panel with pages, the theme, and the alerts already seen.
const pages = load("marianne.pages", {});
let seen = new Set(load("marianne.seen", []));

function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: it just isn't remembered */
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name === "style") node.style.cssText = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === "") continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const upper = (text) => (layout && layout.uppercase ? String(text).toUpperCase() : String(text));
const parts = (reading) => [reading, ...(reading.extra || [])];
const alertKey = (panel, part) => `${panel.title}|${part.label}`;

// ---------------------------------------------------------------- state

async function start() {
  layout = await (await fetch("/api/layout")).json();
  setTheme(load("marianne.theme", null) || layout.theme);
  document.getElementById("panels").style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
  drawBanner();
  if (layout.boot) await boot(layout.boot_lines);
  tickClock();
  setInterval(tickClock, 1000);
  await poll();
  setInterval(poll, POLL_MS);
}

async function poll() {
  if (history && history.data && Date.now() - history.at > HISTORY_REFRESH_MS) loadHistory();
  if (history && Date.now() - weekTurned > WEEK_PAGE_MS) {
    weekTurned = Date.now();
    for (const index of Object.keys(weekPages)) weekPages[index] += 1;
  }
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(response.statusText);
    update(await response.json());
  } catch {
    offline();
  }
}

async function post(path) {
  try {
    const response = await fetch(path, { method: "POST" });
    if (response.ok) update(await response.json());
  } catch {
    offline();
  }
}

function update(next) {
  state = next;
  state.offline = false;
  if (lastRings !== null && state.rings > lastRings) chime();
  lastRings = state.rings;
  forgetCleared();
  render();
}

function offline() {
  if (state) state.offline = true;
  renderStatus();
}

// Panels in the grid and pop-ups alike, each with the readings of the page it shows.
function panelViews() {
  return layout.panels.map((panel, index) => {
    const page = panel.pages.length > 1 ? (pages[index] || 0) % panel.pages.length : 0;
    const data = state ? state.panels[index][page] : { readings: [], updated: null, error: null };
    // A reading can give the panel its title (the server's: the machine's name).
    const named = data.readings.find((reading) => reading.title);
    return { panel, index, page, data, title: named ? named.title : panel.pages[page] };
  });
}

function allAlerts() {
  return panelViews().flatMap(({ panel, data }) =>
    data.readings.flatMap((reading) => parts(reading).filter((part) => part.alert).map((part) => ({ panel, part }))),
  );
}

function unseenAlerts() {
  return allAlerts().filter(({ panel, part }) => !seen.has(alertKey(panel, part)));
}

// An alert that has cleared is forgotten, so it warns again if it comes back.
function forgetCleared() {
  const active = new Set(allAlerts().map(({ panel, part }) => alertKey(panel, part)));
  const kept = new Set([...seen].filter((key) => active.has(key)));
  if (kept.size !== seen.size) {
    seen = kept;
    save("marianne.seen", [...seen]);
  }
}

// ---------------------------------------------------------------- drawing

function render() {
  renderPomodoro();
  renderStrips();
  renderPanels();
  renderPopup();
  renderStatus();
  renderFab();
  renderCursor();
}

// ---------------------------------------------------------------- phone buttons

// On a phone (only there: the CSS hides it elsewhere), a round button in the bottom right corner
// that opens, with an animation, a grid of round buttons: the commands that need a key, which a
// tap on the page can't do. Each one does what its key would, and the grid closes.
let fabOpen = false;

function renderFab() {
  if (!layout) return;
  const box = document.getElementById("fab");
  // "palette" or "mdi:palette", "si:jellyfin".
  const icon = (name) => {
    const [kind, glyph] = name.includes(":") ? name.split(":") : ["mdi", name];
    return el("span", { class: "glyph", style: `--icon: url("/api/icon/${kind}/${glyph}")` });
  };
  // In red, what has something to see: the alerts, a window with an alert not seen yet.
  const fresh = new Set(panelViews().filter(({ panel, data }) => panel.key && data.readings.some((reading) =>
    parts(reading).some((part) => part.alert && !seen.has(alertKey(panel, part))))).map(({ panel }) => panel.key));
  if (state && unseenAlerts().length) fresh.add("v");
  const commands = [...helpCommands().filter((command) => !command.touch), { key: "f1", icon: "help", short: "Ayuda" }];
  const buttons = commands.map(({ key, icon: name, short }, index) =>
    el("button", { class: `fab-item${fresh.has(key) ? " alerting" : ""}`, "data-key": key, style: `--i: ${commands.length - 1 - index}`, title: short },
      el("span", { class: "fab-circle" }, icon(name)), el("span", { class: "fab-name" }, upper(short))));
  const main = el("button", { class: `fab-main${fresh.size && !fabOpen ? " alerting" : ""}`, "data-fab": "1", "aria-label": fabOpen ? "Cerrar" : "Comandos" },
    icon(fabOpen ? "close" : "dots-grid"));
  // Rebuilt only when it changes, like the status bar: the state comes every second.
  const html = `${fabOpen}|${buttons.map((button) => button.outerHTML).join("")}`;
  box.classList.toggle("open", fabOpen);
  if (box.dataset.html === html) return;
  box.dataset.html = html;
  box.replaceChildren(el("div", { class: "fab-grid" }, ...buttons), main);
}

function toggleFab(open = !fabOpen) {
  fabOpen = open;
  render();
}

function tickClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const colon = now.getSeconds() % 2 === 0 ? ":" : " ";
  setSegments(document.getElementById("clock-digits"), `${pad(now.getHours())}${colon}${pad(now.getMinutes())}`);
  // "Lunes, 26 de octubre de 2026".
  const weekday = DAYS[now.getDay()];
  document.getElementById("clock-date").textContent =
    `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${now.getDate()} de ${MONTH_NAMES[now.getMonth()]} de ${now.getFullYear()}`;
}

function renderPomodoro() {
  const box = document.getElementById("pomodoro");
  const pomodoro = state.pomodoro;
  // With a panel for it (`pomodoro: true`), it goes there instead of in the header.
  box.hidden = !(pomodoro && pomodoro.active) || layout.panels.some((panel) => panel.pomodoro);
  if (box.hidden) return;
  const seconds = Math.ceil(pomodoro.left - 0.001);
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  box.classList.toggle("paused", !pomodoro.running);
  document.getElementById("pomodoro-label").textContent = [
    "POMODORO",
    upper(pomodoro.label),
    pomodoro.running ? " " : upper(pomodoro.status),
  ].join("\n");
  setSegments(document.getElementById("pomodoro-digits"), time);
}

function renderStrips() {
  const views = panelViews();
  const alarms = [...new Set(unseenAlerts().map(({ part }) => part.alarm).filter(Boolean))];
  const alarm = document.getElementById("alarm");
  alarm.hidden = alarms.length === 0;
  alarm.textContent = alarms.map((text) => `!! ${text.toUpperCase()} !!`).join("\n");
  if (alarms.length && layout.bell && Date.now() - lastBell > BELL_EVERY_MS) {
    lastBell = Date.now();
    beep(880, 0.25);
  }

  const notices = views.flatMap(({ data }) => data.readings.flatMap(parts).map((part) => part.notice));
  if (state.pomodoro && state.pomodoro.notice) notices.push(state.pomodoro.notice);
  if (toast && Date.now() < toast.until) notices.push(toast.text);
  const unique = [...new Set(notices.filter(Boolean))];
  const notice = document.getElementById("notice");
  notice.hidden = unique.length === 0;
  notice.textContent = unique.map((text) => text.toUpperCase()).join("\n");
  notice.classList.toggle("flash", unique.length > 0 && Date.now() < noticeFlashUntil);
}

function renderPanels() {
  const grid = document.getElementById("panels");
  const views = panelViews().filter(({ panel }) => !panel.key);
  // Every row the same height, like the terminal grid, unless row_heights says otherwise.
  const cells = views.reduce((sum, { panel }) => sum + panel.span * panel.rows, 0);
  const rows = Math.max(1, Math.ceil(cells / layout.columns));
  const heights = layout.row_heights || [];
  grid.style.gridTemplateRows = Array.from({ length: rows }, (_, row) => `minmax(0, ${heights[row] || 1}fr)`).join(" ");
  grid.replaceChildren(...views.map(drawPanel));
}

function renderPopup() {
  const box = document.getElementById("popup");
  box.hidden = popup === null && !reader && !dates && !helpOpen;
  if (helpOpen) {
    // Only rebuilt when it changes, so that a tap on it isn't lost (as in the status bar).
    const help = drawHelp();
    if (box.dataset.help !== help.outerHTML) box.replaceChildren(help);
    box.dataset.help = help.outerHTML;
    return;
  }
  delete box.dataset.help;
  if (dates) {
    // Drawn again only when it changes: the poll every second must not wipe what is being typed.
    if (box.dataset.dates !== String(dates.version)) {
      box.replaceChildren(drawDates());
      box.dataset.dates = String(dates.version);
      const focus = box.querySelector(dates.focus) || box.querySelector("[data-focus]");
      if (focus) focus.focus();
    }
    return;
  }
  delete box.dataset.dates;
  if (reader) {
    // Drawn once: rebuilding it every second would throw away how far it has been scrolled.
    if (box.dataset.reader !== reader.reading.link) box.replaceChildren(drawReader());
    box.dataset.reader = reader.reading.link;
    renderChoice();
    return;
  }
  delete box.dataset.reader;
  if (popup === null) return;
  box.replaceChildren(drawPanel(panelViews()[popup]));
}

// A story from a feed, in a window: its headline, date and text, and at the end the link to the web.
function drawReader() {
  const { reading, title } = reader;
  const detail = reading.detail || {};
  const when = [detail.date, reading.value && `hace ${reading.value}`].filter(Boolean).join(" · ");
  const paragraphs = (detail.text || "").split("\n\n").filter(Boolean);
  const address = reading.link.replace(/^https?:\/\//, "");
  return el("section", { class: "panel reader" },
    el("h2", {}, upper(detail.feed || title)),
    el("div", { class: "body" },
      el("div", { class: "reader-title" }, upper(reading.label)),
      when ? el("div", { class: "dim" }, upper(when)) : null,
      el("div", { class: "rule" }),
      paragraphs.length
        ? paragraphs.map((text) => el("p", {}, upper(text)))
        : el("p", { class: "dim" }, upper("Esta noticia no trae texto en el feed.")),
      el("div", { class: "reader-address dim" }, address)),
    // Outside the scrolling body, so they are always in sight. ← → choose, Enter accepts.
    el("div", { class: "reader-choices" },
      el("a", { "data-choice": "read", href: reading.link, target: "_blank", rel: "noopener noreferrer" }, upper("Leer en la web")),
      el("button", { "data-choice": "close", onclick: closeReader }, upper("Salir"))));
}

// The chosen option in reverse video, like the link cursor.
function renderChoice() {
  for (const node of document.querySelectorAll("#popup [data-choice]")) {
    node.classList.toggle("cursor", node.dataset.choice === reader.choice);
  }
}

function openReader(panel, reading) {
  reader = { reading, title: panel.title, choice: "read" };
  cursor = reading.link;
  render();
}

function closeReader() {
  reader = null;
  render();
}

function drawPanel(view) {
  if (history && view.panel.history) return drawWeekPanel(view);
  if (view.panel.pomodoro && state && state.pomodoro && state.pomodoro.active) return drawPomodoroPanel(view);
  const { panel, data, title, index } = view;
  const alerting = data.readings.some((reading) => parts(reading).some((part) => part.alert));
  const stale = Boolean(data.error);
  const node = el("section", {
    class: `panel${alerting && !stale ? " alert" : ""}${stale ? " stale" : ""}`,
    style: `grid-column: span ${panel.span}; grid-row: span ${panel.rows}`,
  });
  // With several pages (a phone each, a newspaper each), the title turns the page, also by touch.
  // A pop-up (the phones) also says which page it is: its pages are a hidden list otherwise.
  const several = panel.pages.length > 1;
  const pageKey = panel.page_key || panel.key;
  const count = panel.key ? ` ‹${((pages[index] || 0) % panel.pages.length) + 1}/${panel.pages.length}›` : "";
  const heading = several
    ? el("button", { title: `Siguiente página${pageKey ? ` [${pageKey.toUpperCase()}]` : ""}`, onclick: () => nextPage(index) },
      upper(title), count ? el("span", { class: "page-count" }, count) : "")
    : upper(title);
  // A panel showing tomorrow (its chart, with the "mañana" key) says so in its title.
  const tomorrow = chartDay && data.readings.some((reading) => reading.chart);
  node.append(el("h2", {}, heading, tomorrow ? upper(" · mañana") : ""));
  const body = el("div", { class: "body" });

  // A calendar goes in a column of its own, to the left of the rows.
  const calendar = data.readings.find((reading) => reading.calendar);
  const shown = data.readings.filter((reading) => !reading.hidden && !reading.calendar);
  if (!shown.length && !calendar) {
    body.append(el("div", { class: "waiting" }, "ESPERANDO DATOS"));
  } else {
    let rows = shown;
    if (panel.actions) {
      body.append(drawActions(view, rows));
      rows = [];
    }
    if (panel.icons) {
      body.append(drawIcons(panel, rows));
      rows = [];
    }
    if (panel.big) {
      body.append(drawBig(panel, rows[0]), el("div", { class: "rule" }));
      rows = rows.slice(1);
    }
    const sun = Object.fromEntries(rows.filter((reading) => reading.sun).map((reading) => [reading.sun, reading]));
    const firstSun = rows.find((reading) => reading.sun);
    const wide = rows.filter((reading) => reading.wide_bar && reading.fraction !== null);
    const labelWidth = Math.max(0, ...wide.map((reading) => labelText(reading).length));
    // Two columns after the bars: the figure with its unit, right-aligned, and what comes after it.
    const valueWidth = Math.max(0, ...wide.map((reading) => reading.value.length + (reading.unit ? reading.unit.length + 1 : 0)));
    const noteWidth = Math.max(0, ...wide.map((reading) => (reading.note ? reading.note.length : 0)));
    for (const reading of rows) {
      if (reading.sun) {
        if (reading === firstSun) {
          const path = rows.find((row) => row.sun_path);
          body.append(...(path ? drawSunPath(sun, path.sun_path) : [drawSun(sun)]));
        }
        continue;
      }
      if (reading.agenda) {
        body.append(drawAgenda(reading));
        continue;
      }
      if (reading.energy) {
        // The widget, the line under it, and the thermostat as the first row.
        const [widget, thermostat] = drawEnergy(reading);
        body.append(widget, el("div", { class: "rule" }), thermostat);
        continue;
      }
      if (reading.tokens) {
        // A summary line: its figures bright, their units dim (red as a whole when it's alerting).
        // In one span: the row is a flex box, which would drop the spaces between the pieces.
        body.append(el("div", { class: `row summary${reading.alert ? " alert-text" : ""}` }, el("span", { class: "label" },
          reading.tokens.flatMap(([kind, text], at) => [at ? " " : "", el("span", { class: `token-${kind}` }, upper(text))]))));
        continue;
      }
      if (reading.chart) {
        // The chart takes the height the rows under it leave.
        body.classList.add("with-chart");
        body.append(drawChart(reading.chart), el("div", { class: "rule" }));
        continue;
      }
      body.append(drawRow(panel, reading, { labelWidth, valueWidth, noteWidth }));
    }
  }
  if (calendar) {
    const rows = el("div", { class: "calendar-rows" }, ...body.childNodes, drawCalendarInfo(calendar.calendar));
    body.classList.add("with-calendar");
    body.append(drawCalendar(calendar.calendar), rows);
  }
  node.append(body);
  const subtitle = stale ? `✖ ${data.error}` : data.updated;
  if (subtitle) node.append(el("div", { class: "subtitle" }, subtitle));
  return node;
}

function labelText(reading) {
  const alerting = parts(reading).some((part) => part.alert);
  let label = upper(reading.label);
  if (reading.switch !== null) label = (reading.switch ? "● " : "○ ") + label;
  else if (alerting) label = "! " + label;
  return label;
}

function styleClass(reading) {
  if (reading.alert) return "alert-text";
  // A sensor that's down: dim amber, not red (it isn't a fault of marianne's).
  if (reading.offline) return "offline";
  if (reading.error) return "error";
  if (reading.switch === true) return "on";
  if (reading.switch === false) return "off";
  return "value";
}

function drawRow(panel, reading, widths) {
  const alerting = parts(reading).some((part) => part.alert);
  const wide = reading.wide_bar && reading.fraction !== null;
  const label = el("span", {
    class: `label${alerting ? " alert-text" : reading.offline && !parts(reading).some((part) => !part.offline) ? " offline" : reading.switch !== null ? " " + styleClass(reading) : ""}`,
    style: wide ? `width: ${widths.labelWidth}ch; flex: none` : null,
  }, reading.link ? drawLink(panel, reading) : labelText(reading));
  const values = el("span", { class: "values" }, drawValue(panel, reading, wide ? widths.valueWidth : 0, wide ? widths.noteWidth : 0));
  for (const extra of reading.extra || []) values.append("  ", drawValue(panel, extra, 0));
  // A row that's only its label (a summary line, "Sin avisos"): no dots leading to nothing.
  const bare = !reading.value && !reading.unit && !reading.note && !(reading.extra || []).length;
  return el("div", { class: `row${wide ? " wide" : ""}${reading.link ? " linked" : ""}` }, label,
    wide || bare ? null : el("span", { class: "leader" }), bare ? null : values);
}

// A headline with its story (detail) opens the reader; ctrl/cmd-click still goes straight to the web.
function drawLink(panel, reading) {
  const open = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    openReader(panel, reading);
  };
  return el("a", {
    href: reading.link, target: "_blank", rel: "noopener noreferrer",
    "data-reader": reading.detail ? "1" : null, onclick: reading.detail ? open : null,
  }, labelText(reading));
}

function drawValue(panel, reading, valueWidth, noteWidth = 0) {
  const out = document.createDocumentFragment();
  if (reading.fraction !== null) {
    const bar = el("span", { class: `bar${reading.alert ? " alerting" : ""}` });
    bar.append(el("i", { style: `width: ${Math.round(reading.fraction * 100)}%` }));
    out.append(bar);
  }
  const blinking = reading.alert && !seen.has(alertKey(panel, reading));
  const text = el("span", { class: "value-text", style: valueWidth ? `min-width: ${valueWidth}ch` : null });
  text.append(el("span", { class: `${styleClass(reading)}${blinking ? " blinking" : ""}` }, reading.value));
  if (reading.unit) text.append(el("span", { class: "unit" }, ` ${reading.unit}`));
  const note = reading.note ? (reading.offline ? el("span", { class: "offline" }, ` ${reading.note}`) : ` ${reading.note}`) : "";
  if (noteWidth) {
    // In its own column, left-aligned, so that the figures before it line up too.
    out.append(text, el("span", { class: "value-note", style: `width: ${noteWidth + 1}ch` }, note));
    return out;
  }
  if (note) text.append(note);
  out.append(text);
  return out;
}

// A grid of icons with a name and value under each, like Glance's monitor: for many short items.
function drawIcons(panel, readings) {
  return el("div", { class: "icons" }, readings.map((reading) => {
    const blinking = reading.alert && !seen.has(alertKey(panel, reading));
    const [kind, name] = (reading.icon || "").split(":");
    // The SVG is a mask over horizontal lines in the theme colour: the icon drawn in scanlines.
    const icon = reading.icon
      ? el("span", { class: "glyph", style: `--icon: url("/api/icon/${kind}/${name}")` })
      : el("span", { class: "glyph letter" }, upper(reading.label).slice(0, 2));
    // With a link (a service's url), the whole tile opens it.
    const tag = reading.link ? "a" : "div";
    const link = reading.link ? { href: reading.link, target: "_blank", rel: "noopener noreferrer" } : {};
    const title = `${reading.label}: ${reading.value}${reading.update ? " · hay una actualización" : ""}`;
    return el(tag, { class: `tile ${styleClass(reading)}${reading.update ? " update" : ""}${blinking ? " blinking-icon" : ""}`, title, ...link },
      el("span", { class: "icon" }, icon),
      el("span", { class: "name" }, upper(reading.label)),
      el("span", { class: `${styleClass(reading)}${blinking ? " blinking" : ""}` }, reading.value));
  }));
}

// A grid of buttons (3 by 3) that run Home Assistant scripts: by a click, the cursor and Enter, or
// their number (1 to 9) while the window is open.
// The server only runs the scripts of the config, by their place in the panel.
function drawActions(view, readings) {
  const buttons = readings.slice(0, 9).map((reading, item) => {
    const [kind, name] = (reading.icon || "mdi:script-text").split(":");
    const id = `script:${view.index}:${item}`;
    const busy = running.has(id) || reading.switch === true;
    return el("button", {
      class: `tile action${busy ? " on" : ""}${reading.error ? " error" : ""}`, "data-cursor": id, "data-script": "1",
      title: reading.error ? `${reading.label}: no existe en Home Assistant` : reading.label,
      // A button that opens something of the page's (the iPod) instead of running a script.
      onclick: reading.opens ? () => openThing(reading.opens) : () => runScript(id, view.index, item, reading.label),
    },
    el("span", { class: "number-key" }, String(item + 1)),
    el("span", { class: "icon" }, el("span", { class: "glyph", style: `--icon: url("/api/icon/${kind}/${name}")` })),
    el("span", { class: "name" }, upper(reading.label)),
    el("span", { class: "dim" }, busy ? upper("en marcha") : reading.error ? upper(reading.opens ? "error" : "no existe") : "\u00a0"));
  });
  // The free places of the grid, as empty boxes: it's always three by three.
  const free = Array.from({ length: 9 - buttons.length }, () => el("div", { class: "tile action free" }));
  return el("div", { class: "actions" }, ...buttons, ...free);
}

function openThing(what) {
  if (what.startsWith("music:")) openIpod(what.slice("music:".length));
}

// The buttons pressed and not answered yet: they show "en marcha" until Home Assistant says.
const running = new Set();

// A message of the page's own for a few seconds in the notice strip: a script run, or why not.
let toast = null; // { text, until }
const TOAST_MS = 5000;

function showToast(text) {
  toast = { text, until: Date.now() + TOAST_MS };
  render();
  setTimeout(render, TOAST_MS + 50);
}

// The window closes at once, and the notice strip says what Home Assistant answered.
async function runScript(id, panel, item, name) {
  if (running.has(id)) return;
  running.add(id);
  if (popup === panel) popup = null;
  cursor = null;
  showToast(`${name} · ejecutando…`);
  try {
    const response = await fetch(`/api/script/${panel}/${item}`, { method: "POST" });
    const answer = await response.json().catch(() => ({}));
    if (response.ok) {
      update(answer);
      showToast(`✓ ${name} · ejecutado`);
    } else showToast(`✖ ${name} · no se ha podido ejecutar${answer.error ? `: ${answer.error}` : ""}`);
  } catch {
    showToast(`✖ ${name} · sin conexión con Marianne`);
  } finally {
    running.delete(id);
    render();
  }
}

function drawBig(panel, reading) {
  const blinking = reading.alert && !seen.has(alertKey(panel, reading));
  const number = el("div", { class: `number segments ${styleClass(reading)}${blinking ? " blinking" : ""}` });
  setSegments(number, `${reading.value}${reading.unit}`);
  const row = el("div", { class: "big-row" });
  if (reading.art) row.append(el("pre", { class: "art" }, reading.art.join("\n")));
  row.append(number);
  const extras = (reading.extra || []).slice(0, 3);
  if (extras.length) {
    // Today's max and min (and the chance of rain), small beside it.
    row.append(el("div", { class: `side${extras.length === 3 ? " three" : ""}` },
      extras.map((extra) => el("div", {},
        el("span", { class: "dim" }, `${extra.label} `),
        el("span", { class: styleClass(extra) }, `${extra.value}${extra.unit === "°C" ? "°" : extra.unit}`)))));
  }
  return el("div", { class: "big" }, row,
    el("div", { class: "caption" }, upper(reading.label),
      reading.note ? el("span", { class: reading.offline ? "offline" : reading.error ? "error" : null }, `  ${reading.note}`) : ""));
}

// Calendar helpers: dates as YYYY-MM-DD in local time.
const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const pad2 = (number) => String(number).padStart(2, "0");
const isoDate = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const fromIso = (iso) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

// The dates on one day, with the years for an anniversary (29 February is the 28th in other years).
function eventsOn(events, year, month, day) {
  const leap = new Date(year, 1, 29).getMonth() === 1;
  return events
    .filter((event) => event.month === month && (event.yearly || event.year === year)
      && (event.day === day || (!leap && event.month === 2 && event.day === 29 && day === 28)))
    .map((event) => (event.year && event.yearly ? `${event.name} · ${year - event.year} años` : event.name));
}

// The calendars' events of a day, in order: those lasting all day first, then by their time.
function eventsOfDay(events, iso) {
  return events
    .filter((event) => {
      const first = event.start.slice(0, 10);
      // An all-day event ends the day after its last; a timed one, on the day (and time) it ends.
      const last = event.all_day ? isoDate(new Date(fromIso(event.end.slice(0, 10)) - 86_400_000)) : event.end.slice(0, 10);
      return first <= iso && iso <= last && !(!event.all_day && event.end.slice(0, 10) === iso && event.end.slice(11) === "00:00" && first !== iso);
    })
    .sort((a, b) => (b.all_day - a.all_day) || a.start.localeCompare(b.start));
}

// The events of today, or of tomorrow with the "mañana" key, a row each: "HOY · YOGA …… 18:30–19:30"
// (or "todo el día"), ● on the one under way; with none, a single "HOY · NADA" row. No title row:
// the panel has little room left.
function drawAgenda(reading) {
  const day = new Date();
  day.setDate(day.getDate() + chartDay);
  const iso = isoDate(day);
  const now = new Date();
  const clock = `${iso}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const events = eventsOfDay(reading.agenda || [], iso);
  const when = chartDay ? "Mañana" : "Hoy";
  if (!events.length) {
    return el("div", { class: "agenda", title: reading.label },
      el("div", { class: "row" }, el("span", { class: "label dim" }, upper(`${when} · nada en ${reading.label}`))));
  }
  return el("div", { class: "agenda", title: reading.label }, events.map((event) => {
    const starts = event.start.slice(0, 10) === iso && !event.all_day ? event.start.slice(11, 16) : "";
    const ends = event.end.slice(0, 10) === iso && !event.all_day ? event.end.slice(11, 16) : "";
    const time = event.all_day ? "todo el día" : starts && ends ? `${starts}–${ends}` : starts ? `desde ${starts}` : ends ? `hasta ${ends}` : "todo el día";
    const under = !chartDay && !event.all_day && event.start <= clock && clock < event.end;
    return el("div", { class: "row" },
      el("span", { class: `label${under ? " on" : ""}` },
        el("span", { class: "dim" }, upper(`${under ? "● " : ""}${when} · `)), upper(event.name)),
      el("span", { class: "leader" }),
      el("span", { class: "values" }, el("span", { class: under ? "on" : "value" }, upper(time))));
  }));
}

// A month like the terminal's `cal`: today in reverse video, the countdown's dates underlined and
// the weekend dimmer. ‹ › go to another month.
function drawCalendar(calendar) {
  const view = calendarView || { year: calendar.year, month: calendar.month };
  const first = new Date(view.year, view.month - 1, 1);
  const length = new Date(view.year, view.month, 0).getDate();
  const firstWeekday = (first.getDay() + 6) % 7;
  const today = `${calendar.year}-${pad2(calendar.month)}-${pad2(calendar.today)}`;
  const cells = [];
  // The usual Spanish initials: X for miércoles, so it isn't confused with martes.
  for (const day of ["l", "m", "x", "j", "v", "s", "d"]) cells.push(el("span", { class: "weekday" }, upper(day)));
  for (let blank = 0; blank < firstWeekday; blank += 1) cells.push(el("span", {}));
  const dayCell = (day) => {
    const iso = `${view.year}-${pad2(view.month)}-${pad2(day)}`;
    // The countdown's dates are marked (their names in the tooltip); the calendars' events aren't,
    // they're listed beside (see drawAgenda).
    const marked = eventsOn(calendar.events || [], view.year, view.month, day);
    const classes = ["day", (firstWeekday + day - 1) % 7 >= 5 ? "weekend" : "", marked.length ? "marked" : "",
      iso === today ? "today" : "", iso === calendarDay ? "selected" : ""].filter(Boolean);
    return el("span", {
      class: classes.join(" "), title: marked.length ? marked.join(", ") : null, onclick: () => pickCalendarDay(iso),
    }, String(day));
  };
  for (let day = 1; day <= length; day += 1) cells.push(dayCell(day));
  const arrow = (text, step) => el("button", { class: "calendar-arrow", onclick: () => shiftCalendarMonth(step) }, text);
  return el("div", { class: "calendar", "data-cursor": CALENDAR_CURSOR },
    el("div", { class: "calendar-title" }, arrow("‹", -1),
      el("span", {}, upper(`${MONTH_NAMES[view.month - 1]} ${view.year}`)), arrow("›", 1)),
    el("div", { class: "calendar-grid" }, cells));
}

// What the picked day is: under the panel's rows, where there's room for it.
function drawCalendarInfo(calendar) {
  if (!calendarDay) return null;
  const text = `▸ ${describeDay(calendar, calendarDay)}`;
  return el("div", { class: "calendar-info", title: text }, text);
}

// "SÁ 31/10 · EN 7 DÍAS · HALLOWEEN"
function describeDay(calendar, iso) {
  const date = fromIso(iso);
  const today = new Date(calendar.year, calendar.month - 1, calendar.today);
  const days = Math.round((date - today) / 86_400_000);
  const when = days === 0 ? "hoy" : days === 1 ? "mañana" : days === -1 ? "ayer" : days > 0 ? `en ${days} días` : `hace ${-days} días`;
  const weekday = ["do", "lu", "ma", "mi", "ju", "vi", "sá"][date.getDay()];
  const year = date.getFullYear() === calendar.year ? "" : `/${date.getFullYear()}`;
  const names = eventsOn(calendar.events || [], date.getFullYear(), date.getMonth() + 1, date.getDate());
  return upper([`${weekday} ${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}${year}`, when, ...names].join(" · "));
}

function calendarReading() {
  for (const { data } of panelViews()) {
    const reading = data.readings.find((reading) => reading.calendar);
    if (reading) return reading.calendar;
  }
  return null;
}

function pickCalendarDay(iso) {
  calendarDay = iso;
  calendarView = { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
  cursor = CALENDAR_CURSOR;
  render();
}

function moveCalendarDay(step) {
  const date = fromIso(calendarDay);
  date.setDate(date.getDate() + step);
  pickCalendarDay(isoDate(date));
}

function shiftCalendarMonth(step) {
  const calendar = calendarReading();
  if (!calendar) return;
  const view = calendarView || { year: calendar.year, month: calendar.month };
  const date = new Date(view.year, view.month - 1 + step, 1);
  calendarView = { year: date.getFullYear(), month: date.getMonth() + 1 };
  // The picked day keeps its place in the new month (the 31st becomes its last day).
  if (calendarDay) {
    const last = new Date(calendarView.year, calendarView.month, 0).getDate();
    calendarDay = `${calendarView.year}-${pad2(calendarView.month)}-${pad2(Math.min(Number(calendarDay.slice(8)), last))}`;
  }
  render();
}

function leaveCalendar() {
  calendarDay = null;
  calendarView = null;
}

// The day's weather: temperature (thick line, in red below 0 °C), wind (thin line), rain (bars as
// high as the mm an hour and as wide as the chance of it; red when heavy) and clouds (a row of
// double chevrons at their %). Hours gone show what was observed; the rest, the forecast.
function drawChart(chart) {
  const day = chart.days[Math.min(chartDay, chart.days.length - 1)];
  // The drawing stretches to the panel's width; the numbers go around it, in HTML, so they don't.
  const W = 240, top = 3, bottom = 100;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "chart");
  svg.setAttribute("viewBox", `0 0 ${W} ${bottom}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const draw = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    svg.append(node);
    return node;
  };
  const x = (t) => ((t - day.start) / (day.end - day.start)) * W;
  const height = bottom - top;
  const points = day.points;
  const temps = points.map((point) => point.temp);
  let low = Math.floor(Math.min(...temps)) - 1, high = Math.ceil(Math.max(...temps)) + 1;
  if (!temps.length) [low, high] = [0, 10];
  if (high - low < 6) [low, high] = [Math.floor((low + high) / 2 - 3), Math.ceil((low + high) / 2 + 3)];
  const yTemp = (value) => bottom - ((value - low) / (high - low)) * height;
  const gust = (point) => Math.max(point.gust ?? point.wind, point.wind);
  const windTop = Math.round(Math.max(30, ...points.map(gust)) * 1.1);
  const yWind = (value) => bottom - (value / windTop) * height;
  const rainTop = Math.max(chart.heavy_rain * 2, ...day.bars.map((bar) => bar.rain));
  const yClouds = (value) => bottom - (value / 100) * height;

  for (let hour = 3; hour < 24; hour += 3) {
    const at = x(day.start + hour * 3600);
    draw("line", { class: "tick", x1: at, y1: top, x2: at, y2: bottom });
  }
  // And across, on the rain's scale (the left axis): every 1, 2, 5 or 10 mm/h, the smallest step that
  // gives 5 lines at most. The temperature only keeps its red line at 0 °C.
  const yRain = (value) => bottom - (value / rainTop) * height;
  const step = [1, 2, 5, 10, 20].find((size) => rainTop / size <= 5) || 20;
  for (let mm = step; mm < rainTop - 0.01; mm += step) {
    draw("line", { class: "tick", x1: 0, y1: yRain(mm), x2: W, y2: yRain(mm) });
  }
  if (low < 0 && high > 0) draw("line", { class: "zero", x1: 0, y1: yTemp(0), x2: W, y2: yTemp(0) });

  // Rain: as high as the mm an hour across its whole slot, as solid as the chance of it
  // (observed rain is certain).
  for (const bar of day.bars) {
    const from = x(bar.from), to = x(bar.to);
    const tall = Math.max(1.5, Math.min(1, bar.rain / rainTop) * height);
    const heavy = bar.rain >= chart.heavy_rain;
    draw("rect", {
      class: `rain${heavy ? " heavy" : ""}`,
      x: from + 0.3, y: bottom - tall, width: Math.max(0.6, to - from - 0.6), height: tall,
      "fill-opacity": (0.12 + 0.78 * Math.max(0, Math.min(1, bar.pop))).toFixed(2),
    });
  }

  // Clouds: a double chevron every hour at the % of sky covered, interpolated between points.
  const interpolate = (t, key) => {
    const after = points.findIndex((point) => point.t >= t);
    if (after < 0 || (after === 0 && points[0].t > t)) return null;
    if (points[after].t === t) return points[after][key];
    const a = points[after - 1], b = points[after];
    return a[key] + ((b[key] - a[key]) * (t - a.t)) / (b.t - a.t);
  };
  for (let hour = 0; hour < 24; hour += 1) {
    const t = day.start + hour * 3600 + 1800;
    const clouds = interpolate(t, "clouds");
    if (clouds === null) continue;
    const cx = x(t), cy = Math.max(top + 3, Math.min(bottom - 6, yClouds(clouds)));
    const d = `M ${cx - 3} ${cy + 1.5} L ${cx} ${cy - 1.5} L ${cx + 3} ${cy + 1.5} M ${cx - 3} ${cy + 4.5} L ${cx} ${cy + 1.5} L ${cx + 3} ${cy + 4.5}`;
    draw("path", { class: "outline", d });
    draw("path", { class: "clouds", d });
  }

  // Wind, thin; then the temperature, thick, split where it crosses 0 °C to paint the cold in red.
  const line = (key, y) => points.map((point) => `${x(point.t).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  // Each line goes over a thin black one a little wider, so that it stands out from the rest.
  if (points.length > 1) {
    // The gusts: a thin line over the wind's, with a faint fill between the two.
    const along = (value) => points.map((point) => `${x(point.t).toFixed(1)},${yWind(value(point)).toFixed(1)}`);
    draw("polygon", { class: "gust-band", points: [...along((point) => point.wind), ...along(gust).reverse()].join(" ") });
    draw("polyline", { class: "outline", points: along(gust).join(" ") });
    draw("polyline", { class: "gust", points: along(gust).join(" ") });
    draw("polyline", { class: "outline", points: line("wind", yWind) });
    draw("polyline", { class: "wind", points: line("wind", yWind) });
    // Over it, in red, the stretches where the wind is strong, cut where it crosses the threshold.
    const strong = chart.strong_wind ?? 50;
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index];
      if (a.wind < strong && b.wind < strong) continue;
      const cross = () => a.t + ((strong - a.wind) * (b.t - a.t)) / (b.wind - a.wind);
      const t1 = a.wind >= strong ? a.t : cross(), t2 = b.wind >= strong ? b.t : cross();
      const at = (t) => a.wind + ((b.wind - a.wind) * (t - a.t)) / (b.t - a.t || 1);
      draw("line", { class: "wind strong", x1: x(t1), y1: yWind(at(t1)), x2: x(t2), y2: yWind(at(t2)) });
    }
    draw("polyline", { class: "outline thick", points: line("temp", yTemp) });
  }
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    const pieces = [[a.t, a.temp]];
    if ((a.temp < 0) !== (b.temp < 0)) pieces.push([a.t + ((0 - a.temp) * (b.t - a.t)) / (b.temp - a.temp), 0]);
    pieces.push([b.t, b.temp]);
    for (let piece = 1; piece < pieces.length; piece += 1) {
      const [t1, v1] = pieces[piece - 1], [t2, v2] = pieces[piece];
      draw("line", { class: `temp${(v1 + v2) / 2 < 0 ? " cold" : ""}`, x1: x(t1), y1: yTemp(v1), x2: x(t2), y2: yTemp(v2) });
    }
  }

  // Now, on today's chart: left of it what was observed, right of it the forecast.
  if (chart.now >= day.start && chart.now < day.end) {
    draw("line", { class: "now", x1: x(chart.now), y1: top, x2: x(chart.now), y2: bottom });
  }
  const inspected = chartHour === null ? null : day.start + chartHour * 3600;
  if (inspected !== null) draw("line", { class: "inspect", x1: x(inspected), y1: top, x2: x(inspected), y2: bottom });

  // Under it: the conditions now, or at the hour picked.
  let readout;
  if (inspected !== null) readout = conditionsAt(chart, day, inspected, interpolate);
  else if (!chartDay && chart.current) readout = conditionsNow(chart.current);
  else readout = daySummary(day);
  // The day's highest and lowest temperature, written on the line itself (in HTML over the
  // drawing, so the stretching doesn't distort them).
  const inDay = points.filter((point) => point.t >= day.start && point.t < day.end);
  const marks = [];
  if (inDay.length > 1) {
    const hottest = inDay.reduce((best, point) => (point.temp > best.temp ? point : best));
    const coldest = inDay.reduce((best, point) => (point.temp < best.temp ? point : best));
    for (const [point, kind] of [[hottest, "max"], [coldest, "min"]]) {
      const left = Math.max(3, Math.min(97, (x(point.t) / W) * 100));
      const topPercent = (yTemp(point.temp) / bottom) * 100;
      // Above the max and below the min, unless that would leave the chart: then the other side.
      const below = kind === "max" ? topPercent < 20 : topPercent < 80;
      marks.push(el("span", {
        class: `chart-mark ${below ? "below" : "above"}${point.temp < 0 ? " cold" : ""}`,
        style: `left: ${left.toFixed(1)}%; top: ${topPercent.toFixed(1)}%`,
      }, `${Math.round(point.temp)}°`));
    }
  }
  // Midnight at the left edge needs no label; then one every 3 hours.
  const hours = [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => el("span", {}, hour ? String(hour).padStart(2, "0") : ""));
  // Hovering (or a tap on a phone) picks the hour under the pointer.
  const pick = (event) => {
    const box = svg.getBoundingClientRect();
    const hour = Math.max(0, Math.min(23, Math.round(((event.clientX - box.left) / box.width) * 24)));
    if (hour !== chartHour) {
      chartHour = hour;
      render();
    }
  };
  svg.addEventListener("pointermove", pick);
  svg.addEventListener("pointerdown", pick);
  svg.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && cursor !== CHART_CURSOR && chartHour !== null) {
      chartHour = null;
      render();
    }
  });
  // Open-Meteo's data is CC BY 4.0: it's credited where the chart shows it.
  const credit = chart.hourly ? "Previsión por horas: Open-Meteo.com (CC BY 4.0)" : null;
  return el("div", { class: "chart-box", "data-cursor": CHART_CURSOR, title: credit },
    el("div", { class: "chart-plot" },
      // Left, the rain's scale (mm an hour, at the top of the bars); right, the wind's. The temperature
      // has its max and min written on its line.
      el("div", { class: "chart-axis" }, el("span", {}, `${rainTop < 10 ? Number(rainTop.toFixed(1)) : Math.round(rainTop)}`), el("span", {}, "mm/h")),
      el("div", { class: "chart-area" }, svg, marks),
      el("div", { class: "chart-axis right" }, el("span", {}, `${windTop}`), el("span", {}, "km/h"))),
    el("div", { class: "chart-hours" }, hours),
    el("div", { class: `chart-caption${inspected === null ? "" : " inspecting"}` }, withDimUnits(readout)));
}

// The conditions at one moment of the chart: observed if it has gone by, forecast if not.
function conditionsAt(chart, day, t, interpolate) {
  const hour = `${String(Math.round((t - day.start) / 3600)).padStart(2, "0")}:00`;
  const temp = interpolate(t, "temp");
  if (temp === null) return upper(`${hour}  sin datos`);
  const wind = interpolate(t, "wind"), clouds = interpolate(t, "clouds"), gusts = interpolate(t, "gust");
  const bar = day.bars.find((bar) => bar.from <= t && t < bar.to);
  const rain = bar ? `☂ ${bar.rain.toFixed(1)} mm/h${bar.observed ? "" : ` ${Math.round(bar.pop * 100)}%`}` : "☂ 0";
  // Gone by: observed, or estimated by Open-Meteo where nothing was observed.
  const nearest = day.points.reduce((best, point) => (Math.abs(point.t - t) < Math.abs(best.t - t) ? point : best), day.points[0]);
  const when = t >= chart.now ? "previsto" : nearest && nearest.estimated ? "estimado" : "observado";
  return upper([hour, `${temp.toFixed(1)}°C`, `${windAndGusts(wind, gusts)} km/h`, rain, `︽ ${Math.round(clouds)}%`, when].join("  "));
}

// A line of figures with its units dim: "8.5°C 15–40 KM/H" → the °C and KM/H in the dim colour.
function withDimUnits(text) {
  const out = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(/°C|KM\/H|MM\/H|MM\b|%/gi)) {
    out.append(text.slice(last, match.index), el("span", { class: "unit" }, match[0]));
    last = match.index + match[0].length;
  }
  out.append(text.slice(last));
  return out;
}

// "26–40": the wind and, if they're stronger, its gusts.
// Tomorrow in one line: its highest and lowest, its strongest wind and gusts and its rain (total and
// chance): "MAÑANA ▲ 15° ▼ 8° 17–45 KM/H ☂ 4.2 MM 87%".
function daySummary(day) {
  const inDay = day.points.filter((point) => point.t >= day.start && point.t < day.end);
  if (!inDay.length) return upper("Mañana  sin datos");
  const most = (key) => Math.max(...inDay.map((point) => point[key] ?? point.wind));
  const degrees = (value) => (value === null || value === undefined ? "--" : `${Math.round(value)}°`);
  return upper([
    "Mañana", `▲ ${degrees(day.max)}`, `▼ ${degrees(day.min)}`, `${windAndGusts(most("wind"), most("gust"))} km/h`,
    `☂ ${(day.rain || 0).toFixed(1)} mm ${Math.round(day.pop || 0)}%`,
  ].join("  "));
}

function windAndGusts(wind, gusts) {
  return gusts !== null && gusts !== undefined && Math.round(gusts) > Math.round(wind)
    ? `${Math.round(wind)}–${Math.round(gusts)}` : `${Math.round(wind)}`;
}

// Where the wind blows from, as on a weather map: N, NE, E... (O for oeste); nothing when calm.
function windFrom(degrees, speed) {
  if (degrees === undefined || degrees === null || speed < 1) return "";
  return ` ${["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(degrees / 45) % 8]}`;
}

function conditionsNow(sample) {
  return upper([
    "Ahora", `${sample.temp.toFixed(1)}°C`, `${windAndGusts(sample.wind, sample.gust)} km/h${windFrom(sample.deg, sample.wind)}`,
    `☂ ${sample.rain.toFixed(1)} mm/h`, `︽ ${Math.round(sample.clouds)}%`,
  ].join("  "));
}

// Where the hour starts when the cursor lands on the chart: now on today's (in the city's time,
// as the chart is), midday on tomorrow's.
function startHour() {
  if (chartDay) return 12;
  for (const { data } of panelViews()) {
    const reading = data.readings.find((reading) => reading.chart);
    if (reading) return Math.max(0, Math.min(23, Math.floor((reading.chart.now - reading.chart.days[0].start) / 3600)));
  }
  return 12;
}

function toggleChartDay() {
  chartDay = chartDay ? 0 : 1;
  render();
}

// The energy widget: the power now in big digits (with a flame while the heating is on), today's
// curve of it with the heating's spells under it, and today's totals; under them, the room's
// temperature and the thermostat's target (ECO in eco mode; APAGADA over the chart when it's off).
function drawEnergy(reading) {
  const energy = reading.energy;
  const ns = "http://www.w3.org/2000/svg";
  const svgOf = (cls, box) => {
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", cls);
    svg.setAttribute("viewBox", box);
    return svg;
  };
  const draw = (svg, tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    svg.append(node);
    return node;
  };

  // The flame: the mdi:fire icon in scanlines, like the services' icons.
  const flame = el("span", { class: `flame${energy.flame ? "" : " out"}`, style: 'mask-image: url("/api/icon/mdi/fire"); -webkit-mask-image: url("/api/icon/mdi/fire")' });
  const number = el("div", { class: `number segments ${styleClass(reading)}` });
  setSegments(number, `${reading.value}W`);
  // The flame after the figure, raised like an exponent.
  const now = el("div", { class: "energy-now", title: energy.flame ? "La calefacción está calentando" : null }, number, flame);

  // Today's curve: power (filled), the heating's spells (a strip at the bottom and a faint column).
  const W = 240, top = 3, bottom = 60, height = bottom - top;
  const chart = svgOf("chart energy-chart", `0 0 ${W} ${bottom}`);
  chart.setAttribute("preserveAspectRatio", "none");
  const x = (t) => ((t - energy.start) / (energy.end - energy.start)) * W;
  const peak = Math.max(1000, ...energy.series.map(([, watts]) => watts)) * 1.1;
  const scaleTop = peak >= 5000 ? Math.ceil(peak / 1000) * 1000 : Math.ceil(peak / 500) * 500;
  const y = (watts) => bottom - (watts / scaleTop) * height;
  for (let hour = 3; hour < 24; hour += 3) {
    const at = x(energy.start + hour * 3600);
    draw(chart, "line", { class: "tick", x1: at, y1: top, x2: at, y2: bottom });
  }
  for (const [from, to] of energy.heating) {
    draw(chart, "rect", { class: "heat-span", x: x(from), y: top, width: Math.max(0.5, x(to) - x(from)), height });
    draw(chart, "rect", { class: "heat-strip", x: x(from), y: bottom - 4, width: Math.max(0.5, x(to) - x(from)), height: 4 });
  }
  if (energy.series.length > 1) {
    const line = energy.series.map(([t, watts]) => `${x(t).toFixed(1)},${y(watts).toFixed(1)}`);
    const first = energy.series[0][0], last = energy.series[energy.series.length - 1][0];
    draw(chart, "polygon", { class: "power-area", points: `${x(first)},${bottom} ${line.join(" ")} ${x(last)},${bottom}` });
    draw(chart, "polyline", { class: "power-line", points: line.join(" ") });
  }
  if (energy.now >= energy.start && energy.now < energy.end) {
    draw(chart, "line", { class: "now", x1: x(energy.now), y1: top, x2: x(energy.now), y2: bottom });
  }
  const scaleText = scaleTop >= 1000 ? `${scaleTop / 1000}k` : `${scaleTop}`;
  const hours = [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => el("span", {}, hour ? String(hour).padStart(2, "0") : ""));
  const area = el("div", { class: "chart-area" }, chart,
    energy.off ? el("span", { class: "energy-off" }, upper("Calefacción apagada")) : null);
  const plot = el("div", { class: "energy-plot" },
    el("div", { class: "chart-plot energy-grid" },
      el("div", { class: "chart-axis" }, el("span", {}, scaleText), el("span", {}, "W")), area),
    el("div", { class: "chart-hours energy-hours" }, hours));

  // Today's totals, on a line under the chart: "HOY · LUZ 7.84 kWh · CALEFACCIÓN 5 H 12 MIN".
  const kwh = energy.kwh === null || energy.kwh === undefined ? "--" : energy.kwh.toFixed(2);
  const [hours_, minutes_] = [energy.heat_text.match(/(\d+) h/), energy.heat_text.match(/(\d+) min/)];
  const heatParts = [hours_ && [hours_[1], "h"], minutes_ && [minutes_[1], "min"]].filter(Boolean);
  const totals = el("div", { class: "row summary energy-totals" }, el("span", { class: "label" },
    el("span", { class: "token-label" }, upper("Hoy")), " ", el("span", { class: "token-sep" }, "·"), " ",
    el("span", { class: "token-label" }, upper(reading.label)), " ", el("span", { class: "token-value" }, kwh), " ",
    el("span", { class: "token-unit" }, "kWh"), " ", el("span", { class: "token-sep" }, "·"), " ",
    el("span", { class: "token-label" }, upper("Calefacción")),
    (heatParts.length ? heatParts : [["0", "min"]]).flatMap(([number, unit]) =>
      [" ", el("span", { class: "token-value" }, number), " ", el("span", { class: "token-unit" }, upper(unit))])));

  const degrees = (value) => (value === null || value === undefined ? "--" : Number(value).toFixed(1));
  // The room chasing the target: a bar on the thermostat's scale filled up to the room's temperature,
  // a mark at the target, and "18.4 °C ▲ 19.0 °C" (▲ while heating, ▼ while not; nothing when off).
  const [low, high] = energy.scale || [14, 24];
  const place = (value) => Math.max(0, Math.min(1, (value - low) / (high - low)));
  const bar = el("span", { class: "bar thermo" });
  if (energy.room_temp !== null && energy.room_temp !== undefined) {
    bar.append(el("i", { style: `width: ${Math.round(place(energy.room_temp) * 100)}%` }));
  }
  if (energy.target !== null && energy.target !== undefined) {
    bar.append(el("b", { class: `target-mark${energy.off ? " off" : ""}`, style: `left: ${(place(energy.target) * 100).toFixed(1)}%` }));
  }
  const arrow = energy.off ? "" : energy.flame ? " ▲ " : " ▼ ";
  const thermostat = el("div", { class: "row wide", title: `${energy.room}: ${degrees(energy.room_temp)} °C · objetivo ${degrees(energy.target)} °C` },
    el("span", { class: "label", style: "flex: none; margin-right: 1ch" }, upper("Objetivo")),
    el("span", { class: "values" },
      el("span", { class: "dim scale-end" }, `${low}°`), bar, el("span", { class: "dim scale-end" }, `${high}°`),
      el("span", { class: "value-text" },
        el("span", { class: "value" }, degrees(energy.room_temp)), el("span", { class: "unit" }, " °C"),
        el("span", { class: energy.flame ? "on" : "dim" }, arrow || " "),
        el("span", { class: energy.off ? "dim" : "value" }, degrees(energy.target)), el("span", { class: "unit" }, " °C"),
        energy.eco ? el("span", { class: "on" }, upper(" · eco")) : null,
        energy.off ? el("span", { class: "dim" }, upper(" · apagada")) : null)));
  return [el("div", { class: "energy" }, el("div", { class: "energy-top" }, now, plot), totals), thermostat];
}

// The "mañana" key (the weather chart's day_key, M by default): tomorrow's weather and tomorrow's
// events; null if there's neither.
function chartKey() {
  let agenda = false;
  for (const { data } of panelViews()) {
    const reading = data.readings.find((reading) => reading.chart);
    if (reading) return reading.chart.key;
    agenda = agenda || data.readings.some((reading) => reading.agenda);
  }
  return agenda ? "m" : null;
}

// The Sun's height through today, hour by hour (00 to 24), over the horizon: today's curve (bright
// above it, dim below) with the Sun at this moment, and the solstices' curves, dashed, as the
// year's highest and lowest; the times of sunrise, solar noon and sunset where they happen. Under
// it, how long the day and the night are.
function drawSunPath(readings, path) {
  const value = (role) => (readings[role] && !readings[role].error ? `${readings[role].value}${readings[role].unit}` : "");
  const W = 300, top = 10, bottom = 82;
  // The summer solstice's top close to the top edge: the room above it was wasted, and the curves
  // (and their labels) spread over the whole height.
  const highest = Math.max(...path.summer.map(([, e]) => e));
  const high = highest + 3;
  // Below the horizon only a little: enough to see the night, not to take the room.
  const low = -10;
  const x = (minute) => (minute / 1440) * W;
  const y = (degrees) => top + ((high - Math.max(low, degrees)) / (high - low)) * (bottom - top);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "sun sun-path");
  svg.setAttribute("viewBox", `0 0 ${W} 100`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, v] of Object.entries(attrs)) node.setAttribute(name, v);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  const line = (curve, keep) => curve.filter(([, e]) => keep(e)).map(([m, e]) => `${x(m).toFixed(1)},${y(e).toFixed(1)}`).join(" ");
  // Above the horizon, split where the curve crosses it, so the line ends on it.
  const above = (curve) => {
    const pieces = [];
    let piece = [];
    curve.forEach(([m, e], i) => {
      const prev = curve[i - 1];
      if (prev && (prev[1] >= 0) !== (e >= 0)) {
        const cross = prev[0] + ((0 - prev[1]) * (m - prev[0])) / (e - prev[1]);
        piece.push(`${x(cross).toFixed(1)},${y(0).toFixed(1)}`);
        if (e < 0) { pieces.push(piece); piece = []; }
      }
      if (e >= 0) piece.push(`${x(m).toFixed(1)},${y(e).toFixed(1)}`);
    });
    if (piece.length) pieces.push(piece);
    return pieces.filter((points) => points.length > 1).map((points) => points.join(" "));
  };
  for (let hour = 3; hour < 24; hour += 3) add("line", { class: "sun-tick", x1: x(hour * 60), y1: top - 6, x2: x(hour * 60), y2: bottom });
  add("line", { class: "horizon", x1: 0, y1: y(0), x2: W, y2: y(0) });
  for (const [curve, cls] of [[path.summer, "solstice"], [path.winter, "solstice"]]) {
    for (const points of above(curve)) add("polyline", { class: cls, points });
  }
  add("polyline", { class: "night-path", points: line(path.today, () => true) });
  for (const points of above(path.today)) add("polyline", { class: "travelled", points });
  // The solstices' highest points, labelled: summer's over its curve; winter's under the horizon at
  // noon, where nothing else is (between its curve and today's there's no room).
  for (const [curve, name, under] of [[path.summer, "21/6", false], [path.winter, "21/12", true]]) {
    const [m, e] = curve.reduce((best, point) => (point[1] > best[1] ? point : best));
    add("text", { x: x(m), y: under ? y(0) + 10 : y(e) - 3, "text-anchor": "middle", class: "faint small" }, `${name} ${Math.round(e)}°`);
  }
  // The Sun now, on today's curve.
  const at = path.today.reduce((best, point) => (Math.abs(point[0] - path.now) < Math.abs(best[0] - path.now) ? point : best));
  add("circle", { class: at[1] >= 0 ? "body" : "body below", cx: x(path.now).toFixed(1), cy: y(at[1]).toFixed(1), r: 6 });
  // Today's highest point: solar noon and how high.
  const [noonMinute, noonHeight] = path.today.reduce((best, point) => (point[1] > best[1] ? point : best));
  add("text", { x: x(noonMinute), y: y(noonHeight) - 6, "text-anchor": "middle" }, `${value("noon") || ""} ${Math.round(noonHeight)}°`.trim());
  add("text", { x: 0, y: 11 }, value("elevation"));
  add("text", { x: W, y: 11, "text-anchor": "end" }, value("azimuth"));
  // Sunrise and sunset where today's curve meets the horizon.
  const crossings = [];
  path.today.forEach(([m, e], i) => {
    const prev = path.today[i - 1];
    if (prev && (prev[1] >= -0.833) !== (e >= -0.833)) crossings.push(prev[0] + ((-0.833 - prev[1]) * (m - prev[0])) / (e - prev[1]));
  });
  const [riseAt, setAt] = [crossings[0], crossings[crossings.length - 1]];
  if (riseAt !== undefined) add("text", { x: x(riseAt), y: 97, "text-anchor": "middle" }, value("rising") || "");
  if (setAt !== undefined && setAt !== riseAt) add("text", { x: x(setAt), y: 97, "text-anchor": "middle" }, value("setting") || "");
  add("text", { x: 0, y: 97, class: "faint" }, value("dawn"));
  add("text", { x: W, y: 97, "text-anchor": "end", class: "faint" }, value("dusk"));
  const hm = (minutes) => [Math.floor(minutes / 60), Math.round(minutes % 60)];
  const [lh, lm] = hm(path.light), [dh, dm] = hm(path.dark);
  const lengths = el("div", { class: "row summary sun-lengths" }, el("span", { class: "label" },
    el("span", { class: "token-label" }, upper("Luz")), " ", el("span", { class: "token-value" }, String(lh)), " ",
    el("span", { class: "token-unit" }, "H"), " ", el("span", { class: "token-value" }, String(lm)), " ",
    el("span", { class: "token-unit" }, "MIN"), " ", el("span", { class: "token-sep" }, "·"), " ",
    el("span", { class: "token-label" }, upper("Oscuridad")), " ", el("span", { class: "token-value" }, String(dh)), " ",
    el("span", { class: "token-unit" }, "H"), " ", el("span", { class: "token-value" }, String(dm)), " ",
    el("span", { class: "token-unit" }, "MIN")));
  return [svg, lengths, el("div", { class: "rule" })];
}

// The Sun's day: an arc from sunrise to sunset with the Sun on it, like the terminal diagram.
function drawSun(readings) {
  const value = (role) => (readings[role] && !readings[role].error ? `${readings[role].value}${readings[role].unit}` : "");
  const minutes = (role) => {
    const match = /^(\d{1,2}):(\d{2})/.exec(value(role));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const time = (role) => (minutes(role) === null ? "--:--" : value(role));
  const W = 300, base = 84, left = 58, right = 242;
  const cx = (left + right) / 2, rx = (right - left) / 2, ry = 60;
  const now = new Date();
  const clock = now.getHours() * 60 + now.getMinutes();
  const rise = minutes("rising"), set = minutes("setting");
  const progress = rise !== null && set !== null && rise < clock && clock < set ? (clock - rise) / (set - rise) : null;
  const point = (p) => [cx - rx * Math.cos(Math.PI * p), base - ry * Math.sin(Math.PI * p)];

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "sun");
  svg.setAttribute("viewBox", `0 0 ${W} 120`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, v] of Object.entries(attrs)) node.setAttribute(name, v);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  add("path", { class: "arc", d: `M ${left} ${base} A ${rx} ${ry} 0 0 1 ${right} ${base}` });
  if (progress !== null) {
    const [x, y] = point(progress);
    add("path", { class: "travelled", d: `M ${left} ${base} A ${rx} ${ry} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}` });
    add("circle", { class: "body", cx: x.toFixed(1), cy: y.toFixed(1), r: 7 });
  }
  add("line", { class: "horizon", x1: 0, y1: base, x2: W, y2: base });
  add("text", { x: cx, y: 14, "text-anchor": "middle" }, time("noon"));
  add("text", { x: 0, y: 14 }, value("elevation"));
  add("text", { x: 0, y: 32 }, value("azimuth"));
  add("text", { x: 0, y: 106, class: "faint" }, time("dawn"));
  add("text", { x: left, y: 106, "text-anchor": "middle" }, time("rising"));
  add("text", { x: right, y: 106, "text-anchor": "middle" }, time("setting"));
  add("text", { x: W, y: 106, "text-anchor": "end", class: "faint" }, time("dusk"));
  return svg;
}

function renderStatus() {
  if (!layout) return;
  const bar = document.getElementById("status");
  const items = [];
  if (state && state.offline) items.push(el("span", { class: "source bad" }, "✖ SIN CONEXIÓN CON EL SERVIDOR"));
  // The state of every data source; the commands are in the help (F1).
  for (const source of (state && state.sources) || []) {
    const mark = source.ok === null ? "◌" : source.ok ? "■" : "✖";
    const cls = source.ok === null ? " waiting-source" : source.ok ? "" : " bad";
    items.push(el("span", { class: `source${cls}` }, `${mark} ${source.name.toUpperCase()}`));
  }
  // A click on one of these does the same as pressing its key (see the listener on #status).
  const key = (letter, text, flashing = false) =>
    el("button", { class: flashing ? "flashing" : null, "data-key": letter }, `[${KEY_NAMES[letter] || letter.toUpperCase()}]${text}`);
  // What needs seeing stays in the bar: an alert not yet seen, a pop-up panel with one.
  if (state && unseenAlerts().length) items.push(key("v", "VISTO", true));
  for (const view of panelViews()) {
    if (!view.panel.key) continue;
    const fresh = view.data.readings.some((reading) => parts(reading).some((part) => part.alert && !seen.has(alertKey(view.panel, part))));
    if (fresh) items.push(key(view.panel.key, upper(view.panel.title) + "!", true));
  }
  // And what the keys do right now, with the cursor or a window open.
  if (cursor === CALENDAR_CURSOR && !reader) {
    if (calendarDay) items.push(key("q", "VOLVER"));
    else items.push(key("enter", "ELEGIR DÍA"), key("q", "SALIR"));
  } else if (cursor === CHART_CURSOR && !reader) items.push(key("enter", chartDay ? "HOY" : "MAÑANA"), key("q", "SALIR"));
  else if (cursor && !reader) items.push(key("enter", cursor.startsWith("script:") ? "EJECUTAR" : "ABRIR"), key("q", "SALIR"));
  else if (popup !== null && !reader && !dates) items.push(key("q", "CERRAR"));
  // What the iPod plays, with the iPod closed: a tap opens it.
  const track = currentTrack();
  if (track && !ipod.open) {
    const music = (layout.music || []).find((music) => music.name === ipod.source);
    items.push(el("button", { class: "now-playing", "data-key": "ipod" },
      `[-]${player.paused ? "❚❚" : "♪"} ${upper(track.title)} · ${upper(track.artist)}`));
  }
  // On a phone only "AYUDA": the key's name means nothing there.
  items.push(el("button", { class: "help-key", "data-key": "f1" }, el("span", { class: "keycap" }, "[F1]"), "AYUDA"));
  if (!audio || audio.state !== "running") items.push(el("span", { class: "sound-hint" }, "♪ PULSA UNA TECLA PARA ACTIVAR EL SONIDO"));
  items.push(el("span", { class: "ready" }, "READY"));
  // The state arrives every second: rebuilding unchanged buttons would swallow a tap that
  // straddles the rebuild (common on phones), so only replace them when something changed.
  const html = items.map((item) => item.outerHTML).join("");
  if (bar.dataset.html === html) return;
  bar.dataset.html = html;
  bar.replaceChildren(...items);
}

// ---------------------------------------------------------------- actions

function setTheme(name) {
  document.documentElement.dataset.theme = THEMES.includes(name) ? name : "amber";
}

function nextTheme() {
  const current = THEMES.indexOf(document.documentElement.dataset.theme);
  const next = THEMES[(current + 1) % THEMES.length];
  setTheme(next);
  save("marianne.theme", next);
}

function nextPage(index) {
  pages[index] = ((pages[index] || 0) + 1) % layout.panels[index].pages.length;
  save("marianne.pages", pages);
  render();
}

// A pop-up's key opens it, and with pages goes through them: open on the first, then the next,
// and after the last one it closes.
function pressPopupKey(index) {
  const panel = layout.panels[index];
  if (popup !== index) {
    if (!panel.page_key) pages[index] = 0;
    return togglePopup(index);
  }
  if (!panel.page_key && (pages[index] || 0) < panel.pages.length - 1) return nextPage(index);
  togglePopup(index);
}

function togglePopup(index) {
  popup = popup === index ? null : index;
  render();
}

function acknowledge() {
  for (const { panel, part } of allAlerts()) seen.add(alertKey(panel, part));
  save("marianne.seen", [...seen]);
  render();
}

function onKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (dates) return datesKey(event);
  if (ipod.open) return ipodKey(event);
  const key = event.key.toLowerCase();
  // Minimised with music, the iPod's keys go before the page's (M opens it again, not tomorrow).
  const ipodKeys = minimizedIpodKeys();
  if (ipodKeys[key]) {
    event.preventDefault();
    unlockAudio();
    return ipodKeys[key]();
  }
  // The arrows move the link cursor instead of scrolling; Enter opens its link, not a focused button;
  // F1 is the help here, not the browser's.
  if (Object.hasOwn(ARROWS, key) || (key === "enter" && (cursor || reader)) || key === "f1" || MONTH_KEYS[key]) event.preventDefault();
  press(key);
}

// A key, typed or clicked in the status bar.
function press(key) {
  unlockAudio();
  noticeFlashUntil = 0;
  // Q leaves, as in most terminal programs (and in elinor); Esc still does too.
  if (key === "q") key = "escape";
  if (key === "f1" || key === "?") {
    helpOpen = !helpOpen;
    return render();
  }
  if (helpOpen) {
    // From the help: Q closes it, and a command's key closes it and does it.
    helpOpen = false;
    if (key === "escape") return render();
  }
  if (reader) {
    // In the reader: left and right choose between reading on the web and leaving, Enter accepts,
    // up and down scroll the story. Q (or Esc) leaves too.
    if (key === "enter") {
      if (reader.choice === "close") return closeReader();
      return void window.open(reader.reading.link, "_blank", "noopener");
    }
    if (key === "escape") return closeReader();
    if (key === "arrowleft" || key === "arrowright") {
      const step = key === "arrowright" ? 1 : -1;
      const index = READER_CHOICES.indexOf(reader.choice) + step;
      reader.choice = READER_CHOICES[Math.max(0, Math.min(READER_CHOICES.length - 1, index))];
      return renderChoice();
    }
    if (Object.hasOwn(ARROWS, key)) {
      const box = document.querySelector("#popup .panel > .body");
      if (box) box.scrollBy(0, ARROWS[key][1] * 4 * parseFloat(getComputedStyle(box).lineHeight || "20"));
      return;
    }
  }
  if (Object.hasOwn(ARROWS, key)) return moveCursor(ARROWS[key]);
  if (key === "enter" && cursor === CHART_CURSOR) return toggleChartDay();
  if (key === "enter" && cursor === CALENDAR_CURSOR) {
    const calendar = calendarReading();
    if (!calendarDay && calendar) pickCalendarDay(`${calendar.year}-${pad2(calendar.month)}-${pad2(calendar.today)}`);
    return;
  }
  if (key === "escape" && cursor === CALENDAR_CURSOR && calendarDay) {
    // Out of the days, still on the calendar; once more and the cursor goes.
    calendarDay = null;
    return render();
  }
  if (key === "enter" && cursor) {
    const link = visibleLinks().find((node) => cursorId(node) === cursor);
    if (link && (link.dataset.reader || link.dataset.script)) return link.click();
    return void window.open(cursor, "_blank", "noopener");
  }
  if (key === layout.history_key) return toggleHistory();
  // < and > (or PgUp and PgDn) go to the calendar's month before and after, like its ‹ ›.
  if (MONTH_KEYS[key] && calendarReading()) return shiftCalendarMonth(MONTH_KEYS[key]);
  if (key === "escape" && calendarView && !cursor && popup === null) {
    // Q, with nothing else open, brings the calendar back to this month.
    leaveCalendar();
    return render();
  }
  if (key === "escape" && history && popup === null && !cursor) {
    history = null;
    return render();
  }
  if (key === "escape" && cursor) {
    leaveCalendar();
    cursor = null;
    chartHour = null;
    return render();
  }
  if (key === "escape" && popup !== null) return togglePopup(popup);
  // In the actions window, 1 to 9 press its buttons.
  if (popup !== null && layout.panels[popup].actions && /^[1-9]$/.test(key)) {
    const button = document.querySelector(`#popup [data-cursor="script:${popup}:${Number(key) - 1}"]`);
    if (button) button.click();
    return;
  }
  if (key === "r") return post("/api/reload");
  if (key === "c") return nextTheme();
  if (key === "v") return acknowledge();
  const editor = (layout.date_editors || []).find((editor) => editor.key === key);
  if (editor) return openDates(editor.name);
  const music = (layout.music || []).find((music) => music.key === key || (key === "ipod" && music));
  if (music) return openIpod(music.name);
  if (key === chartKey()) return toggleChartDay();
  for (const pomodoro of layout.pomodoros) {
    if (key === pomodoro.start_key) return post(`/api/pomodoro/${pomodoro.name}/toggle`);
    if (key === pomodoro.reset_key) return post(`/api/pomodoro/${pomodoro.name}/reset`);
  }
  layout.panels.forEach((panel, index) => {
    if (panel.key === key) pressPopupKey(index);
    else if (panel.page_key === key) nextPage(index);
  });
  render();
}

// ---------------------------------------------------------------- title

// The title, "Marianne" (Jane Austen's Marianne Dashwood), in Mrs Saint Delafield as an early-80s
// computer would draw it: written letter by letter on a small canvas, its alpha cut to hard
// pixels, and blown up without smoothing. The scanlines are the CSS's.
const BANNER_PIXEL = 3; // pixel size, 1 to 8
const BANNER_ART = 110; // px the drawing is made for: its pixels are BANNER_PIXEL at this height
const BANNER_HEIGHT = 88; // px on a big screen; it shrinks with the page (the CSS rem)

async function drawBanner() {
  const canvas = document.getElementById("banner-art");
  try {
    await Promise.race([document.fonts.load("400 80px 'Mrs Saint Delafield'"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  } catch {
    /* without the font, the browser's cursive */
  }
  const px = Math.max(1, Math.min(8, BANNER_PIXEL));
  const fs = 84 * 1.15;
  const text = "Marianne";
  const context = canvas.getContext("2d");
  const font = `400 ${fs / px}px 'Mrs Saint Delafield', cursive`;
  context.font = font;
  const spacing = (fs * 0.01) / px;
  const widths = [...text].map((letter) => context.measureText(letter).width);
  const height = Math.ceil(BANNER_ART / px);
  const width = Math.ceil(widths.reduce((sum, w) => sum + w + spacing, 0) + (fs / px) * 0.4);
  canvas.width = width;
  canvas.height = height;
  // Resizing a canvas resets its state.
  context.font = font;
  context.fillStyle = "#f2b23a";
  context.textBaseline = "alphabetic";
  let x = 0;
  [...text].forEach((letter, index) => {
    context.fillText(letter, x, height * 0.78);
    x += widths[index] + spacing;
  });
  // Hard pixels: each one lit or not.
  const image = context.getImageData(0, 0, width, height);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = image.data[i] > 100 ? 255 : 0;
  context.putImageData(image, 0, 0);
  // Its width follows from the height, as an image's would.
  canvas.style.width = "auto";
  canvas.style.height = `min(${BANNER_HEIGHT}px, ${(BANNER_HEIGHT / 19).toFixed(2)}rem)`;
}

// ---------------------------------------------------------------- big digits

// Big figures in VT323 itself, large like a phosphor display.
function setSegments(node, text) {
  node.textContent = text;
}

// ---------------------------------------------------------------- link cursor

const ARROWS = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] };
const KEY_NAMES = { enter: "↵", escape: "ESC", f1: "F1", " ": "ESPACIO" };
const MONTH_KEYS = { z: -1, x: 1, pageup: -1, pagedown: 1 };

// What the cursor is on: a link's address, or CHART_CURSOR for the weather chart.
const cursorId = (node) => node.getAttribute("href") || node.dataset.cursor;

// The links that can be seen: those of the open pop-up, or else of the grid, and not cut off by a
// panel; the weather chart counts as one.
function visibleLinks() {
  const root = document.getElementById(popup !== null ? "popup" : "panels");
  return [...root.querySelectorAll("a[href], [data-cursor]")].filter((link) => {
    const box = link.getBoundingClientRect();
    const body = link.closest(".body");
    if (!box.width || !box.height || !body) return Boolean(box.width && box.height);
    const area = body.getBoundingClientRect();
    // A chart or a calendar only has to start inside its panel: cut off at the bottom, it's still there.
    if (link.dataset.cursor) return box.top >= area.top - 1 && box.top < area.bottom;
    return box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
  });
}

// The cursor's one way through the page: the weather chart hour by hour, then the services (left to
// right and top to bottom), then the headlines (top to bottom). In a pop-up, its links in order.
function cursorTargets() {
  const visible = visibleLinks();
  if (popup !== null) return visible;
  const shown = (selector) => [...document.querySelectorAll(`#panels ${selector}`)].filter((node) => visible.includes(node));
  return [...shown(".chart-box[data-cursor]"), ...shown("a.tile"), ...shown(".row .label a[href]")];
}

// → and ↓ go forward along that way, ← and ↑ back; past the end it starts again.
function moveCursor([dx, dy]) {
  // A day picked on the calendar (by a tap): the arrows go through the days, up and down a week.
  if (cursor === CALENDAR_CURSOR && calendarDay) return moveCalendarDay(dx + dy * 7);
  const step = dx + dy > 0 ? 1 : -1;
  const targets = cursorTargets();
  if (!targets.length) return;
  const index = targets.findIndex((target) => cursorId(target) === cursor);
  if (index >= 0 && cursor === CHART_CURSOR) {
    const hour = (chartHour ?? startHour()) + step;
    if (hour >= 0 && hour <= 23) {
      chartHour = hour;
      return render();
    }
  }
  const target = index < 0 ? targets[step > 0 ? 0 : targets.length - 1] : targets[(index + step + targets.length) % targets.length];
  const from = cursor;
  cursor = cursorId(target);
  if (from === CALENDAR_CURSOR) leaveCalendar();
  // Into the chart: at now when the cursor starts there, at its first or last hour when it comes along the way.
  chartHour = cursor !== CHART_CURSOR ? null : index < 0 ? startHour() : step > 0 ? 0 : 23;
  render();
  const shown = visibleLinks().find((link) => cursorId(link) === cursor);
  // Only where the page scrolls (a phone, one column): on a screen it's all in sight, and scrolling
  // it would shift the whole dashboard.
  if (shown && getComputedStyle(document.body).overflow !== "hidden") shown.scrollIntoView({ block: "nearest" });
}

// Panels are drawn again every second: put the cursor back on its link, or drop it if it's gone.
function renderCursor() {
  if (!cursor) return;
  const link = visibleLinks().find((node) => cursorId(node) === cursor);
  if (link) link.classList.add("cursor");
  else {
    cursor = null;
    chartHour = null;
    leaveCalendar();
    renderStatus();
  }
}

// ---------------------------------------------------------------- help

// Every command, with its key: in the help window, where each one can be pressed (on a phone,
// the only way to them).
function helpCommands() {
  const commands = [];
  // icon and short: for the phone's round buttons; touch: a tap on the page does it already.
  // icon and short: for the phone's round buttons; touch: a tap on the page does it already.
  // run: what a click on it does, for the minimised iPod's keys (they aren't the page's).
  const add = (key, text, icon, short, touch = false, run = null) => commands.push({ key, text, icon, short, touch, run });
  const ipodKeys = minimizedIpodKeys();
  if (ipodKeys["-"]) add("-", "iPod: abrirlo", null, null, true, ipodKeys["-"]);
  if (ipodKeys[" "]) add(" ", player.paused ? "iPod: seguir" : "iPod: pausar", null, null, true, ipodKeys[" "]);
  if (ipodKeys.z) add("z", "iPod: canción anterior", null, null, true, ipodKeys.z);
  if (ipodKeys.x) add("x", "iPod: canción siguiente", null, null, true, ipodKeys.x);
  if (ipodKeys.q) add("q", "iPod: cerrarlo y parar la música", null, null, true, ipodKeys.q);
  add("c", "Cambiar de color", "palette", "Color");
  for (const pomodoro of layout.pomodoros) {
    const running = state && state.pomodoro && state.pomodoro.running;
    add(pomodoro.start_key, running ? "Pausar el pomodoro" : "Empezar o seguir el pomodoro",
      running ? "pause" : "timer-play-outline", running ? "Pausar" : "Pomodoro");
    if (state && state.pomodoro && state.pomodoro.active) add(pomodoro.reset_key, "Reiniciar el pomodoro", "timer-refresh-outline", "Reiniciar");
  }
  for (const view of panelViews()) {
    if (view.panel.page_key && !view.panel.key) add(view.panel.page_key, `${view.panel.title}: siguiente página`, "page-next-outline", view.panel.title, true);
  }
  if (layout.history_key) {
    add(layout.history_key, history ? "Volver a los valores de ahora" : "Historial de los últimos 7 días",
      history ? "clock-outline" : "history", history ? "Ahora" : "Historial");
  }
  const weatherKey = chartKey();
  if (weatherKey) {
    add(weatherKey, chartDay ? "Hoy: el tiempo y los eventos" : "Mañana: el tiempo y los eventos",
      chartDay ? "calendar-today" : "calendar-arrow-right", chartDay ? "Hoy" : "Mañana");
  }
  for (const editor of layout.date_editors || []) add(editor.key, "Fechas: añadir, cambiar o borrar", "calendar-edit", "Fechas");
  for (const music of layout.music || []) if (music.key) add(music.key, "El iPod: la música del servidor", "ipod", "iPod");
  if (calendarReading()) {
    add("z", "Calendario: mes anterior", "chevron-left", "Mes antes", true);
    add("x", "Calendario: mes siguiente", "chevron-right", "Mes después", true);
  }
  for (const view of panelViews()) {
    if (view.panel.key) add(view.panel.key, `Abrir ${view.panel.title}`, view.panel.icon || "dock-window", view.panel.title);
  }
  add("v", "Dar por vistas las alertas", "eye-check-outline", "Visto");
  add("r", "Refrescar todos los paneles", "refresh", "Refrescar");
  return commands;
}

function drawHelp() {
  const row = (keyName, text, key, run = null) => el(key ? "button" : "div", {
    class: "row help-row", "data-help-key": key || null,
    onclick: run ? () => { helpOpen = false; run(); render(); } : key ? () => press(key) : null,
  }, el("span", { class: "label" }, upper(keyName)), el("span", { class: "leader" }), el("span", { class: "values" }, upper(text)));
  return el("section", { class: "panel help" },
    el("h2", {}, upper("Ayuda")),
    el("div", { class: "body" },
      // Without the page's keys that the minimised iPod has taken.
      helpCommands().filter((command) => command.run || !minimizedIpodKeys()[command.key])
        .map(({ key, text, run }) => row(KEY_NAMES[key] || key, text, key, run)),
      el("div", { class: "rule" }),
      row("→ ↓  ← ↑", "Cursor: horas del tiempo, servicios y noticias"),
      row("↵", "Abrir o elegir lo que tiene el cursor"),
      row("Q", "Salir: cerrar, quitar el cursor"),
      row("F1", "Esta ayuda")));
}

// ---------------------------------------------------------------- pomodoro panel

// While a pomodoro is under way, in place of its panel (the news): the countdown in big figures, the
// phase and how far into it, and its keys.
function drawPomodoroPanel(view) {
  const { panel } = view;
  const pomodoro = state.pomodoro;
  const seconds = Math.max(0, Math.ceil(pomodoro.left - 0.001));
  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const digits = el("div", { class: `number segments pomodoro-time${pomodoro.running ? "" : " paused"}` });
  setSegments(digits, time);
  const total = (pomodoro.duration || 0) * 60;
  const done = total ? Math.max(0, Math.min(1, 1 - pomodoro.left / total)) : null;
  const bar = done === null ? null : el("div", { class: "row wide pomodoro-progress" },
    el("span", { class: "values" }, el("span", { class: "bar" }, el("i", { style: `width: ${Math.round(done * 100)}%` }))));
  const keys = layout.pomodoros[0];
  const status = pomodoro.running ? "" : upper(pomodoro.status);
  return el("section", { class: `panel pomodoro-panel${pomodoro.notice ? " alert" : ""}`, style: `grid-column: span ${panel.span}; grid-row: span ${panel.rows}` },
    el("h2", {}, upper("Pomodoro")),
    el("div", { class: "body" },
      el("div", { class: "pomodoro-label" }, upper(pomodoro.label)),
      digits,
      bar,
      el("div", { class: "pomodoro-status" }, status || "\u00a0"),
      keys ? el("div", { class: "pomodoro-keys dim" },
        upper(`[${keys.start_key.toUpperCase()}] ${pomodoro.running ? "pausar" : "seguir"} · [${keys.reset_key.toUpperCase()}] reiniciar`)) : null));
}

// ---------------------------------------------------------------- history

// H shows the last 7 days in the panels that have `history`, and H again (or Q) goes back.
function toggleHistory() {
  history = history ? null : { data: null, at: 0 };
  for (const index of Object.keys(weekPages)) delete weekPages[index];
  weekTurned = Date.now();
  render();
  if (history) loadHistory();
}

async function loadHistory() {
  try {
    const response = await fetch("/api/history", { cache: "no-store" });
    const data = await response.json();
    if (history) Object.assign(history, { data, at: Date.now(), failed: false });
  } catch {
    if (history) Object.assign(history, { data: { panels: {}, days: [] }, at: Date.now(), failed: true });
  }
  render();
}

// The "7 days": a row a day, a column a value with that day's max and min (a meter's or the rain's,
// its total). The values go in pages of weekColumns(), never splitting a row's values (a room's
// temperature and humidity stay together); a click on the title turns the page.
function drawWeekPanel(view) {
  const { panel, index } = view;
  if (!history.data || history.failed) {
    const message = history.failed ? "SIN CONEXIÓN CON EL SERVIDOR" : "CARGANDO HISTORIAL";
    return el("section", { class: "panel history", style: `grid-column: span ${panel.span}; grid-row: span ${panel.rows}` },
      el("h2", {}, upper(`${panel.title} · 7 días`)),
      el("div", { class: "body" }, el("div", { class: history.failed ? "error" : "waiting" }, message)));
  }
  const rows = history.data.panels[String(index)] || [];
  const columns = [];
  for (const row of rows) {
    if (row.error || !row.parts) continue;
    const several = row.parts.length > 1;
    columns.push(row.parts.map((part) => ({ label: row.label, unit: part.unit, daily: part.daily, several })));
  }
  const pages = [];
  for (const group of columns) {
    const last = pages[pages.length - 1];
    if (last && last.length + group.length <= weekColumns()) last.push(...group);
    else pages.push([...group]);
  }
  weekPages[index] = weekPages[index] ?? 0;
  const page = pages.length ? weekPages[index] % pages.length : 0;
  const shown = pages[page] || [];
  const turn = () => {
    weekPages[index] = (weekPages[index] || 0) + 1;
    weekTurned = Date.now();
    render();
  };
  const node = el("section", {
    class: "panel history week",
    style: `grid-column: span ${panel.span}; grid-row: span ${panel.rows}`,
  });
  const title = `${panel.title} · 7 días${pages.length > 1 ? ` · ${page + 1}/${pages.length}` : ""}`;
  node.append(el("h2", {}, pages.length > 1 ? el("button", { title: "Siguiente página", onclick: turn }, upper(title)) : upper(title)));
  const body = el("div", { class: "body" });
  const errors = rows.filter((row) => row.error);
  if (!shown.length) body.append(el("div", { class: errors.length ? "error" : "waiting" }, upper(errors.length ? errors[0].error : "SIN DATOS")));
  else {
    // Each column as wide as its figures (a humidity needs less than a temperature), spread out.
    const table = el("div", { class: "week-table", style: `grid-template-columns: repeat(${shown.length + 1}, auto)` });
    table.append(el("span", {}));
    // A row's first value is named after it; the others (a room's humidity), only by their unit.
    shown.forEach((column, at) => {
      const named = !column.several || at === 0 || shown[at - 1].label !== column.label;
      table.append(el("span", { class: "week-head", title: `${column.label} ${column.unit}` },
        upper(named ? column.label : ""), column.unit ? el("span", { class: "unit" }, ` ${column.unit}`) : ""));
    });
    const weekdays = ["do", "lu", "ma", "mi", "ju", "vi", "sá"];
    history.data.days.forEach((iso, day) => {
      const date = fromIso(iso);
      table.append(el("span", { class: `week-day${day === history.data.days.length - 1 ? " today" : ""}` },
        upper(`${weekdays[date.getDay()]} ${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}`)));
      for (const column of shown) {
        const cell = column.daily[day];
        if (!cell) table.append(el("span", { class: "week-cell dim" }, "--"));
        else if (cell.total !== undefined) table.append(el("span", { class: "week-cell" }, el("span", { class: "value" }, cell.total)));
        // With many columns, only max/min; with few, with the arrows.
        else if (shown.length > 3) table.append(el("span", { class: "week-cell" },
          el("span", { class: "value" }, cell.max), el("span", { class: "dim" }, "/"), el("span", { class: "value" }, cell.min)));
        else table.append(el("span", { class: "week-cell" },
          el("span", { class: "dim" }, "▲"), el("span", { class: "value" }, cell.max), " ",
          el("span", { class: "dim" }, "▼"), el("span", { class: "value" }, cell.min)));
      }
    });
    body.append(table);
  }
  node.append(body);
  if (history.at) node.append(el("div", { class: "subtitle" }, new Date(history.at).toTimeString().slice(0, 8)));
  return node;
}

// ---------------------------------------------------------------- date editor

// The page shows dates as DD/MM (every year) or DD/MM/AAAA; the server keeps MM-DD or YYYY-MM-DD.
function showDate(value) {
  const [year, month, day] = value.length === 5 ? [null, ...value.split("-")] : value.split("-");
  return year ? `${day}/${month}/${year}` : `${day}/${month}`;
}

function storedDate(text) {
  const parts = text.trim().split(/[/.-]/);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return text.trim();
  const [day, month, year] = parts;
  const date = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return year ? `${year.length === 2 ? "20" + year : year}-${date}` : date;
}

function describeDate(entry) {
  if (entry.date.length === 5) return `${showDate(entry.date)} · cada año`;
  return `${showDate(entry.date)} · ${entry.yearly ? "cada año, con los años" : "una vez"}`;
}

async function openDates(source) {
  dates = { source, list: [], form: null, error: null, version: 0, focus: null };
  reader = null;
  popup = null;
  try {
    const response = await fetch(`/api/dates/${source}`, { cache: "no-store" });
    const data = await response.json();
    dates.list = data.dates || [];
    dates.error = data.error || null;
  } catch {
    dates.error = "sin conexión con el servidor";
  }
  dates.version += 1;
  render();
}

function closeDates() {
  dates = null;
  render();
}

function redrawDates(focus) {
  dates.focus = focus;
  dates.version += 1;
  render();
}

function openForm(entry) {
  dates.form = entry
    ? { ...entry, date: showDate(entry.date) }
    : { name: "", date: "", soon: 7 };
  dates.error = null;
  redrawDates("#date-name");
}

function backToList() {
  const id = dates.form && dates.form.id;
  dates.form = null;
  dates.error = null;
  redrawDates(id ? `[data-id="${id}"]` : null);
}

// What the form says right now, so a redraw (an error) keeps it.
function readForm() {
  const value = (id) => document.getElementById(id);
  Object.assign(dates.form, {
    name: value("date-name").value,
    date: value("date-date").value,
    soon: value("date-soon").value,
  });
}

async function sendDate(method, path, body) {
  readForm();
  try {
    const response = await fetch(`/api/dates/${dates.source}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    const saved = dates.form.id;
    dates.list = data.dates;
    dates.form = null;
    dates.error = null;
    // Back on the date just saved (a new one is the last); the panel catches up with the next poll.
    const id = method === "DELETE" ? null : saved || (data.dates.at(-1) || {}).id;
    redrawDates(id ? `[data-id="${id}"]` : null);
    poll();
  } catch (error) {
    dates.error = error.message === "Failed to fetch" ? "sin conexión con el servidor" : error.message;
    redrawDates(`#${(document.activeElement && document.activeElement.id) || "date-name"}`);
  }
}

function saveDate() {
  readForm();
  const { id, name, date, soon } = dates.form;
  // Whether it repeats every year is decided by the server, from the date (see clean_date).
  const body = { name, date: storedDate(date), soon: soon === "" ? 7 : Number(soon) };
  return id ? sendDate("PUT", `/${id}`, body) : sendDate("POST", "", body);
}

function deleteDate(button) {
  // A second press confirms.
  if (!button.dataset.sure) {
    button.dataset.sure = "1";
    button.textContent = upper("¿Seguro? Borrar");
    return;
  }
  sendDate("DELETE", `/${dates.form.id}`);
}

function drawDates() {
  const error = dates.error ? el("p", { class: "error" }, upper(`✖ ${dates.error}`)) : null;
  if (!dates.form) {
    const rows = dates.list.map((entry) =>
      el("button", { class: "row", "data-focus": "", "data-id": entry.id, onclick: () => openForm(entry) },
        el("span", { class: "label" }, upper(entry.name)),
        el("span", { class: "leader" }),
        el("span", { class: "values" }, upper(describeDate(entry)))));
    const add = el("button", { class: "row add", "data-focus": "", onclick: () => openForm(null) }, upper("+ Añadir fecha"));
    return el("section", { class: "panel dates-editor" },
      el("h2", {}, upper("Fechas")),
      el("div", { class: "body" }, rows, add, error,
        el("p", { class: "dim" }, upper("↑ ↓ elegir · ↵ cambiar · Q salir"))));
  }
  const form = dates.form;
  const field = (label, input, after) =>
    el("label", { class: "field" }, el("span", { class: "field-label" }, upper(label)), input, after || null);
  const input = (id, value, attrs = {}) =>
    el("input", { id, value: value ?? "", "data-focus": "", autocomplete: "off", ...attrs });
  return el("section", { class: "panel dates-editor" },
    el("h2", {}, upper(form.id ? "Cambiar fecha" : "Nueva fecha")),
    el("div", { class: "body" },
      field("Nombre", input("date-name", form.name, { maxlength: 60 })),
      field("Fecha", input("date-date", form.date, { placeholder: "DD/MM o DD/MM/AAAA", inputmode: "numeric" })),
      field("Avisar", input("date-soon", form.soon, { type: "number", min: 0, max: 365, class: "short" }),
        el("span", { class: "dim" }, upper(" días antes"))),
      error,
      el("p", { class: "dim" }, upper("DD/MM: todos los años. DD/MM/AAAA: si ya pasó (un cumpleaños), cada año y cuántos cumple; si está por venir (un viaje), solo ese día."))),
    el("div", { class: "reader-choices" },
      el("button", { "data-focus": "", onclick: saveDate }, upper("Guardar")),
      form.id ? el("button", { "data-focus": "", onclick: (event) => deleteDate(event.currentTarget) }, upper("Borrar")) : null,
      el("button", { "data-focus": "", onclick: backToList }, upper("Cancelar"))));
}

// Keys while the editor is open. In a text field they type; the shortcuts of the page don't apply.
function datesKey(event) {
  const key = event.key.toLowerCase();
  const target = event.target;
  const typing = target.tagName === "INPUT";
  const focusables = [...document.querySelectorAll("#popup [data-focus]")];
  const index = focusables.indexOf(document.activeElement);
  const move = (step) => {
    event.preventDefault();
    const next = index < 0 ? 0 : Math.max(0, Math.min(focusables.length - 1, index + step));
    if (focusables[next]) focusables[next].focus();
  };
  // Q leaves too, except while typing in a field (where it's a letter); Esc always.
  if (key === "escape" || (key === "q" && !typing)) {
    event.preventDefault();
    return dates.form ? backToList() : closeDates();
  }
  if (key === "arrowdown" || key === "arrowup") return move(key === "arrowdown" ? 1 : -1);
  // Left and right move the caret in a text field, and between the buttons under the form.
  if (!typing && (key === "arrowleft" || key === "arrowright")) return move(key === "arrowright" ? 1 : -1);
  if (key === "enter") {
    if (dates.form && typing) {
      event.preventDefault();
      return saveDate();
    }
    if (index < 0) return move(0);
    // A focused button is pressed by the browser itself.
    return;
  }
  const editor = (layout.date_editors || []).find((editor) => editor.key === key);
  if (editor && !typing && !dates.form) {
    event.preventDefault();
    closeDates();
  }
}

// ---------------------------------------------------------------- sound

// Browsers only allow sound after the first key or click on the page.
function unlockAudio() {
  if (!audio) {
    try {
      audio = new AudioContext();
    } catch {
      return;
    }
  }
  if (audio.state === "suspended") audio.resume().then(renderStatus);
  renderStatus();
}

function beep(frequency, duration, delay = 0) {
  if (!audio || audio.state !== "running") return;
  const start = audio.currentTime + delay;
  for (const [ratio, level] of [[1, 0.35], [2.76, 0.12]]) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency * ratio;
    gain.gain.setValueAtTime(level, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration);
  }
}

// A pomodoro phase is over: three glassy chimes, and the notice flashes for a minute or until a key.
function chime() {
  for (let i = 0; i < 3; i++) {
    beep(1318, 0.9, i * 1.1);
    beep(1760, 0.7, i * 1.1 + 0.12);
  }
  noticeFlashUntil = Date.now() + NOTICE_FLASH_MS;
}

// ---------------------------------------------------------------- boot

async function boot(lines) {
  // Once per browser session: a reload doesn't replay it.
  try {
    if (sessionStorage.getItem("marianne.booted")) return;
    sessionStorage.setItem("marianne.booted", "1");
  } catch {
    /* no storage: show it */
  }
  const screen = document.getElementById("boot");
  const log = document.getElementById("boot-log");
  screen.hidden = false;
  // Its lines are a terminal's 66 columns: on a narrow screen (a phone) the font shrinks to fit them,
  // measured with VT323 itself, once it has loaded (a fallback font is wider).
  try {
    await Promise.race([document.fonts.load('1em "VT323"'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  } catch {
    /* without the font, measure with whatever there is */
  }
  log.style.fontSize = "";
  log.textContent = lines.join("\n");
  const room = log.clientWidth;
  if (log.scrollWidth > room) {
    log.style.fontSize = `${(parseFloat(getComputedStyle(log).fontSize) * room) / log.scrollWidth}px`;
  }
  log.textContent = "";
  return new Promise((resolve) => {
    let shown = 0;
    const finish = () => {
      clearInterval(timer);
      screen.hidden = true;
      removeEventListener("keydown", finish);
      screen.removeEventListener("click", finish);
      resolve();
    };
    const timer = setInterval(() => {
      shown += 1;
      log.textContent = lines.slice(0, shown).join("\n") + (shown <= lines.length ? "\n█" : "");
      if (shown > lines.length + 3) finish();
    }, 120);
    addEventListener("keydown", finish);
    screen.addEventListener("click", finish);
  });
}

// ---------------------------------------------------------------- iPod

// An iPod classic for the music folder of a `music` source: its menus on the screen, the click
// wheel (turned with a finger or the mouse, its four buttons and the centre one), or the keys.
// The songs play in this browser; the server only sends the files, by their ids.
const IPOD_ROWS = 7; // rows of a menu on the screen
const WHEEL_STEP = 15; // degrees of the wheel for each row
const ipod = {
  open: false,
  source: null,
  library: null, // { albums, tracks, artists, byId }
  error: null,
  stack: [], // the menus gone into, the last one on the screen
  queue: [], // the songs to play, by id
  at: -1, // the one playing, in the queue
  volumeUntil: 0, // the volume bar shows for a moment after the wheel turns it
};
const player = new Audio();
player.preload = "auto";

// Something to play, with the iPod minimised.
const ipodPlaying = () => !ipod.open && ipod.at >= 0;

// Its keys then, before the page's, while the music plays. Paused, the page's win: only Space and
// -, which the page doesn't use, are left to the iPod, to go on and to open it.
function minimizedIpodKeys() {
  if (!ipodPlaying()) return {};
  return player.paused ? { " ": IPOD_MINIMIZED[" "], "-": IPOD_MINIMIZED["-"] } : IPOD_MINIMIZED;
}

const IPOD_MINIMIZED = {
  "-": () => openIpod(ipod.source),
  " ": () => playPause(),
  z: () => previous(),
  x: () => next(),
  pageup: () => previous(),
  pagedown: () => next(),
  q: () => closeIpod(),
  escape: () => closeIpod(),
};

async function openIpod(name) {
  ipod.open = true;
  popup = null;
  cursor = null;
  fabOpen = false;
  if (ipod.source !== name) {
    ipod.source = name;
    ipod.library = null;
    ipod.stack = [];
  }
  render();
  drawIpod();
  if (!ipod.library) await loadLibrary();
}

// Minimised, the music goes on (the status bar says what's playing, and opens it again).
function minimizeIpod() {
  ipod.open = false;
  drawIpod();
  render();
}

// Closed for good: the music stops and nothing is left in the status bar.
function closeIpod() {
  player.pause();
  player.removeAttribute("src");
  player.load();
  ipod.queue = [];
  ipod.at = -1;
  ipod.error = null;
  // Back to the first menu for the next time.
  ipod.stack = ipod.stack.slice(0, 1);
  ipod.rating = null;
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  minimizeIpod();
}

async function loadLibrary() {
  ipod.error = null;
  try {
    const response = await fetch(`/api/music/${ipod.source}/library`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    ipod.library = readLibrary(data);
    if (!ipod.stack.length) ipod.stack = [rootMenu()];
  } catch (error) {
    ipod.error = String(error.message || error);
  }
  drawIpod();
}

// The server's short lists as albums, songs and artists that point to each other.
function readLibrary(data) {
  const albums = data.albums.map(([id, title, artist, year]) => ({ id, title, artist, year, tracks: [] }));
  const ratings = data.ratings || {};
  const tracks = data.tracks.map(([id, title, artist, album, number, length]) => {
    const track = { id, title, artist, album: albums[album], number, length, stars: ratings[id] || 0 };
    albums[album].tracks.push(track);
    return track;
  });
  const artists = new Map();
  for (const album of albums) {
    if (!artists.has(album.artist)) artists.set(album.artist, { name: album.artist, albums: [] });
    artists.get(album.artist).albums.push(album);
  }
  const byTitle = (a, b) => a.title.localeCompare(b.title, "es", { sensitivity: "base" });
  return {
    albums: [...albums].sort(byTitle),
    tracks: [...tracks].sort(byTitle),
    artists: [...artists.values()].sort((a, b) => sortName(a.name).localeCompare(sortName(b.name), "es")),
    byId: new Map(tracks.map((track) => [track.id, track])),
    // Stars can be given (the source has a `ratings` file).
    rated: Boolean(data.ratings),
  };
}

// "The Beatles" under B, as on an iPod (and as the server sorts them).
const sortName = (name) => name.toLowerCase().replace(/^(the|los|las|el|la) /, "");

// A menu: a title and its rows, each a name and what choosing it does (another menu, or play).
function menu(title, rows) {
  return { title, rows, index: 0, top: 0 };
}

function rootMenu() {
  const { library } = ipod;
  return menu("iPod", [
    { name: "Artistas", go: () => menu("Artistas", library.artists.map((artist) => ({ name: artist.name, go: () => artistMenu(artist) }))) },
    { name: "Álbumes", go: () => menu("Álbumes", library.albums.map((album) => ({ name: album.title, go: () => albumMenu(album) }))) },
    { name: "Canciones", go: () => songsMenu("Canciones", library.tracks) },
    { name: "Favoritas", go: favoritesMenu, when: () => library.rated },
    { name: "Aleatorio", play: () => playQueue(shuffled(library.tracks.map((track) => track.id)), 0) },
    { name: "Reproduciendo", go: () => nowPlaying(), when: () => ipod.at >= 0 },
  ]);
}

function artistMenu(artist) {
  const all = artist.albums.flatMap((album) => album.tracks);
  return menu(artist.name, [
    { name: "Todas", go: () => songsMenu(artist.name, all) },
    ...artist.albums.map((album) => ({ name: album.title, go: () => albumMenu(album) })),
  ]);
}

const albumMenu = (album) => songsMenu(album.title, album.tracks);

// The songs with 4 or 5 stars: the 5 first. All of them in order or shuffled, or one to start.
const FAVORITE_STARS = 4;

function favoritesMenu() {
  const favorites = ipod.library.tracks.filter((track) => track.stars >= FAVORITE_STARS)
    .sort((a, b) => b.stars - a.stars);
  const ids = favorites.map((track) => track.id);
  if (!favorites.length) return menu("Favoritas", [{ name: "Sin favoritas: dales 4 o 5 estrellas", play: () => {} }]);
  return menu("Favoritas", [
    { name: "Aleatorio", play: () => playQueue(shuffled([...ids]), 0) },
    ...favorites.map((track, index) => ({ name: `${"★".repeat(track.stars)} ${track.title}`, play: () => playQueue(ids, index) })),
  ]);
}

function songsMenu(title, tracks) {
  const ids = tracks.map((track) => track.id);
  return menu(title, tracks.map((track, index) => ({ name: track.title, play: () => playQueue(ids, index) })));
}

const nowPlaying = () => ({ title: "Reproduciendo", playing: true });

function shuffled(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// The rows of a menu that can be chosen now ("Reproduciendo" only once something has played).
const menuRows = (screen) => screen.rows.filter((row) => !row.when || row.when());

// ---- playing

function playQueue(ids, index) {
  ipod.queue = ids;
  playAt(index);
  const screen = ipod.stack[ipod.stack.length - 1];
  if (!screen.playing) ipod.stack.push(nowPlaying());
  drawIpod();
}

function playAt(index) {
  if (index < 0 || index >= ipod.queue.length) {
    player.pause();
    return drawIpod();
  }
  ipod.at = index;
  // The stars being given were for the song before.
  ipod.rating = null;
  const track = currentTrack();
  player.src = `/api/music/${ipod.source}/track/${track.id}`;
  player.play().catch(() => {});
  if ("mediaSession" in navigator) {
    // On a phone's lock screen and the computer's media keys.
    // With the album's picture: on the lock screen and the system's media controls, not on the iPod.
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album.title,
      artwork: [{ src: new URL(coverUrl(track.album), location.href).href }],
    });
  }
  drawIpod();
  renderStatus();
}

const coverUrl = (album) => `/api/music/${ipod.source}/cover/${album.id}`;
const currentTrack = () => (ipod.library && ipod.at >= 0 ? ipod.library.byId.get(ipod.queue[ipod.at]) : null);

function playPause() {
  if (ipod.at < 0) return;
  if (player.paused) player.play().catch(() => {});
  else player.pause();
}

// ⏮ (or Z) goes back to the start of the song; to the one before if it's in its first seconds,
// or if pressed twice in a row quickly.
const RESTART_SECONDS = 5;
const DOUBLE_PRESS_MS = 600;
let lastPrevious = 0;

function previous() {
  if (ipod.at < 0) return;
  const twice = Date.now() - lastPrevious < DOUBLE_PRESS_MS;
  lastPrevious = Date.now();
  if (player.currentTime >= RESTART_SECONDS && !twice) player.currentTime = 0;
  else playAt(Math.max(0, ipod.at - 1));
}

const next = () => ipod.at >= 0 && playAt(ipod.at + 1);

player.addEventListener("ended", next);
player.addEventListener("play", () => { drawIpod(); renderStatus(); });
player.addEventListener("pause", () => { drawIpod(); renderStatus(); });
player.addEventListener("timeupdate", drawProgress);
player.addEventListener("error", () => {
  // A file the browser can't play (a format it doesn't know): on to the next one.
  if (ipod.at < 0 || !player.getAttribute("src")) return;
  ipod.error = "No se puede reproducir esta canción";
  drawIpod();
  setTimeout(() => { ipod.error = null; next(); }, 1500);
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", playPause);
  navigator.mediaSession.setActionHandler("pause", playPause);
  navigator.mediaSession.setActionHandler("previoustrack", previous);
  navigator.mediaSession.setActionHandler("nexttrack", next);
}

// ---- the stars

// As on the iPod: on the song playing, the centre button turns the wheel into the stars (instead
// of the volume) for a moment; 0 to 5 on the keyboard give them at once. Saved on the server, so
// every device has them.
const RATING_MS = 3000;
let ratingTimer = 0;

function startRating() {
  const track = currentTrack();
  if (!track) return;
  ipod.rating = track.id;
  keepRating();
  drawIpod();
}

function keepRating() {
  clearTimeout(ratingTimer);
  ratingTimer = setTimeout(() => { ipod.rating = null; drawIpod(); }, RATING_MS);
}

function stopRating() {
  clearTimeout(ratingTimer);
  ipod.rating = null;
  drawIpod();
}

async function rateTrack(track, stars) {
  const before = track.stars;
  track.stars = Math.max(0, Math.min(5, stars));
  drawIpod();
  try {
    const response = await fetch(`/api/music/${ipod.source}/rating/${track.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stars: track.stars }),
    });
    if (!response.ok) throw new Error();
  } catch {
    track.stars = before;
    ipod.error = "No se han podido guardar las estrellas";
    setTimeout(() => { ipod.error = null; drawIpod(); }, 2000);
    drawIpod();
  }
}

function drawStars(track) {
  const editing = ipod.rating === track.id;
  return el("div", { class: `ipod-stars${editing ? " editing" : ""}` },
    "★".repeat(track.stars) + "☆".repeat(5 - track.stars));
}

// ---- the controls

// The click of the wheel: a few milliseconds of noise that dies away at once, like the iPod's
// little speaker. Made once; each click plays it again (quietly, and only from the iPod itself).
let clickBuffer = null;

function ipodClick() {
  unlockAudio();
  if (!audio || audio.state !== "running") return;
  if (!clickBuffer) {
    const length = Math.floor(audio.sampleRate * 0.004);
    clickBuffer = audio.createBuffer(1, length, audio.sampleRate);
    const data = clickBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = 0.35;
  source.buffer = clickBuffer;
  source.connect(gain).connect(audio.destination);
  source.start();
}

// One row up or down (the wheel turned, or the arrows); on the song playing, the volume. It clicks
// on each step, but not against the end of a list (as on the iPod).
function scrollIpod(step) {
  const screen = ipod.stack[ipod.stack.length - 1];
  if (!screen) return;
  if (screen.playing && ipod.rating) {
    const track = currentTrack();
    const stars = Math.max(0, Math.min(5, track.stars + step));
    keepRating();
    if (stars !== track.stars) {
      ipodClick();
      rateTrack(track, stars);
    }
    return;
  }
  if (screen.playing) {
    const volume = Math.max(0, Math.min(1, Math.round((player.volume + step * 0.05) * 100) / 100));
    if (volume !== player.volume) ipodClick();
    player.volume = volume;
    ipod.volumeUntil = Date.now() + 1500;
    setTimeout(drawIpod, 1550);
    return drawIpod();
  }
  const rows = menuRows(screen);
  const before = screen.index;
  screen.index = Math.max(0, Math.min(rows.length - 1, screen.index + step));
  if (screen.index !== before) ipodClick();
  if (screen.index < screen.top) screen.top = screen.index;
  if (screen.index >= screen.top + IPOD_ROWS) screen.top = screen.index - IPOD_ROWS + 1;
  drawIpod();
}

function chooseIpod() {
  const screen = ipod.stack[ipod.stack.length - 1];
  // On the song playing: the stars (with ratings), or else play and pause.
  if (screen && screen.playing && ipod.library && ipod.library.rated && currentTrack()) return ipod.rating ? stopRating() : startRating();
  if (!screen || screen.playing) return playPause();
  const row = menuRows(screen)[screen.index];
  if (!row) return;
  if (row.play) return row.play();
  ipod.stack.push(row.go());
  drawIpod();
}

// MENU: back to the menu before.
function menuIpod() {
  if (ipod.stack.length > 1) ipod.stack.pop();
  drawIpod();
}

function ipodKey(event) {
  const key = event.key.toLowerCase();
  const actions = {
    arrowup: () => scrollIpod(-1), arrowdown: () => scrollIpod(1),
    arrowright: chooseIpod, enter: chooseIpod,
    arrowleft: menuIpod, backspace: menuIpod,
    " ": playPause, z: previous, x: next, pageup: previous, pagedown: next,
    q: closeIpod, escape: closeIpod, "-": minimizeIpod, f1: minimizeIpod, v: toggleViz,
  };
  // Its own key minimises it too.
  const own = (layout.music || []).find((music) => music.name === ipod.source);
  if (own && own.key === key) actions[key] = minimizeIpod;
  // 0 to 5: the stars of the song playing.
  const track = currentTrack();
  if (/^[0-5]$/.test(key) && track && ipod.library.rated) {
    actions[key] = () => {
      rateTrack(track, Number(key));
      ipod.rating = track.id;
      keepRating();
    };
  }
  if (!actions[key]) return;
  event.preventDefault();
  unlockAudio();
  // The keys that stand for the wheel's buttons click like them (the arrows click as they scroll).
  if ([" ", "z", "x", "pageup", "pagedown", "arrowright", "enter", "arrowleft", "backspace"].includes(key)) ipodClick();
  actions[key]();
}

// The wheel: turned (in steps of WHEEL_STEP degrees, clockwise down), or tapped on one of its four
// buttons: MENU at the top, ⏭ on the right, ⏯ at the bottom, ⏮ on the left.
function wheelEvents(wheel) {
  let last = null;
  let turned = 0;
  let moved = 0;
  const angle = (event) => {
    const box = wheel.getBoundingClientRect();
    return (Math.atan2(event.clientY - box.top - box.height / 2, event.clientX - box.left - box.width / 2) * 180) / Math.PI;
  };
  wheel.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".ipod-center")) return;
    wheel.setPointerCapture(event.pointerId);
    last = angle(event);
    turned = 0;
    moved = 0;
  });
  wheel.addEventListener("pointermove", (event) => {
    if (last === null) return;
    const now = angle(event);
    let delta = now - last;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    last = now;
    turned += delta;
    moved += Math.abs(delta);
    while (Math.abs(turned) >= WHEEL_STEP) {
      scrollIpod(turned > 0 ? 1 : -1);
      turned -= Math.sign(turned) * WHEEL_STEP;
    }
  });
  wheel.addEventListener("pointerup", (event) => {
    if (last === null) return;
    last = null;
    if (moved > 8) return;
    // A tap: which of the four buttons, by where on the ring.
    const at = angle(event);
    ipodClick();
    if (at > -135 && at < -45) menuIpod();
    else if (at >= -45 && at <= 45) next();
    else if (at > 45 && at < 135) playPause();
    else previous();
  });
  wheel.addEventListener("pointercancel", () => { last = null; });
}

// ---- the visualiser

// A psychedelic animation on the iPod's screen, like Winamp's (MilkDrop): each frame is the one
// before, a little bigger and turned, fading, with the music drawn on top as a ring that the bass
// swells, rays from the spectrum and a flash on each beat. Small and blown up without smoothing,
// in the theme's colours. On a computer it follows the music (Web Audio); on a phone it only
// pretends to, because a song run through Web Audio stops on the iPhone with the screen locked.
const VIZ_WIDTH = 120;
const VIZ_HEIGHT = 72;
const viz = { canvas: null, frame: 0, analyser: undefined, bass: 0, flash: 0, t: 0 };

function toggleViz() {
  ipod.viz = !ipod.viz;
  const screen = ipod.stack[ipod.stack.length - 1];
  // It goes on the song playing: from a menu, to that screen.
  if (ipod.viz && currentTrack() && screen && !screen.playing) ipod.stack.push(nowPlaying());
  drawIpod();
}

function vizAnalyser() {
  if (viz.analyser !== undefined) return viz.analyser;
  viz.analyser = null;
  if (matchMedia("(pointer: coarse)").matches) return null;
  unlockAudio();
  if (!audio) return null;
  try {
    const source = audio.createMediaElementSource(player);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(audio.destination);
    viz.analyser = analyser;
  } catch {
    /* without it, the pretend one */
  }
  return viz.analyser;
}

function vizCanvas() {
  if (!viz.canvas) {
    viz.canvas = el("canvas", { class: "ipod-viz", width: VIZ_WIDTH, height: VIZ_HEIGHT });
    viz.canvas.addEventListener("click", toggleViz);
  }
  if (!viz.frame) viz.frame = requestAnimationFrame(drawViz);
  return viz.canvas;
}

function drawViz() {
  viz.frame = 0;
  const canvas = viz.canvas;
  if (!ipod.open || !ipod.viz || !canvas.isConnected) return;
  viz.frame = requestAnimationFrame(drawViz);
  const context = canvas.getContext("2d");
  // Hard pixels in the trails too, not a blur.
  context.imageSmoothingEnabled = false;
  const style = getComputedStyle(document.documentElement);
  const color = (name) => style.getPropertyValue(name).trim();
  const [w, h] = [VIZ_WIDTH, VIZ_HEIGHT];
  const playing = !player.paused;
  viz.t += 1 / 60;

  // The music now: the spectrum (0..1 each) and the wave (-1..1 each).
  const bins = 48;
  let spectrum, wave;
  const analyser = vizAnalyser();
  if (analyser) {
    const bytes = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bytes);
    spectrum = Array.from({ length: bins }, (_, i) => bytes[Math.floor((i / bins) ** 1.6 * bytes.length * 0.8)] / 255);
    analyser.getByteTimeDomainData(bytes);
    wave = Array.from({ length: 64 }, (_, i) => (bytes[Math.floor((i / 64) * bytes.length)] - 128) / 128);
  } else {
    // Pretended: a beat at about 120 per minute and something that moves over it.
    const beat = playing ? Math.max(0, Math.sin(viz.t * Math.PI * 2)) ** 6 : 0;
    spectrum = Array.from({ length: bins }, (_, i) => (playing ? 0.15 + 0.5 * beat * (1 - i / bins) + 0.25 * Math.random() * (1 - i / bins) : 0));
    wave = Array.from({ length: 64 }, (_, i) => (playing ? Math.sin(i * 0.6 + viz.t * 9) * (0.2 + beat * 0.5) : 0));
  }
  const bass = spectrum.slice(0, 6).reduce((sum, value) => sum + value, 0) / 6;
  if (bass - viz.bass > 0.12) viz.flash = 1;
  viz.bass = viz.bass * 0.8 + bass * 0.2;

  // The frame before, bigger and turned, a little faded: the trails.
  context.save();
  context.globalAlpha = 0.9;
  context.translate(w / 2, h / 2);
  context.rotate(0.02 * Math.sin(viz.t * 0.7) + viz.bass * 0.03);
  const zoom = 1.03 + viz.bass * 0.06;
  context.scale(zoom, zoom);
  context.drawImage(canvas, -w / 2, -h / 2);
  context.restore();
  context.fillStyle = color("--background");
  context.globalAlpha = 0.12;
  context.fillRect(0, 0, w, h);
  context.globalAlpha = 1;

  // Rays from the spectrum, all round the middle, slowly turning.
  context.strokeStyle = color("--accent");
  context.lineWidth = 1;
  spectrum.forEach((value, i) => {
    if (value < 0.2) return;
    const angle = (i / bins) * Math.PI * 2 + viz.t * 0.4;
    const r = 10 + value * 26;
    context.beginPath();
    context.moveTo(w / 2 + Math.cos(angle) * 8, h / 2 + Math.sin(angle) * 8);
    context.lineTo(w / 2 + Math.cos(angle) * r * 1.5, h / 2 + Math.sin(angle) * r);
    context.stroke();
  });

  // The wave as a ring the bass swells.
  context.strokeStyle = color("--primary");
  context.lineWidth = 1.5;
  context.beginPath();
  wave.forEach((value, i) => {
    const angle = (i / wave.length) * Math.PI * 2 - viz.t;
    const r = 9 + viz.bass * 18 + value * 10;
    const x = w / 2 + Math.cos(angle) * r * 1.5;
    const y = h / 2 + Math.sin(angle) * r;
    if (i) context.lineTo(x, y);
    else context.moveTo(x, y);
  });
  context.closePath();
  context.stroke();

  // A flash on each beat.
  if (viz.flash > 0.05) {
    context.globalAlpha = viz.flash * 0.35;
    context.fillStyle = color("--primary");
    context.fillRect(0, 0, w, h);
    context.globalAlpha = 1;
    viz.flash *= 0.6;
  }
}

// ---- drawing

// The iPod is drawn once and then only its screen changes (the state arriving every second
// doesn't touch it, so the wheel never loses a turn).
function drawIpod() {
  const box = document.getElementById("ipod");
  box.hidden = !ipod.open;
  // The phone's round button stays out of its way.
  document.body.classList.toggle("ipod-open", ipod.open);
  if (!ipod.open) return;
  if (!box.firstChild) {
    const wheel = el("div", { class: "ipod-wheel" },
      el("span", { class: "ipod-label top" }, "MENU"),
      el("span", { class: "ipod-label right" }, "▶▶|"),
      el("span", { class: "ipod-label bottom" }, "▶ ❚❚"),
      el("span", { class: "ipod-label left" }, "|◀◀"),
      el("button", { class: "ipod-center", "aria-label": "Elegir", onclick: () => { ipodClick(); chooseIpod(); } }));
    wheelEvents(wheel);
    // Its two keys, also to tap (a phone has no keyboard).
    const keys = el("div", { class: "ipod-keys" },
      el("button", { onclick: () => { unlockAudio(); toggleViz(); } }, "[V]VISUALIZADOR"),
      el("button", { onclick: minimizeIpod }, "[-]MINIMIZAR"),
      el("button", { onclick: closeIpod }, "[Q]CERRAR"));
    box.append(el("div", { class: "ipod-frame" }, keys, el("div", { class: "ipod-body" }, el("div", { class: "ipod-screen" }), wheel)));
  }
  box.querySelector(".ipod-screen").replaceChildren(...drawIpodScreen());
  drawProgress();
}

function drawIpodScreen() {
  const screen = ipod.stack[ipod.stack.length - 1];
  const header = (title) => el("div", { class: "ipod-header" },
    el("span", { class: "ipod-state" }, ipod.at < 0 ? "" : player.paused ? "❚❚" : "▶"),
    el("span", { class: "ipod-title" }, upper(title)),
    el("span", { class: "ipod-battery" }));
  if (ipod.error && !screen) return [header("iPod"), el("div", { class: "ipod-message" }, upper(ipod.error))];
  if (!ipod.library || !screen) return [header("iPod"), el("div", { class: "ipod-message waiting" }, upper("Leyendo la música"))];
  if (screen.playing && ipod.viz && currentTrack()) return [header(screen.title), vizCanvas(), drawVizProgress()];
  if (screen.playing) return [header(screen.title), drawNowPlaying()];
  const rows = menuRows(screen);
  const shown = rows.slice(screen.top, screen.top + IPOD_ROWS);
  const list = el("div", { class: "ipod-menu" }, shown.map((row, index) =>
    el("div", { class: `ipod-row${screen.top + index === screen.index ? " selected" : ""}` },
      el("span", { class: "ipod-name" }, upper(row.name)), row.go ? el("span", { class: "ipod-arrow" }, "›") : "")));
  // Where in a long list: a thin bar on the right.
  const bar = rows.length > IPOD_ROWS ? el("div", { class: "ipod-scroll" }, el("i", {
    style: `top: ${(screen.top / rows.length) * 100}%; height: ${(IPOD_ROWS / rows.length) * 100}%`,
  })) : "";
  if (!rows.length) list.append(el("div", { class: "ipod-message" }, upper("Vacío")));
  return [header(screen.title), el("div", { class: "ipod-list" }, list, bar)];
}

function drawNowPlaying() {
  const track = currentTrack();
  if (!track) return el("div", { class: "ipod-message" }, upper("Nada sonando"));
  const volume = Date.now() < ipod.volumeUntil;
  return el("div", { class: "ipod-playing" },
    el("div", { class: "ipod-count" }, upper(`${ipod.at + 1} de ${ipod.queue.length}`)),
    el("div", { class: "ipod-song" },
      el("div", { class: "ipod-tags" },
        el("div", { class: "ipod-song-title" }, upper(track.title)),
        el("div", {}, upper(track.artist)),
        el("div", { class: "dim" }, upper(track.album.title)),
        ipod.library.rated ? drawStars(track) : "")),
    ipod.error ? el("div", { class: "ipod-message" }, upper(ipod.error)) : "",
    volume
      ? el("div", { class: "ipod-progress volume" }, volumeIcon("volume-low"),
        el("span", { class: "ipod-bar" }, el("i", { style: `width: ${player.volume * 100}%` })), volumeIcon("volume-high"))
      : el("div", { class: "ipod-progress" },
        el("span", { class: "ipod-elapsed" }), el("span", { class: "ipod-bar" }, el("i", { class: "ipod-done" })), el("span", { class: "ipod-left" })));
}

// A speaker drawn like the icons: the SVG as a mask over scanlines, in the theme colour.
const volumeIcon = (name) => el("span", { class: "ipod-icon", style: `--icon: url("/api/icon/mdi/${name}")` });

// Under the visualiser, only the bar and the times.
function drawVizProgress() {
  return el("div", { class: "ipod-progress" },
    el("span", { class: "ipod-elapsed" }), el("span", { class: "ipod-bar" }, el("i", { class: "ipod-done" })), el("span", { class: "ipod-left" }));
}

// Only the bar and the times, several times a second while it plays.
function drawProgress() {
  const box = document.getElementById("ipod");
  if (!ipod.open || box.hidden) return;
  const track = currentTrack();
  const done = box.querySelector(".ipod-done");
  if (!track || !done) return;
  const length = player.duration || track.length || 0;
  const time = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  done.style.width = `${length ? (player.currentTime / length) * 100 : 0}%`;
  box.querySelector(".ipod-elapsed").textContent = time(player.currentTime);
  box.querySelector(".ipod-left").textContent = `-${time(Math.max(0, length - player.currentTime))}`;
}

// A tap outside the iPod minimises it (the music goes on).
document.getElementById("ipod").addEventListener("click", (event) => {
  if (event.target.id === "ipod") minimizeIpod();
});

addEventListener("keydown", onKey);
document.getElementById("fab").addEventListener("click", (event) => {
  if (event.target.closest("[data-fab]")) return toggleFab();
  const button = event.target.closest("button[data-key]");
  if (!button) return toggleFab(false);
  fabOpen = false;
  press(button.dataset.key);
  render();
});
document.getElementById("status").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (button) press(button.dataset.key);
});
// A click outside the pop-up panel closes it.
document.getElementById("popup").addEventListener("click", (event) => {
  if (event.target.id !== "popup") return;
  if (helpOpen) {
    helpOpen = false;
    render();
  } else if (dates) {
    if (!dates.form) closeDates();
  } else if (reader) closeReader();
  else togglePopup(popup);
});
addEventListener("pointerdown", unlockAudio);
// A tap (or click) anywhere but the weather chart lets go of the hour picked on it, and the
// chart says what it's like now again; with the cursor on the chart, that goes too.
addEventListener("pointerdown", (event) => {
  if (chartHour === null || event.target.closest(".chart-box")) return;
  chartHour = null;
  if (cursor === CHART_CURSOR) cursor = null;
  render();
});
start();

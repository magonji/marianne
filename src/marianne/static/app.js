// Marianne: draws the readings that server.py collects, as a retro terminal screen.
"use strict";

const THEMES = ["amber", "c64", "phosphor"];
const DAYS = ["DOMINGO", "LUNES", "MARTES", "MIÉRCOLES", "JUEVES", "VIERNES", "SÁBADO"];
const MONTHS = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
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
const weekColumns = () => (matchMedia("(max-width: 760px)").matches ? 3 : 6);
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
    return { panel, index, page, data, title: panel.pages[page] };
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
  renderCursor();
}

function tickClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const colon = now.getSeconds() % 2 === 0 ? ":" : " ";
  setSegments(document.getElementById("clock-digits"), `${pad(now.getHours())}${colon}${pad(now.getMinutes())}`);
  document.getElementById("clock-date").textContent =
    `${DAYS[now.getDay()]} ${pad(now.getDate())} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

function renderPomodoro() {
  const box = document.getElementById("pomodoro");
  const pomodoro = state.pomodoro;
  box.hidden = !(pomodoro && pomodoro.active);
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
  box.hidden = popup === null && !reader && !dates;
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
  const { panel, data, title, index } = view;
  const alerting = data.readings.some((reading) => parts(reading).some((part) => part.alert));
  const stale = Boolean(data.error);
  const node = el("section", {
    class: `panel${alerting && !stale ? " alert" : ""}${stale ? " stale" : ""}`,
    style: `grid-column: span ${panel.span}; grid-row: span ${panel.rows}`,
  });
  const heading = panel.page_key
    ? el("button", { title: `Siguiente página [${panel.page_key.toUpperCase()}]`, onclick: () => nextPage(index) }, upper(title))
    : upper(title);
  node.append(el("h2", {}, heading));
  const body = el("div", { class: "body" });

  // A calendar goes in a column of its own, to the left of the rows.
  const calendar = data.readings.find((reading) => reading.calendar);
  const shown = data.readings.filter((reading) => !reading.hidden && !reading.calendar);
  if (!shown.length && !calendar) {
    body.append(el("div", { class: "waiting" }, "ESPERANDO DATOS"));
  } else {
    let rows = shown;
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
    const valueWidth = Math.max(0, ...wide.map(valueLength));
    for (const reading of rows) {
      if (reading.sun) {
        if (reading === firstSun) body.append(drawSun(sun));
        continue;
      }
      if (reading.chart) {
        body.append(drawChart(reading.chart), el("div", { class: "rule" }));
        continue;
      }
      body.append(drawRow(panel, reading, { labelWidth, valueWidth }));
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

function valueLength(reading) {
  return reading.value.length + (reading.unit ? reading.unit.length + 1 : 0) + (reading.note ? reading.note.length + 1 : 0);
}

function styleClass(reading) {
  if (reading.alert) return "alert-text";
  if (reading.error) return "error";
  if (reading.switch === true) return "on";
  if (reading.switch === false) return "off";
  return "value";
}

function drawRow(panel, reading, widths) {
  const alerting = parts(reading).some((part) => part.alert);
  const wide = reading.wide_bar && reading.fraction !== null;
  const label = el("span", {
    class: `label${alerting ? " alert-text" : reading.switch !== null ? " " + styleClass(reading) : ""}`,
    style: wide ? `width: ${widths.labelWidth}ch; flex: none` : null,
  }, reading.link ? drawLink(panel, reading) : labelText(reading));
  const values = el("span", { class: "values" }, drawValue(panel, reading, wide ? widths.valueWidth : 0));
  for (const extra of reading.extra || []) values.append("  ", drawValue(panel, extra, 0));
  return el("div", { class: `row${wide ? " wide" : ""}${reading.link ? " linked" : ""}` }, label, wide ? null : el("span", { class: "leader" }), values);
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

function drawValue(panel, reading, valueWidth) {
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
  if (reading.note) text.append(` ${reading.note}`);
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
      reading.note ? el("span", { class: reading.error ? "error" : null }, `  ${reading.note}`) : ""));
}

// A month like the terminal's `cal`: today in reverse video, the special dates highlighted (their
// names in the tooltip) and the weekend dimmer.
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

// A month like the terminal's `cal`: today in reverse video, the special dates highlighted (their
// names in the tooltip) and the weekend dimmer. ‹ › go to another month.
function drawCalendar(calendar) {
  const view = calendarView || { year: calendar.year, month: calendar.month };
  const first = new Date(view.year, view.month - 1, 1);
  const length = new Date(view.year, view.month, 0).getDate();
  const firstWeekday = (first.getDay() + 6) % 7;
  const today = `${calendar.year}-${pad2(calendar.month)}-${pad2(calendar.today)}`;
  const events = calendar.events || [];
  const cells = [];
  // The usual Spanish initials: X for miércoles, so it isn't confused with martes.
  for (const day of ["l", "m", "x", "j", "v", "s", "d"]) cells.push(el("span", { class: "weekday" }, upper(day)));
  for (let blank = 0; blank < firstWeekday; blank += 1) cells.push(el("span", {}));
  const dayCell = (day) => {
    const iso = `${view.year}-${pad2(view.month)}-${pad2(day)}`;
    const marked = eventsOn(events, view.year, view.month, day);
    const classes = ["day", (firstWeekday + day - 1) % 7 >= 5 ? "weekend" : "", marked.length ? "marked" : "",
      iso === today ? "today" : "", iso === calendarDay ? "selected" : ""].filter(Boolean);
    return el("span", {
      class: classes.join(" "), title: marked.length ? marked.join(", ") : null,
      onclick: () => pickCalendarDay(iso),
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
  const windTop = Math.round(Math.max(30, ...points.map((point) => point.wind)) * 1.1);
  const yWind = (value) => bottom - (value / windTop) * height;
  const rainTop = Math.max(chart.heavy_rain * 2, ...day.bars.map((bar) => bar.rain));
  const yClouds = (value) => bottom - (value / 100) * height;

  for (let hour = 3; hour < 24; hour += 3) {
    const at = x(day.start + hour * 3600);
    draw("line", { class: "tick", x1: at, y1: top, x2: at, y2: bottom });
  }
  // And across, at round temperatures: every 1, 2, 5 or 10 degrees, the smallest step that gives
  // 5 lines at most (0 °C has its own red one).
  const step = [1, 2, 5, 10].find((size) => (high - low) / size <= 5) || 10;
  for (let degrees = Math.ceil((low + 0.01) / step) * step; degrees < high; degrees += step) {
    if (degrees !== 0) draw("line", { class: "tick", x1: 0, y1: yTemp(degrees), x2: W, y2: yTemp(degrees) });
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
    draw("polyline", { class: "outline", points: line("wind", yWind) });
    draw("polyline", { class: "wind", points: line("wind", yWind) });
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
  else readout = conditionsAt(chart, day, day.start + 12 * 3600, interpolate);
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
      el("div", { class: "chart-axis" }, el("span", {}, `${high}°`), el("span", {}, `${low}°`)),
      el("div", { class: "chart-area" }, svg, marks),
      el("div", { class: "chart-axis right" }, el("span", {}, `${windTop}`), el("span", {}, "km/h"))),
    el("div", { class: "chart-hours" }, hours),
    el("div", { class: `chart-caption${inspected === null ? "" : " inspecting"}` }, readout));
}

// The conditions at one moment of the chart: observed if it has gone by, forecast if not.
function conditionsAt(chart, day, t, interpolate) {
  const hour = `${String(Math.round((t - day.start) / 3600)).padStart(2, "0")}:00`;
  const temp = interpolate(t, "temp");
  if (temp === null) return upper(`${hour}  sin datos`);
  const wind = interpolate(t, "wind"), clouds = interpolate(t, "clouds");
  const bar = day.bars.find((bar) => bar.from <= t && t < bar.to);
  const rain = bar ? `☂ ${bar.rain.toFixed(1)} mm/h${bar.observed ? "" : ` ${Math.round(bar.pop * 100)}%`}` : "☂ 0";
  // Gone by: observed, or estimated by Open-Meteo where nothing was observed.
  const nearest = day.points.reduce((best, point) => (Math.abs(point.t - t) < Math.abs(best.t - t) ? point : best), day.points[0]);
  const when = t >= chart.now ? "previsto" : nearest && nearest.estimated ? "estimado" : "observado";
  return upper([hour, `${temp.toFixed(1)}°C`, `${Math.round(wind)} km/h`, rain, `︽ ${Math.round(clouds)}%`, when].join("  "));
}

function conditionsNow(sample) {
  return upper([
    "Ahora", `${sample.temp.toFixed(1)}°C`, `${Math.round(sample.wind)} km/h`,
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

function moveChartHour(step) {
  chartHour = Math.max(0, Math.min(23, (chartHour ?? startHour()) + step));
  render();
}

function toggleChartDay() {
  chartDay = chartDay ? 0 : 1;
  render();
}

// The weather chart's key, if a panel has one.
function chartKey() {
  for (const { data } of panelViews()) {
    const reading = data.readings.find((reading) => reading.chart);
    if (reading) return reading.chart.key;
  }
  return null;
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
  // Only the sources that fail: those that work (or haven't answered yet) need no room.
  for (const source of (state && state.sources) || []) {
    if (source.ok === false) items.push(el("span", { class: "source bad" }, `✖ ${source.name.toUpperCase()}`));
  }
  // A click on one of these does the same as pressing its key (see the listener on #status).
  const key = (letter, text, flashing = false) =>
    el("button", { class: flashing ? "flashing" : null, "data-key": letter }, `[${KEY_NAMES[letter] || letter.toUpperCase()}]${text}`);
  // R (refresh) still works, but stays out of the bar to save room.
  items.push(key("c", "COLOR"));
  if (state && unseenAlerts().length) items.push(key("a", "VISTO", true));
  for (const pomodoro of layout.pomodoros) {
    const running = state && state.pomodoro && state.pomodoro.running;
    items.push(key(pomodoro.start_key, running ? "PAUSAR" : "POMODORO"));
    // Reset only while a pomodoro is under way: stopped at the start there's nothing to reset.
    if (state && state.pomodoro && state.pomodoro.active) items.push(key(pomodoro.reset_key, "REINICIAR"));
  }
  for (const view of panelViews()) {
    if (view.panel.page_key && !view.panel.key) items.push(key(view.panel.page_key, upper(view.panel.title)));
  }
  if (layout.history_key) items.push(key(layout.history_key, history ? "AHORA" : "HISTORIAL"));
  const weatherKey = chartKey();
  if (weatherKey) items.push(key(weatherKey, chartDay ? "HOY" : "MAÑANA"));
  for (const editor of layout.date_editors || []) items.push(key(editor.key, "FECHAS"));
  for (const view of panelViews()) {
    if (!view.panel.key) continue;
    // A hidden panel with new alerts: the menu entry flashes so it isn't missed.
    const fresh = view.data.readings.some((reading) => parts(reading).some((part) => part.alert && !seen.has(alertKey(view.panel, part))));
    items.push(key(view.panel.key, upper(view.panel.title) + (fresh ? "!" : ""), fresh));
  }
  if (cursor === CALENDAR_CURSOR && !reader) {
    if (calendarDay) items.push(key("q", "VOLVER"));
    else items.push(key("enter", "ELEGIR DÍA"), key("q", "SALIR"));
  } else if (cursor === CHART_CURSOR && !reader) items.push(key("enter", chartDay ? "HOY" : "MAÑANA"), key("q", "SALIR"));
  else if (cursor && !reader) items.push(key("enter", "ABRIR"), key("q", "SALIR"));
  // A pop-up panel open: Q closes it.
  else if (popup !== null && !reader && !dates) items.push(key("q", "CERRAR"));
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
  const key = event.key.toLowerCase();
  // The arrows move the link cursor instead of scrolling; Enter opens its link, not a focused button.
  if (Object.hasOwn(ARROWS, key) || (key === "enter" && (cursor || reader))) event.preventDefault();
  press(key);
}

// A key, typed or clicked in the status bar.
function press(key) {
  unlockAudio();
  noticeFlashUntil = 0;
  // Q leaves, as in most terminal programs (and in elinor); Esc still does too.
  if (key === "q") key = "escape";
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
    if (link && link.dataset.reader) return link.click();
    return void window.open(cursor, "_blank", "noopener");
  }
  if (key === layout.history_key) return toggleHistory();
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
  if (key === "r") return post("/api/reload");
  if (key === "c") return nextTheme();
  if (key === "a") return acknowledge();
  const editor = (layout.date_editors || []).find((editor) => editor.key === key);
  if (editor) return openDates(editor.name);
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

// ---------------------------------------------------------------- big digits

// Seven-segment digits drawn with box-drawing characters, three rows high, like elinor
// (the glyphs are Textual's bold Digits, MIT licence).
const SEGMENTS = {
  " ": ["   ", "   ", "   "],
  "0": ["┏━┓", "┃ ┃", "┗━┛"],
  "1": ["╺┓ ", " ┃ ", "╺┻╸"],
  "2": ["╺━┓", "┏━┛", "┗━╸"],
  "3": ["╺━┓", " ━┫", "╺━┛"],
  "4": ["╻ ╻", "┗━┫", "  ╹"],
  "5": ["┏━╸", "┗━┓", "╺━┛"],
  "6": ["┏━╸", "┣━┓", "┗━┛"],
  "7": ["╺━┓", "  ┃", "  ╹"],
  "8": ["┏━┓", "┣━┫", "┗━┛"],
  "9": ["┏━┓", "┗━┫", "╺━┛"],
  "+": ["   ", "╺╋╸", "   "],
  "-": ["   ", "╺━╸", "   "],
  ":": ["   ", " : ", "   "],
  "A": ["╭─╮", "├─┤", "╵ ╵"],
  "B": ["┌─╮", "├─┤", "└─╯"],
  "C": ["╭─╮", "│  ", "╰─╯"],
  "D": ["┌─╮", "│ │", "└─╯"],
  "E": ["╭─╴", "├─ ", "╰─╴"],
  "F": ["╭─╴", "├─ ", "╵  "],
};

// The three rows of a value in big digits. A character without a glyph goes on the bottom row,
// as a small one (".", "%"), except "°", which goes on the top row where it belongs.
function segmentRows(text) {
  const rows = ["", "", ""];
  for (const character of String(text).replace(/\./g, "•")) {
    const glyph = SEGMENTS[character.toUpperCase()];
    if (glyph) glyph.forEach((part, row) => (rows[row] += part));
    else if (character === "°") rows.forEach((_, row) => (rows[row] += row === 0 ? character : " "));
    else rows.forEach((_, row) => (rows[row] += row === 2 ? character : " "));
  }
  return rows;
}

function setSegments(node, text) {
  node.textContent = segmentRows(text).join("\n");
  node.setAttribute("aria-label", text);
}

// ---------------------------------------------------------------- link cursor

const ARROWS = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] };
const KEY_NAMES = { enter: "↵", escape: "ESC" };

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

// To the nearest link in that direction, measured between edges: a list of headlines (all starting
// at the same left edge) is entered at the top. The distance across counts double, and is zero while
// the two overlap, so a column of headlines or of icons is followed straight down.
function moveCursor([dx, dy]) {
  const links = visibleLinks();
  const current = links.find((link) => cursorId(link) === cursor);
  // On the chart, left and right move along its hours, up and down leave it.
  if (current && cursor === CHART_CURSOR && dx) return moveChartHour(dx);
  // In the calendar's days: left and right a day, up and down a week (the month follows).
  if (current && cursor === CALENDAR_CURSOR && calendarDay) return moveCalendarDay(dx + dy * 7);
  let target = current ? null : links[0];
  if (current) {
    const from = current.getBoundingClientRect();
    let best = Infinity;
    for (const link of links) {
      const to = link.getBoundingClientRect();
      const ahead = dx ? (to.left + to.right - from.left - from.right) * dx : (to.top + to.bottom - from.top - from.bottom) * dy;
      if (link === current || ahead <= 2) continue;
      const along = Math.max(0, dx > 0 ? to.left - from.right : dx < 0 ? from.left - to.right : dy > 0 ? to.top - from.bottom : from.top - to.bottom);
      const across = dx
        ? Math.max(0, to.top - from.bottom, from.top - to.bottom)
        : Math.max(0, to.left - from.right, from.left - to.right);
      if (along + 2 * across < best) [best, target] = [along + 2 * across, link];
    }
  }
  if (!target) return;
  cursor = cursorId(target);
  chartHour = cursor === CHART_CURSOR ? startHour() : null;
  render();
  target = visibleLinks().find((link) => cursorId(link) === cursor);
  // Only where the page scrolls (a phone, one column): on a screen it's all in sight, and scrolling
  // it would shift the whole dashboard.
  if (target && getComputedStyle(document.body).overflow !== "hidden") target.scrollIntoView({ block: "nearest" });
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

function boot(lines) {
  // Once per browser session: a reload doesn't replay it.
  try {
    if (sessionStorage.getItem("marianne.booted")) return Promise.resolve();
    sessionStorage.setItem("marianne.booted", "1");
  } catch {
    /* no storage: show it */
  }
  const screen = document.getElementById("boot");
  const log = document.getElementById("boot-log");
  screen.hidden = false;
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

addEventListener("keydown", onKey);
document.getElementById("status").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-key]");
  if (button) press(button.dataset.key);
});
// A click outside the pop-up panel closes it.
document.getElementById("popup").addEventListener("click", (event) => {
  if (event.target.id !== "popup") return;
  if (dates) {
    if (!dates.form) closeDates();
  } else if (reader) closeReader();
  else togglePopup(popup);
});
addEventListener("pointerdown", unlockAudio);
start();

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

// A robot vacuum's last path stays on the plan, after it's back, until V marks it as seen: by
// when that cleaning began, so the next one shows again. Kept apart from the alerts (which are
// forgotten as they clear).
let seenPaths = new Set(load("marianne.paths", []));

function pendingPaths() {
  return panelViews().flatMap(({ panel, data }) => data.readings
    .filter((reading) => reading.robot && reading.robot.last_clean && !seenPaths.has(pathKey(panel, reading)))
    .map((reading) => pathKey(panel, reading)));
}

const pathKey = (panel, reading) => `${panel.title}|${reading.robot.last_clean}`;

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
  if (state && (unseenAlerts().length || pendingPaths().length)) fresh.add("v");
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
  // Something else in the window: the panel will have to be drawn again.
  if (popup === null || reader || dates || helpOpen) delete box.dataset.panel;
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
  // Rebuilt only when it changes, and where it had been scrolled to: rebuilding it on every poll
  // would cut a finger's scroll short on a phone and send it back to the top.
  const panel = drawPanel(panelViews()[popup]);
  if (box.dataset.panel === panel.outerHTML) return;
  const scrolled = [...box.querySelectorAll("*")].filter((node) => node.scrollTop || node.scrollLeft)
    .map((node) => [scrollPath(box, node), node.scrollTop, node.scrollLeft]);
  box.replaceChildren(panel);
  box.dataset.panel = panel.outerHTML;
  for (const [path, top, left] of scrolled) {
    const node = path.reduce((parent, index) => parent && parent.children[index], box);
    if (node) node.scrollTo(left, top);
  }
}

// Where a node sits under the root, as the index of each child on the way down.
function scrollPath(root, node) {
  const path = [];
  for (; node !== root; node = node.parentElement) path.unshift([...node.parentElement.children].indexOf(node));
  return path;
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
    // The plan, on the page that has its items (another page of the panel, the records, in rows).
    const onPlan = (reading) => reading.room || reading.light || reading.door || reading.robot || reading.appliance;
    if (panel.plan && data.readings.some(onPlan)) {
      body.classList.add("with-plan");
      body.append(drawPlan(panel, shown, index));
      rows = [];
    }
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
          // The Sun's path takes the height the rows under it leave, like the weather chart.
          if (path) body.classList.add("with-sun");
          body.append(...(path ? drawSunPath(sun, path.sun_path) : [drawSun(sun)]));
        }
        continue;
      }
      if (reading.heating_summary) {
        body.append(drawHeatingSummary(reading));
        continue;
      }
      if (reading.heating) {
        body.classList.add("with-heating");
        body.append(...drawHeating(view, reading));
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
      const row = drawRow(panel, reading, { labelWidth, valueWidth, noteWidth });
      // Venus: its little drawing around the Sun just before what it says.
      if (reading.venus) row.querySelector(".values").prepend(drawVenus(reading.venus));
      body.append(row);
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
    const title = `${reading.label}: ${reading.value}${reading.note ? ` (${reading.note})` : ""}${reading.update ? " · hay una actualización" : ""}`;
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
  if (roomChooser && roomChooser.panel === view.index) return drawRoomChooser();
  const buttons = readings.slice(0, 9).map((reading, item) => {
    const id = `script:${view.index}:${item}`;
    const busy = running.has(id) || reading.switch === true;
    const { label, icon, choose } = actionLook(reading);
    const [kind, name] = (icon || "mdi:script-text").split(":");
    // A button that opens something of the page's (the iPod), or the rooms to choose, instead of
    // running something at once.
    const run = reading.opens ? () => openThing(reading.opens)
      : choose ? () => openRoomChooser(view.index, item, reading)
        : () => runScript(id, view.index, item, label);
    return el("button", {
      class: `tile action${busy ? " on" : ""}${reading.error ? " error" : ""}`, "data-cursor": id, "data-script": "1",
      title: reading.error ? `${label}: no existe en Home Assistant` : label, onclick: run,
    },
    el("span", { class: "number-key" }, String(item + 1)),
    el("span", { class: "icon" }, el("span", { class: "glyph", style: `--icon: url("/api/icon/${kind}/${name}")` })),
    el("span", { class: "name" }, upper(label)),
    // A server task, when it isn't running: how its last run went ("hecho 10:02"), red if it failed.
    el("span", { class: !busy && reading.value === "error" ? "alert-text" : "dim" }, busy ? upper("en marcha")
      : reading.error ? upper(reading.opens ? "error" : "no existe") : reading.note ? upper(reading.note) : "\u00a0"));
  });
  // The free places of the grid, as empty boxes: it's always three by three.
  const free = Array.from({ length: 9 - buttons.length }, () => el("div", { class: "tile action free" }));
  return el("div", { class: "actions" }, ...buttons, ...free);
}

// ---------------------------------------------------------------- the heating's efficiency

// The boiler's dial, as on the boiler: its positions round an arc (the snowflake, off, first), the
// pointer where it is. A click on a position, or ← →, turns it; the server keeps each move with
// its time, so the analysis knows which it was at each moment.
const DIAL_FROM = -135, DIAL_TO = 135; // degrees from straight up

function drawDial(view, info) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "dial");
  svg.setAttribute("viewBox", "-60 -60 120 120");
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, v] of Object.entries(attrs)) node.setAttribute(name, v);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  const angle = (i) => ((DIAL_FROM + ((DIAL_TO - DIAL_FROM) * i) / (info.dials.length - 1)) * Math.PI) / 180;
  add("circle", { class: "dial-face", cx: 0, cy: 0, r: 30 });
  info.dials.forEach(([name], i) => {
    const a = angle(i);
    const [x, y] = [Math.sin(a), -Math.cos(a)];
    add("line", { class: "dial-tick", x1: (x * 33).toFixed(1), y1: (y * 33).toFixed(1), x2: (x * 38).toFixed(1), y2: (y * 38).toFixed(1) });
    const label = add("text", { class: `dial-label${name === info.dial ? " on" : ""}`, x: (x * 48).toFixed(1), y: (y * 48 + 4).toFixed(1),
      "text-anchor": "middle" }, name === "off" ? "❄" : name === "max" ? "MAX" : name);
    // A bigger target than the label, to click.
    const target = add("circle", { class: "dial-target", cx: (x * 46).toFixed(1), cy: (y * 46).toFixed(1), r: 9 });
    for (const node of [label, target]) node.addEventListener("click", () => moveDial(view.index, name));
  });
  const at = info.dials.findIndex(([name]) => name === info.dial);
  if (at >= 0) {
    const a = angle(at);
    add("line", { class: "dial-pointer", x1: 0, y1: 0, x2: (Math.sin(a) * 26).toFixed(1), y2: (-Math.cos(a) * 26).toFixed(1) });
  }
  add("circle", { class: "dial-hub", cx: 0, cy: 0, r: 4 });
  return svg;
}

let dialMoving = false;

async function moveDial(panel, position) {
  if (dialMoving) return;
  dialMoving = true;
  try {
    const response = await fetch(`/api/dial/${panel}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position }),
    });
    const answer = await response.json().catch(() => ({}));
    if (response.ok) {
      update(answer);
      showToast(answer.warning ? `✓ Regulador · ${answer.warning}` : `✓ Regulador en ${position === "off" ? "❄" : upper(position)}`);
    } else showToast(`✖ Regulador · ${answer.error || "no se ha podido guardar"}`);
  } catch {
    showToast("✖ Regulador · sin conexión con Marianne");
  } finally {
    dialMoving = false;
  }
}

// ← → in the heating's window: the dial one position down or up.
function turnDial(view, step) {
  const info = (view.data.readings.find((reading) => reading.heating) || {}).heating;
  if (!info) return false;
  const names = info.dials.map(([name]) => name);
  const at = names.indexOf(info.dial);
  const next = names[Math.max(0, Math.min(names.length - 1, (at < 0 ? names.indexOf("4") : at) + step))];
  if (next !== info.dial) moveDial(view.index, next);
  return true;
}

const decimal = (value, digits = 1) => (value === null || value === undefined ? "–" : Number(value).toFixed(digits));
const percent = (share) => `${Math.round(share * 100)} %`;

// A row of the window: what, its figure, and a note after it (under it, whole, on a phone).
function heatingRow(label, value, note, tone = "") {
  return el("div", { class: `row heating-row${tone ? ` ${tone}` : ""}` }, el("span", { class: "label" }, upper(label)), el("span", { class: "leader" }),
    el("span", { class: "values" }, el("span", { class: "value-text" }, value)),
    note ? el("span", { class: "heating-row-note unit" }, ` ${note}`) : null);
}

// The window: the dial and what it means, the boiler against the house's losses, the positions to
// choose from, the rooms, and what all that says, in words.
function drawHeating(view, reading) {
  const info = reading.heating;
  const result = info.analysis;
  const flows = Object.fromEntries(info.dials);
  const current = result && (result.dials || []).find((p) => p.dial === info.dial);
  const out = [];
  // The dial, and beside it the water it makes.
  const since = info.since ? new Date(info.since) : null;
  const facts = [el("div", { class: "dial-name" }, upper("Regulador de la calefacción"))];
  if (!info.dial) {
    facts.push(el("div", { class: "alert-text" }, upper("¿En qué posición está? Gírelo a la de la caldera (← →)")));
  } else if (info.dial === "off") {
    facts.push(el("div", {}, upper("❄ Calefacción apagada en la caldera")));
  } else {
    facts.push(el("div", {}, upper(`Posición ${info.dial} · agua a ${flows[info.dial]} °C`)));
    if (current) {
      facts.push(el("div", { class: current.condensing ? "" : "alert-text" },
        upper(`Vuelve a ≈ ${current.back} °C · ${current.condensing ? "condensa" : "no condensa"} · rinde ≈ ${decimal(current.efficiency, 0)} %`)));
    }
  }
  if (since) facts.push(el("div", { class: "dim" }, upper(`Desde ${since.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" })} ${since.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`)));
  out.push(el("div", { class: "heating-top" }, drawDial(view, info), el("div", { class: "dial-facts" }, ...facts)));
  out.push(el("div", { class: "rule" }));
  if (!result || !result.model) {
    out.push(el("div", { class: "waiting" }, upper(reading.error ? `Sin historial: ${reading.note}` : "Hacen falta unos días de historial con la calefacción funcionando")));
    return out;
  }
  // The boiler against the losses.
  out.push(el("div", { class: "heating-title" }, upper("La caldera")));
  const now = result.now;
  if (now && now.ratio) {
    out.push(heatingRow("Da ahora", `${decimal(now.ratio)} ×`, `lo que se pierde (${decimal(now.inside)}° dentro, ${decimal(now.outside)}° fuera)`));
    out.push(heatingRow("Le basta funcionar", percent(now.duty), `del tiempo · en 24 h ha funcionado el ${percent(now.duty_seen || 0)}`));
  }
  out.push(heatingRow(`Aguantaría ${decimal(result.comfort, 0)} °C`, result.limit < -20 ? "por debajo de −20 °C" : `hasta ${decimal(result.limit)} °C`, "fuera, sin parar"));
  if (result.cycles) {
    out.push(heatingRow("Encendidos", `${result.cycles.count} en ${decimal(result.days, 0)} días`,
      `${result.cycles.mean} min de media${result.cycles.short ? ` · ${result.cycles.short} de 15 min o menos` : ""}`));
  }
  // The positions.
  if (result.advice) {
    const best = result.dials.find((p) => p.dial === result.advice.best);
    out.push(el("div", { class: "heating-title" }, upper("El regulador")));
    if (best && best.dial !== info.dial) {
      out.push(heatingRow("Mejor posición", `${best.dial} · ${best.flow} °C`,
        `condensa · ≈ ${decimal(best.saving)} % menos gas · subir 2 °C: ${decimal(best.warm_two, 0)} h (ahora ${decimal(current.warm_two, 0)} h)`, "good"));
    } else if (best) {
      out.push(heatingRow("Mejor posición", `${best.dial} · la de ahora`, "condensa sin tardar mucho más en calentar", "good"));
    } else {
      out.push(heatingRow("Mejor posición", "ninguna condensa", "sin tardar mucho más en calentar: deja la de ahora"));
    }
    const lowest = result.advice.design;
    if (lowest) out.push(heatingRow(`Para ${decimal(result.advice.design_outside, 0)} °C fuera`, `bastaría la ${lowest}`, "si no se baja la consigna (calienta muy despacio)"));
    out.push(drawDialTable(result, info.dial));
  }
  // The weeks kept: what each change did, the cold of each week taken out.
  if ((result.weeks || []).length) {
    out.push(el("div", { class: "heating-title" }, upper("Semana a semana")));
    out.push(drawWeekTable(result.weeks));
  }
  // The rooms.
  out.push(el("div", { class: "heating-title" }, upper("La casa")));
  out.push(drawRoomTable(result.rooms));
  for (const text of heatingAdvice(result)) out.push(el("div", { class: "heating-note" }, `▸ ${text}`));
  out.push(el("div", { class: "heating-note dim" }, `${decimal(result.days, 0)} días de historial de Home Assistant, ${decimal(result.heating_hours, 0)} h de calefacción; ` +
    `${result.kept_days || 0} días guardados para el balance. ` +
    "Estimaciones: no hay contador de gas ni sensor del agua; las temperaturas del regulador son las del manual (aproximadas)."));
  return out;
}

// The analysis in one line, for another panel (Energía): the dial, whether it condenses and the
// position to go to; a click opens its window.
function drawHeatingSummary(reading) {
  const view = panelViews().find((v) => v.data.readings.some((r) => r.heating));
  const info = view && view.data.readings.find((r) => r.heating).heating;
  const tokens = [["label", reading.label]];
  const result = info && info.analysis;
  const current = result && (result.dials || []).find((p) => p.dial === info.dial);
  if (!info) tokens.push(["unit", "sin análisis"]);
  else if (!info.dial) tokens.push(["unit", `¿regulador? (${view.panel.key ? view.panel.key.toUpperCase() : "abrir"})`]);
  else if (info.dial === "off") tokens.push(["value", "❄"], ["unit", "apagada"]);
  else {
    tokens.push(["value", upper(info.dial)], ["unit", `${Object.fromEntries(info.dials)[info.dial]}°`]);
    if (current) tokens.push(["sep", "·"], [current.condensing ? "value" : "alert", current.condensing ? "condensa" : "no condensa"]);
    const best = result.advice && result.dials.find((p) => p.dial === result.advice.best);
    if (best && best.dial !== info.dial) tokens.push(["sep", "·"], ["label", "mejor"], ["value", upper(best.dial)], ["unit", `${best.saving > 0 ? "−" : "+"}${decimal(Math.abs(best.saving))} % gas`]);
    else if (result.now && result.now.ratio) tokens.push(["sep", "·"], ["value", `${decimal(result.now.ratio)}×`], ["unit", "lo que se pierde"]);
  }
  const line = el("div", { class: "row summary heating-summary" }, el("span", { class: "label" },
    tokens.flatMap(([kind, text], at) => [at ? " " : "", el("span", { class: `token-${kind}` }, upper(text))])));
  if (view) {
    line.setAttribute("title", "Abrir el análisis de la calefacción");
    line.addEventListener("click", () => togglePopup(view.index));
  }
  return line;
}

function drawDialTable(result, dial) {
  const head = ["Pos.", "Ida", "Vuelta", "Rinde", "Gas", "+2 °C"];
  const rows = result.dials.map((p) => [
    p.dial === "max" ? "MAX" : p.dial, `${p.flow}°`, `${p.back}°`,
    `${decimal(p.efficiency, 0)} %`, p.saving === null ? "–" : `${p.saving > 0 ? "−" : p.saving < 0 ? "+" : ""}${decimal(Math.abs(p.saving))} %`,
    p.warm_two ? `${decimal(p.warm_two, 0)} h` : "–",
  ]);
  return el("div", { class: "heating-scroll" }, el("table", { class: "heating-table" },
    el("tr", {}, ...head.map((cell) => el("th", {}, upper(cell)))),
    ...rows.map((cells, i) => {
      const p = result.dials[i];
      const tone = `${p.dial === dial ? "on" : ""}${p.dial === result.advice.best ? " good" : ""}${p.condensing ? "" : " hot"}`;
      return el("tr", { class: tone.trim() }, ...cells.map((cell) => el("td", {}, cell)));
    })));
}

// Boiler hours for each degree-day (a day 1 °C warmer inside than outside): the cold taken out, so
// a lower number is a house that needs less. "A la de hoy": as if the dial had been today's, to
// compare weeks with the dial in different places.
function drawWeekTable(weeks) {
  const head = ["Semana", "Fuera", "Caldera", "Reg.", "h/°C·día", "A la de hoy"];
  return el("div", { class: "heating-scroll" }, el("table", { class: "heating-table" },
    el("tr", {}, ...head.map((cell) => el("th", {}, upper(cell)))),
    ...weeks.map((week) => {
      const [year, month, day] = week.monday.split("-");
      return el("tr", {},
        el("td", {}, `${day}/${month}${week.days < 7 ? ` (${week.days} d)` : ""}`),
        el("td", {}, `${decimal(week.outside)}°`), el("td", {}, `${decimal(week.hours, 0)} h`),
        el("td", {}, week.dial.length ? week.dial.map((d) => upper(d)).join("/") : "–"),
        el("td", {}, decimal(week.per_degree_day, 2)), el("td", {}, decimal(week.at_dial, 2)));
    })));
}

function drawRoomTable(rooms) {
  const head = ["", "24 h", "Calef.", "Enfría", "Radiad.", "Esquinas"];
  const times = (value) => (value === null || value === undefined ? "–" : `${decimal(value)}×`);
  return el("div", { class: "heating-scroll" }, el("table", { class: "heating-table rooms" },
    el("tr", {}, ...head.map((cell) => el("th", {}, upper(cell)))),
    ...rooms.map((room) => el("tr", {},
      el("td", {}, upper(room.name)), el("td", {}, room.mean === null ? "–" : `${decimal(room.mean)}°`),
      el("td", {}, room.behind === undefined ? "termostato" : room.behind === null ? "–" : `${room.behind > 0 ? "+" : ""}${decimal(room.behind)}°`),
      el("td", { class: room.cools >= 1.3 ? "alert-text" : "" }, times(room.cools)),
      el("td", {}, times(room.heat)),
      el("td", { class: room.mould >= 10 ? "alert-text" : "", title: room.mould ? `${room.mould} % del tiempo por encima del 80 %` : null },
        room.corner === undefined ? "–" : `${room.corner} %${room.mould ? ` (${room.mould})` : ""}`)))));
}

// What the numbers say, in words: the rooms the thermostat leaves behind, the ones without heating,
// windows opened, mould, the sun and the wind. (The rooms that lose most are red in the table.)
function heatingAdvice(result) {
  const notes = [];
  const list = (rooms, value) => rooms.map((room) => `${room.name} (${value(room)})`).join(", ").replace(/, ([^,]*)$/, " y $1");
  const behind = result.rooms.filter((room) => room.behind !== undefined && room.behind !== null && room.behind <= -1).sort((a, b) => a.behind - b.behind);
  if (behind.length) {
    notes.push(`El termostato está en una habitación que se calienta antes que ${list(behind, (room) => `${decimal(room.behind)}°`)}: apaga la caldera antes de que lleguen. Con las válvulas abiertas del todo, equilibra con los detentores (la llave del otro lado del radiador): ciérralo un poco en el radiador del termostato, o pon un sensor del Nest en una de esas habitaciones.`);
  }
  const unheated = result.rooms.filter((room) => room.heat !== null && room.heat !== undefined && room.heat < 0.35);
  if (unheated.length) notes.push(`${unheated.map((room) => room.name).join(" y ")} apenas ${unheated.length > 1 ? "notan" : "nota"} la calefacción (sin radiador o con él cerrado).`);
  const aired = result.rooms.filter((room) => room.opened >= 3).sort((a, b) => b.opened - a.opened);
  if (aired.length) {
    notes.push(`Ventanas abiertas (caídas bruscas sin calefacción): ${list(aired, (room) => `${room.opened} veces`)} en ${decimal(result.days, 0)} días. Ventilar 5–10 min de golpe renueva el aire sin enfriar los muros; más rato sí los enfría, y luego cuesta recuperarlos.`);
  }
  const mould = result.rooms.filter((room) => room.mould >= 10);
  if (mould.length) {
    notes.push(`En ${list(mould, (room) => `${room.mould} % del tiempo`)} las esquinas de las paredes de fuera pasan del 80 % de humedad (3 últimos días): riesgo de moho. Ventilar unos minutos después de duchas, cocinar o tender, y no dejar muebles pegados a esas paredes.`);
  }
  for (const [side, sun] of Object.entries(result.sun || {})) {
    notes.push(`El sol de frente en las ventanas del ${side} calienta la casa ${decimal(sun.warms, 2)} °C/h: como la caldera funcionando el ${percent(Math.min(1, sun.share))} del tiempo. Con sol, abre las cortinas de ese lado; al ponerse, ciérralas.`);
  }
  if (result.wind && result.wind.sure && result.wind.share > 0.05) {
    notes.push(`Con cada 10 km/h de viento la casa necesita un ${percent(result.wind.share)} más de calefacción: se cuela aire por ventanas y rendijas.`);
  }
  if (result.advice && result.advice.best && result.now) {
    notes.push("Con una caldera de condensación y muros que guardan tanto el calor, gasta menos tener el agua más fría y la calefacción más horas con una consigna estable que bajarla mucho por la noche y recuperar a golpes.");
  }
  return notes;
}

// A robot vacuum's button that starts a cleaning: "Pausar" while it cleans, "Reanudar" while it's
// paused (the server does the same with it); the one of the rooms to choose opens the chooser.
function actionLook(reading) {
  const detail = reading.detail || {};
  const cleaning = ["start", "clean_rooms"].includes(detail.command);
  if (cleaning && reading.value === "cleaning") return { label: "Pausar", icon: "mdi:pause" };
  if (cleaning && reading.value === "paused") return { label: "Reanudar", icon: "mdi:play" };
  return { label: reading.label, icon: reading.icon, choose: detail.command === "clean_rooms" && Boolean(detail.rooms) };
}

// ---- choosing the rooms to clean

// In the actions window, in place of its buttons: the rooms (the numbers tick them), how many
// passes (P), and Enter to clean them or Q to go back.
let roomChooser = null; // { panel, item, label, rooms, chosen: Set, repeat }

function openRoomChooser(panel, item, reading) {
  roomChooser = { panel, item, label: reading.label, rooms: reading.detail.rooms, chosen: new Set(), repeat: 1 };
  cursor = null;
  render();
}

function closeRoomChooser() {
  roomChooser = null;
  render();
}

function toggleRoom(name) {
  if (roomChooser.chosen.has(name)) roomChooser.chosen.delete(name);
  else roomChooser.chosen.add(name);
  render();
}

function nextRepeat() {
  roomChooser.repeat = (roomChooser.repeat % 3) + 1;
  render();
}

function cleanChosenRooms() {
  const { panel, item, label, rooms, chosen, repeat } = roomChooser;
  if (!chosen.size) return showToast("Elige al menos una habitación");
  roomChooser = null;
  // In the order of the list, not the order they were ticked.
  runScript(`script:${panel}:${item}`, panel, item, label, { rooms: rooms.filter((room) => chosen.has(room)), repeat });
}

function drawRoomChooser() {
  const { rooms, chosen, repeat } = roomChooser;
  const key = (text, onclick, extra = "") => el("button", { class: `chooser-key${extra}`, onclick }, text);
  return el("div", { class: "room-chooser" },
    el("div", { class: "chooser-rooms" }, rooms.map((room, index) =>
      el("button", { class: `chooser-room${chosen.has(room) ? " on" : ""}`, onclick: () => toggleRoom(room) },
        el("span", { class: "number-key" }, String(index + 1)),
        `${chosen.has(room) ? "[X]" : "[ ]"} ${upper(room)}`))),
    el("div", { class: "chooser-repeat" }, upper("Pasadas "),
      [1, 2, 3].map((n) => key(String(n), () => { roomChooser.repeat = n; render(); }, n === repeat ? " on" : "")),
      el("span", { class: "dim" }, " [P]")),
    el("div", { class: "chooser-go" },
      key(upper(`[↵] Limpiar${chosen.size ? ` (${chosen.size})` : ""}`), cleanChosenRooms, chosen.size ? "" : " dim"),
      key(upper("[Q] Volver"), closeRoomChooser)));
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
// What a vacuum's button ended up doing, for the notice.
const DONE = { pause: "en pausa", start: "en marcha", clean_rooms: "en marcha", return_to_base: "volviendo a la estación",
  task: "pedido al servidor" };

async function runScript(id, panel, item, name, choice = null) {
  if (running.has(id)) return;
  running.add(id);
  if (popup === panel) popup = null;
  cursor = null;
  showToast(`${name} · ejecutando…`);
  try {
    const request = choice
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(choice) }
      : { method: "POST" };
    const response = await fetch(`/api/script/${panel}/${item}`, request);
    const answer = await response.json().catch(() => ({}));
    if (response.ok) {
      update(answer);
      showToast(`✓ ${name} · ${DONE[answer.done] || "ejecutado"}`);
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
    // The relative humidity now, though the chart doesn't draw it.
    sample.humidity !== undefined ? `HR ${Math.round(sample.humidity)}%` : null,
  ].filter(Boolean).join("  "));
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
// ---------------------------------------------------------------- house plan

// A panel with `plan`: the house in lines, each room with its name and, if one of the items goes in
// it (`room:`), its temperature and humidity; the values for "fuera" (the weather station) outside.
function drawPlan(panel, readings, index) {
  const { size, rooms, outside } = panel.plan;
  const [W, H] = size;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "plan");
  svg.setAttribute("viewBox", `-0.5 -0.5 ${W + 1} ${H + 1}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const add = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(name, v);
    if (text !== undefined) node.textContent = text;
    svg.append(node);
    return node;
  };
  const byRoom = new Map();
  for (const reading of readings) {
    if (!reading.room) continue;
    if (!byRoom.has(reading.room)) byRoom.set(reading.room, []);
    byRoom.get(reading.room).push(reading);
  }
  // A robot vacuum: the rooms it has been through this time, faintly lit, its path while it's out,
  // and itself where it is.
  const robot = readings.find((reading) => reading.robot);
  const out = robot && ROBOT_OUT.has(robot.robot.state);
  // Its path while it's out, and after, until it's marked as seen (V).
  const pending = robot && robot.robot.last_clean && !seenPaths.has(pathKey(panel, robot));
  if (panel.plan.map && (out || pending || !robot)) drawPlanPath(svg, panel.plan.map, index);
  const visited = new Set(out ? robot.robot.rooms : []);
  const roomBoxes = new Map();

  // "19.9°" and "58%": the units short, there's little room.
  const short = (reading) => `${reading.value}${reading.unit === "°C" ? "°" : reading.unit === "%" ? "%" : reading.unit ? ` ${reading.unit}` : ""}`;
  const tone = (reading) => (reading.alert ? "plan-alert" : reading.offline || reading.error ? "plan-off" : null);

  for (const room of rooms) {
    let box;
    const lit = (visited.has(room.name) ? " plan-visited" : "") + (room.furniture ? " plan-furniture" : "");
    if (room.rect) {
      const [x, y, w, h] = room.rect;
      add("rect", { class: `plan-room${lit}`, x, y, width: w, height: h });
      box = { x, y, w, h };
    } else {
      add("polygon", { class: `plan-room${lit}`, points: room.points.map((point) => point.join(",")).join(" ") });
      const xs = room.points.map(([x]) => x), ys = room.points.map(([, y]) => y);
      box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    if (!room.name) continue;
    roomBoxes.set(room.name, { ...box, lights: room.lights });
    // Its name and values in its middle, or at its `label` (away from an island, say).
    const [cx, cy] = room.label || [box.x + box.w / 2, box.y + box.h / 2];
    // A text too wide for a narrow room (the pantry) gets smaller: VT323 is about half as wide as high.
    const fit = (text, size) => ({ style: `font-size: ${Math.min(size, (box.w * 0.9) / (text.length * 0.5)).toFixed(2)}px` });
    const [reading] = byRoom.get(room.name) || [];
    if (!reading) {
      add("text", { class: "plan-name", x: cx, y: cy + 0.6, "text-anchor": "middle", ...fit(room.name, 2) }, upper(room.name));
      continue;
    }
    // Its name, the temperature large, and the humidity (its `also`) under it.
    add("text", { class: "plan-name", x: cx, y: cy - 2.6, "text-anchor": "middle", ...fit(room.name, 2) }, upper(room.name));
    add("text", { class: `plan-temp ${tone(reading) || ""}`, x: cx, y: cy + 1.4, "text-anchor": "middle", ...fit(short(reading), 3.6) }, short(reading));
    const humidity = (reading.extra || [])[0];
    if (humidity) add("text", { class: `plan-humidity ${tone(humidity) || ""}`, x: cx, y: cy + 4.3, "text-anchor": "middle" }, short(humidity));
  }

  drawLights(add, readings.filter((reading) => reading.light), roomBoxes, index);
  for (const line of panel.plan.lines || []) {
    add("polyline", { class: "plan-line", points: line.points.map((point) => point.join(",")).join(" ") });
  }
  for (const door of panel.plan.doors || []) drawDoor(add, door, readings.find((reading) => reading.door === door.name));
  // The machines that are on (the washing machine while it washes), where they are.
  for (const reading of readings) {
    if (reading.appliance && reading.switch) drawAppliance(add, reading.appliance, reading.value);
  }

  // The robot where its own map says it is (stopped somewhere, dimmer; not while it charges at its
  // base); without that, while it's out, in the corner of the room it's in. Blinking in red if stuck.
  if (robot && !robot.robot.charging) {
    const spot = panel.plan.map ? robotSpot(panel.plan.map, index, out) : null;
    const room = out && roomBoxes.get(robot.value);
    const at = spot || (room ? [room.x + room.w - 3, room.y + room.h - 3] : null);
    if (at) drawVacuum(add, at, robot.robot.state === "error" ? "stuck" : out ? "out" : "home");
  }

  // Outside: the first value large (the temperature, with its trend, max and min), the rest in rows.
  const outsideReadings = byRoom.get("fuera") || [];
  if (outside && outsideReadings.length) {
    const [x, y, w] = outside;
    const [first, ...rest] = outsideReadings;
    add("text", { class: "plan-name plan-outside-name", x, y: y + 2.6 }, upper("Fuera"));
    add("text", { class: `plan-outside ${tone(first) || ""}`, x, y: y + 12.5 }, short(first));
    const beside = [first.note, ...(first.extra || []).map((extra) => `${extra.label} ${extra.value}°`)].filter(Boolean).join("  ");
    if (beside) add("text", { class: "plan-outside-beside", x, y: y + 17 }, beside);
    rest.forEach((reading, index) => {
      const row = y + 21.5 + index * 4;
      add("text", { class: "plan-outside-label", x, y: row }, upper(reading.label));
      add("text", { class: `plan-outside-value ${tone(reading) || ""}`, x: x + w, y: row, "text-anchor": "end" },
        `${short(reading)}${reading.note ? ` ${reading.note}` : ""}`);
    });
  }
  return svg;
}

// The vacuum's states in which it's away from its base, as the server says (ROBOT_OUT there).
const ROBOT_OUT = new Set(["cleaning", "returning", "paused", "error", "idle"]);
// Its path, asked for again every 20 seconds (as often as the server reads the map).
const PLAN_PATH_MS = 20000;

// The lights of each room: a small bulb each, in a row from the room's top right corner, lit
// (filled, with rays) or not; a room with one on glows faintly. A tap switches it.
function drawLights(add, lights, roomBoxes, index) {
  const byRoom = new Map();
  lights.forEach((reading, light) => {
    if (!byRoom.has(reading.light)) byRoom.set(reading.light, []);
    byRoom.get(reading.light).push({ reading, light });
  });
  for (const [room, list] of byRoom) {
    const box = roomBoxes.get(room);
    if (!box) continue;
    if (list.some(({ reading }) => reading.switch)) {
      add("rect", { class: "plan-lit", x: box.x, y: box.y, width: box.w, height: box.h });
    }
    list.forEach(({ reading, light }, n) => {
      const [x0, y] = box.lights || [box.x + box.w - 1.9, box.y + 2.1];
      const x = x0 - n * 2.6;
      const on = Boolean(reading.switch);
      const group = add("g", { class: `plan-bulb${on ? " on" : ""}${reading.offline || reading.error ? " gone" : ""}` });
      const part = (tag, attrs) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        group.append(node);
      };
      part("title", {});
      group.lastChild.textContent = `${reading.label}: ${on ? "encendida" : "apagada"} (toca para cambiar)`;
      // A larger invisible circle, easier to hit with a finger.
      part("circle", { class: "plan-bulb-hit", cx: x, cy: y, r: 1.3 });
      part("circle", { class: "plan-bulb-glass", cx: x, cy: y - 0.15, r: 0.65 });
      part("rect", { class: "plan-bulb-base", x: x - 0.32, y: y + 0.5, width: 0.64, height: 0.42 });
      if (on) {
        for (const angle of [-150, -90, -30, 30, 150]) {
          const a = (angle * Math.PI) / 180;
          part("line", { class: "plan-bulb-ray", x1: x + Math.cos(a) * 0.95, y1: y - 0.15 + Math.sin(a) * 0.95,
            x2: x + Math.cos(a) * 1.35, y2: y - 0.15 + Math.sin(a) * 1.35 });
        }
      }
      group.addEventListener("click", () => toggleLight(index, light, reading.label));
    });
  }
}

async function toggleLight(panel, light, name) {
  try {
    const response = await fetch(`/api/light/${panel}/${light}`, { method: "POST" });
    const answer = await response.json().catch(() => ({}));
    if (response.ok) update(answer);
    else showToast(`✖ ${name} · no se ha podido cambiar${answer.error ? `: ${answer.error}` : ""}`);
  } catch {
    showToast(`✖ ${name} · sin conexión con Marianne`);
  }
}

// A washing machine seen from the front: its body, the controls along the top and the round door,
// with the drum turning inside (stopped while it's paused). A dishwasher: the controls, the handle
// of its door and three drops of water blinking in turn.
function drawAppliance(add, { kind, at: [x, y] }, value) {
  const size = 3.6;
  if (kind === "dishwasher") {
    add("rect", { class: "plan-appliance", x: x - size / 2, y: y - size / 2, width: size, height: size, rx: 0.3 });
    add("line", { class: "plan-appliance-thin", x1: x - size / 2, y1: y - size / 2 + 0.8, x2: x + size / 2, y2: y - size / 2 + 0.8 });
    add("line", { class: "plan-appliance", x1: x - 0.8, y1: y - size / 2 + 1.25, x2: x + 0.8, y2: y - size / 2 + 1.25 });
    [-0.9, 0, 0.9].forEach((dx, n) => {
      const drop = add("path", {
        class: "plan-appliance-drop",
        d: `M ${x + dx} ${y + 0.05} q 0.4 0.55 0 0.85 q -0.4 -0.3 0 -0.85 z`,
      });
      drop.style.animationDelay = `${n * 0.4}s`;
    });
    return;
  }
  if (kind !== "washer") return;
  const paused = /pausa/i.test(value || "");
  add("rect", { class: "plan-appliance", x: x - size / 2, y: y - size / 2, width: size, height: size, rx: 0.3 });
  add("line", { class: "plan-appliance-thin", x1: x - size / 2, y1: y - size / 2 + 0.8, x2: x + size / 2, y2: y - size / 2 + 0.8 });
  add("circle", { class: "plan-appliance-dot", cx: x + size / 2 - 0.55, cy: y - size / 2 + 0.4, r: 0.18 });
  add("circle", { class: "plan-appliance", cx: x, cy: y + 0.4, r: 1.15 });
  const drum = add("path", {
    class: `plan-appliance-drum${paused ? "" : " spinning"}`,
    d: `M ${x - 0.7} ${y + 0.4} A 0.7 0.7 0 0 1 ${x + 0.7} ${y + 0.4}`,
  });
  drum.style.transformOrigin = `${x}px ${y + 0.4}px`;
}

// A door of the plan: the wall erased between its ends; closed, a thick line; open (its contact
// sensor on), the leaf turned on its hinge (`from`) to the side of `swing`, with its arc; red if
// it's alerting.
const DOOR_OPEN_DEGREES = 75;

function drawDoor(add, door, reading) {
  const [ax, ay] = door.from;
  const [bx, by] = door.to;
  const open = Boolean(reading && reading.switch);
  const tone = reading && reading.alert ? " plan-door-alert" : "";
  add("line", { class: "plan-door-gap", x1: ax, y1: ay, x2: bx, y2: by });
  if (!open) {
    add("line", { class: `plan-door${tone}`, x1: ax, y1: ay, x2: bx, y2: by });
    return;
  }
  // A double door: two leaves, each on its own hinge, meeting in the middle.
  if (door.leaves === 2) {
    const middle = [(ax + bx) / 2, (ay + by) / 2];
    drawLeaf(add, [ax, ay], middle, door.swing, tone);
    drawLeaf(add, [bx, by], middle, -door.swing, tone);
    return;
  }
  drawLeaf(add, [ax, ay], [bx, by], door.swing, tone);
}

// One leaf of an open door: from its hinge, turned to the side of `swing`, and its arc.
function drawLeaf(add, [ax, ay], [bx, by], swing, tone) {
  const angle = (-swing * DOOR_OPEN_DEGREES * Math.PI) / 180;
  const [dx, dy] = [bx - ax, by - ay];
  const ex = ax + dx * Math.cos(angle) - dy * Math.sin(angle);
  const ey = ay + dx * Math.sin(angle) + dy * Math.cos(angle);
  const radius = Math.hypot(dx, dy);
  add("path", { class: `plan-door-arc${tone}`, d: `M ${bx} ${by} A ${radius} ${radius} 0 0 ${swing > 0 ? 0 : 1} ${ex.toFixed(2)} ${ey.toFixed(2)}` });
  add("line", { class: `plan-door${tone}`, x1: ax, y1: ay, x2: ex.toFixed(2), y2: ey.toFixed(2) });
}

// Where the robot is, from its map (the server finds it there): asked for every few seconds
// while it's out, every minute at its base.
const robotSpots = new Map();

function robotSpot(map, index, out) {
  const known = robotSpots.get(index);
  const every = out ? 5000 : 60000;
  if (!known || (Date.now() - known.asked > every && !known.asking)) {
    const entry = { ...(known || {}), asked: Date.now(), asking: true };
    robotSpots.set(index, entry);
    fetch(`/api/plan/${index}/robot`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { at: null }))
      .then(({ at }) => robotSpots.set(index, { at, asked: Date.now(), asking: false }))
      .catch(() => robotSpots.set(index, { ...entry, asking: false }));
  }
  return known && known.at ? mapToPlan(map, known.at) : null;
}

// A point of the vacuum's map (pixels) on the plan: the same turn and stretch as its path.
function mapToPlan(map, [px, py]) {
  const [x0, y0, x1, y1] = map.box;
  const [X, Y, W, H] = map.to;
  const turned = map.rotate % 180 !== 0;
  const dx = (px - (x0 + x1) / 2) * ((turned ? H : W) / (x1 - x0));
  const dy = (py - (y0 + y1) / 2) * ((turned ? W : H) / (y1 - y0));
  const angle = (map.rotate * Math.PI) / 180;
  return [X + W / 2 + dx * Math.cos(angle) - dy * Math.sin(angle), Y + H / 2 + dx * Math.sin(angle) + dy * Math.cos(angle)];
}

// A little robot vacuum seen from above: the round body, its laser turret, the button and its side
// brush (on the left). "out" in the accent colour, "home" (stopped) dimmer, "stuck" blinking in red.
const VACUUM_SIZE = 0.5; // of the first drawing, which was too big

function drawVacuum(add, [x, y], mode) {
  const look = `plan-vacuum plan-vacuum-${mode}`;
  const k = VACUUM_SIZE;
  add("circle", { class: `${look} plan-vacuum-body`, cx: x, cy: y, r: 2.3 * k });
  add("circle", { class: `${look} plan-vacuum-ring`, cx: x, cy: y, r: 1.55 * k });
  add("circle", { class: `${look} plan-vacuum-dot`, cx: x, cy: y - 0.75 * k, r: 0.7 * k });
  add("circle", { class: `${look} plan-vacuum-dot`, cx: x, cy: y + 1.05 * k, r: 0.28 * k });
  add("line", { class: `${look} plan-vacuum-brush`, x1: x - 1.7 * k, y1: y - 1.6 * k, x2: x - 2.9 * k, y2: y - 2.5 * k });
  add("line", { class: `${look} plan-vacuum-brush`, x1: x - 1.7 * k, y1: y - 1.6 * k, x2: x - 1.9 * k, y2: y - 3.0 * k });
}

// The robot vacuum's path, out of its own map (the server keeps only the path, cut to the house's
// `box`): that box turned `rotate` degrees and stretched over `to` on the plan, in the accent colour.
function drawPlanPath(svg, map, index) {
  const ns = "http://www.w3.org/2000/svg";
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const [x0, y0, x1, y1] = map.box;
  const [X, Y, W, H] = map.to;
  const turned = map.rotate % 180 !== 0;
  const sx = (turned ? H : W) / (x1 - x0), sy = (turned ? W : H) / (y1 - y0);
  const transform = `translate(${X + W / 2} ${Y + H / 2}) rotate(${map.rotate}) scale(${sx} ${sy}) translate(${-(x0 + x1) / 2} ${-(y0 + y1) / 2})`;
  const tint = `plan-path-${index}`;
  const filter = make("filter", { id: tint, x: 0, y: 0, width: 1, height: 1 });
  filter.append(
    make("feFlood", { "flood-color": getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() }),
    make("feComposite", { in2: "SourceAlpha", operator: "in" }));
  const defs = make("defs", {});
  defs.append(filter);
  const group = make("g", { class: "plan-path", transform });
  group.append(make("image", {
    href: `/api/plan/${index}/map?v=${Math.floor(Date.now() / PLAN_PATH_MS)}`,
    x: x0, y: y0, width: x1 - x0, height: y1 - y0, preserveAspectRatio: "none", filter: `url(#${tint})`,
  }));
  svg.append(defs, group);
}

function drawSunPath(readings, path) {
  const value = (role) => (readings[role] && !readings[role].error ? `${readings[role].value}${readings[role].unit}` : "");
  const W = 300, top = 10, bottom = 82;
  // The summer solstice's top close to the top edge: the room above it was wasted, and the curves
  // (and their labels) spread over the whole height.
  const moon = path.moon;
  const highest = Math.max(...path.summer.map(([, e]) => e), ...(moon ? moon.today.map(([, e]) => e) : []));
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
  // The Moon's curve, only while it's up, with the times it rises and sets under the horizon: those
  // near noon pushed aside, off the winter solstice's label.
  if (moon) {
    for (const points of above(moon.today)) add("polyline", { class: "moon-path", points });
    const winterNoon = x(path.winter.reduce((best, point) => (point[1] > best[1] ? point : best))[0]);
    for (const minute of [moon.rise, moon.set]) {
      if (minute === null || minute === undefined) continue;
      let [at, anchor] = [x(minute), minute < 60 ? "start" : minute > 1380 ? "end" : "middle"];
      if (Math.abs(at - winterNoon) < 55) [at, anchor] = at < winterNoon ? [winterNoon - 27, "end"] : [winterNoon + 27, "start"];
      add("text", { x: at.toFixed(1), y: y(0) + 10, "text-anchor": anchor, class: "faint small" }, `☾ ${clock(minute)}`);
    }
  }
  add("polyline", { class: "night-path", points: line(path.today, () => true) });
  for (const points of above(path.today)) add("polyline", { class: "travelled", points });
  // The solstices' highest points, labelled: summer's over its curve; winter's under the horizon at
  // noon, where nothing else is (between its curve and today's there's no room).
  for (const [curve, name, under] of [[path.summer, "21/6", false], [path.winter, "21/12", true]]) {
    const [m, e] = curve.reduce((best, point) => (point[1] > best[1] ? point : best));
    add("text", { x: x(m), y: under ? y(0) + 10 : y(e) - 3, "text-anchor": "middle", class: "faint small" }, `${name} ${Math.round(e)}°`);
  }
  // The Moon now, as it's lit, under the Sun if they meet.
  if (moon) drawMoonShape(add, x(path.now), y(moon.height), 5, moon.lit, moon.waxing, moon.height < 0);
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

// "HH:MM" for a minute of the day.
function clock(minute) {
  const whole = Math.round(minute) % 1440;
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

// The Moon as it looks: its dark disc and, over it, the part the Sun lights (on the right while it
// waxes, as seen from the north), bounded by the half-ellipse of the line between day and night.
function drawMoonShape(add, cx, cy, r, lit, waxing, below) {
  const look = below ? "moon below" : "moon";
  add("circle", { class: `${look} moon-dark`, cx: cx.toFixed(1), cy: cy.toFixed(1), r });
  if (lit < 0.01) return;
  if (lit > 0.99) {
    add("circle", { class: `${look} moon-lit`, cx: cx.toFixed(1), cy: cy.toFixed(1), r });
    return;
  }
  const rx = (r * Math.abs(1 - 2 * lit)).toFixed(2);
  const [top, bottom] = [`${cx.toFixed(1)},${(cy - r).toFixed(1)}`, `${cx.toFixed(1)},${(cy + r).toFixed(1)}`];
  const outer = waxing ? 1 : 0;
  const inner = (lit < 0.5) === waxing ? 0 : 1;
  add("path", { class: `${look} moon-lit`, d: `M ${top} A ${r} ${r} 0 0 ${outer} ${bottom} A ${rx} ${r} 0 0 ${inner} ${top} Z` });
}

// Venus around the Sun, seen from above and very small: its orbit with Venus always on the right,
// and a thin line from the Sun's centre to the Earth that turns like a clock's hand as they go round
// (counterclockwise, as seen from the north). The Earth on the right too is a conjunction.
function drawVenus({ venus, earth }) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "venus-orbits");
  svg.setAttribute("viewBox", "-50 -50 100 100");
  const add = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    for (const [name, v] of Object.entries(attrs)) node.setAttribute(name, v);
    svg.append(node);
  };
  const scale = 44;
  const angle = ((earth[0] - venus[0]) * Math.PI) / 180;
  const [ex, ey] = [earth[1] * scale * Math.cos(angle), -earth[1] * scale * Math.sin(angle)];
  add("circle", { class: "orbit", cx: 0, cy: 0, r: (venus[1] * scale).toFixed(1) });
  add("line", { class: "hand", x1: 0, y1: 0, x2: ex.toFixed(1), y2: ey.toFixed(1) });
  add("circle", { class: "planet", cx: (venus[1] * scale).toFixed(1), cy: 0, r: 8 });
  return svg;
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
  if (state && (unseenAlerts().length || pendingPaths().length)) items.push(key("v", "VISTO", true));
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
  roomChooser = null;
  render();
}

function acknowledge() {
  for (const { panel, part } of allAlerts()) seen.add(alertKey(panel, part));
  save("marianne.seen", [...seen]);
  // Only the last few: one per vacuum is enough.
  seenPaths = new Set([...seenPaths, ...pendingPaths()].slice(-20));
  save("marianne.paths", [...seenPaths]);
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
  if (Object.hasOwn(ARROWS, key) || (key === "enter" && (cursor || reader || roomChooser)) || key === "f1" || MONTH_KEYS[key]) event.preventDefault();
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
  // In the heating's window, ← → turn the boiler's dial.
  if ((key === "arrowleft" || key === "arrowright") && popup !== null) {
    const view = panelViews().find((v) => v.index === popup);
    if (view && turnDial(view, key === "arrowright" ? 1 : -1)) return;
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
  // Choosing rooms: their numbers tick them, P the passes, Enter cleans, Q goes back.
  if (roomChooser && popup === roomChooser.panel) {
    if (/^[1-9]$/.test(key) && roomChooser.rooms[Number(key) - 1]) return toggleRoom(roomChooser.rooms[Number(key) - 1]);
    if (key === "p") return nextRepeat();
    if (key === "enter") return cleanChosenRooms();
    if (key === "escape") return closeRoomChooser();
    return;
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
  if (!ipod.library) {
    drawIpod();
    await loadLibrary();
  }
  restoreIpod();
  drawIpod();
}

// Minimised, the music goes on (the status bar says what's playing, and opens it again).
function minimizeIpod() {
  ipod.open = false;
  drawIpod();
  render();
}

// Closed for good: the music stops and nothing is left in the status bar.
function closeIpod() {
  rememberIpod();
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
  loadTrack(index);
  player.play().catch(() => {});
  rememberIpod();
  drawIpod();
  renderStatus();
}

// A song of the queue in the player, without playing it yet.
function loadTrack(index) {
  ipod.at = index;
  // The stars being given were for the song before.
  ipod.rating = null;
  const track = currentTrack();
  player.src = `/api/music/${ipod.source}/track/${track.id}`;
  if ("mediaSession" in navigator) {
    // On a phone's lock screen and the computer's media keys, with the album's picture (not on
    // the iPod's own screen).
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title, artist: track.artist, album: track.album.title,
      artwork: [{ src: new URL(coverUrl(track.album), location.href).href }],
    });
  }
}

// ---- what was playing, for next time

// Like an iPod, it remembers in this browser what was playing (the list, the song, where in it,
// and the volume): opened again, even after reloading the page or closing it with Q, it's on that
// song, paused at that second.
const IPOD_MEMORY = "marianne.ipod";
const REMEMBER_EVERY_MS = 5000;
let rememberedAt = 0;

function rememberIpod() {
  if (!ipod.source || ipod.at < 0) return;
  rememberedAt = Date.now();
  save(IPOD_MEMORY, { source: ipod.source, queue: ipod.queue, at: ipod.at, time: player.currentTime, volume: player.volume });
}

function restoreIpod() {
  const memory = load(IPOD_MEMORY, null);
  if (!memory || memory.source !== ipod.source || !ipod.library || ipod.at >= 0) return;
  if (typeof memory.volume === "number") player.volume = Math.max(0, Math.min(1, memory.volume));
  // Without the songs that are no longer in the folder.
  const id = (memory.queue || [])[memory.at];
  const queue = (memory.queue || []).filter((track) => ipod.library.byId.has(track));
  const at = queue.indexOf(id);
  if (at < 0) return;
  ipod.queue = queue;
  loadTrack(at);
  const time = Number(memory.time) || 0;
  player.addEventListener("loadedmetadata", () => { player.currentTime = Math.min(time, player.duration || time); }, { once: true });
  ipod.stack = [rootMenu(), nowPlaying()];
}

addEventListener("pagehide", rememberIpod);
document.addEventListener("visibilitychange", () => { if (document.hidden) rememberIpod(); });

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
player.addEventListener("timeupdate", () => {
  drawProgress();
  if (Date.now() - rememberedAt > REMEMBER_EVERY_MS) rememberIpod();
});
player.addEventListener("pause", rememberIpod);
player.addEventListener("volumechange", rememberIpod);
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

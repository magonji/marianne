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
let reader = null; // the story open in the reader: its reading and the title of its panel
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
  document.getElementById("clock-digits").textContent = `${pad(now.getHours())}${colon}${pad(now.getMinutes())}`;
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
  document.getElementById("pomodoro-digits").textContent = time;
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
  // Every row the same height, like the terminal grid.
  const cells = views.reduce((sum, { panel }) => sum + panel.span * panel.rows, 0);
  grid.style.gridTemplateRows = `repeat(${Math.max(1, Math.ceil(cells / layout.columns))}, minmax(0, 1fr))`;
  grid.replaceChildren(...views.map(drawPanel));
}

function renderPopup() {
  const box = document.getElementById("popup");
  box.hidden = popup === null && !reader;
  if (reader) {
    // Drawn once: rebuilding it every second would throw away how far it has been scrolled.
    if (box.dataset.reader !== reader.reading.link) box.replaceChildren(drawReader());
    box.dataset.reader = reader.reading.link;
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
      el("div", { class: "rule" }),
      el("a", { class: "reader-link", href: reading.link, target: "_blank", rel: "noopener noreferrer" },
        `[↵] ${upper("Leer en la web")}  ${address}`)));
}

function openReader(panel, reading) {
  reader = { reading, title: panel.title };
  cursor = reading.link;
  render();
}

function closeReader() {
  reader = null;
  render();
}

function drawPanel(view) {
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

  const shown = data.readings.filter((reading) => !reading.hidden);
  if (!shown.length) {
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
      body.append(drawRow(panel, reading, { labelWidth, valueWidth }));
    }
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
    return el(tag, { class: `tile ${styleClass(reading)}${blinking ? " blinking-icon" : ""}`, title: `${reading.label}: ${reading.value}`, ...link },
      el("span", { class: "icon" }, icon),
      el("span", { class: "name" }, upper(reading.label)),
      el("span", { class: `${styleClass(reading)}${blinking ? " blinking" : ""}` }, reading.value));
  }));
}

function drawBig(panel, reading) {
  const blinking = reading.alert && !seen.has(alertKey(panel, reading));
  const number = el("div", { class: `number ${styleClass(reading)}${blinking ? " blinking" : ""}` }, `${reading.value}${reading.unit}`);
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
    el("div", { class: "caption" }, upper(reading.label), reading.note ? `  ${reading.note}` : ""));
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
  for (const source of (state && state.sources) || []) {
    const mark = source.ok === null ? "◌" : source.ok ? "■" : "✖";
    const cls = source.ok === null ? " waiting-source" : source.ok ? "" : " bad";
    items.push(el("span", { class: `source${cls}` }, `${mark} ${source.name.toUpperCase()}`));
  }
  // A click on one of these does the same as pressing its key (see the listener on #status).
  const key = (letter, text, flashing = false) =>
    el("button", { class: flashing ? "flashing" : null, "data-key": letter }, `[${KEY_NAMES[letter] || letter.toUpperCase()}]${text}`);
  items.push(key("r", "REFRESCAR"));
  items.push(key("t", "TEMA"));
  if (state && unseenAlerts().length) items.push(key("a", "VISTO", true));
  for (const pomodoro of layout.pomodoros) {
    const running = state && state.pomodoro && state.pomodoro.running;
    items.push(key(pomodoro.start_key, running ? "PAUSAR" : "POMODORO"));
    items.push(key(pomodoro.reset_key, "REINICIAR"));
  }
  for (const view of panelViews()) {
    if (view.panel.page_key && !view.panel.key) items.push(key(view.panel.page_key, upper(view.panel.title)));
  }
  for (const view of panelViews()) {
    if (!view.panel.key) continue;
    // A hidden panel with new alerts: the menu entry flashes so it isn't missed.
    const fresh = view.data.readings.some((reading) => parts(reading).some((part) => part.alert && !seen.has(alertKey(view.panel, part))));
    items.push(key(view.panel.key, upper(view.panel.title) + (fresh ? "!" : ""), fresh));
  }
  if (reader) items.push(key("enter", "LEER EN LA WEB"), key("escape", "CERRAR"));
  else if (cursor) items.push(key("enter", "ABRIR"), key("escape", "SALIR"));
  if (!audio || audio.state !== "running") items.push(el("span", {}, "♪ PULSA UNA TECLA PARA ACTIVAR EL SONIDO"));
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
  const key = event.key.toLowerCase();
  // The arrows move the link cursor instead of scrolling; Enter opens its link, not a focused button.
  if (Object.hasOwn(ARROWS, key) || (key === "enter" && (cursor || reader))) event.preventDefault();
  press(key);
}

// A key, typed or clicked in the status bar.
function press(key) {
  unlockAudio();
  noticeFlashUntil = 0;
  if (reader) {
    // In the reader: up and down scroll the story, Enter goes to the web, Esc closes it.
    if (key === "enter") return void window.open(reader.reading.link, "_blank", "noopener");
    if (key === "escape") return closeReader();
    if (Object.hasOwn(ARROWS, key)) {
      const box = document.querySelector("#popup .panel > .body");
      if (box) box.scrollBy(0, ARROWS[key][1] * 4 * parseFloat(getComputedStyle(box).lineHeight || "20"));
      return;
    }
  }
  if (Object.hasOwn(ARROWS, key)) return moveCursor(ARROWS[key]);
  if (key === "enter" && cursor) {
    const link = visibleLinks().find((node) => node.getAttribute("href") === cursor);
    if (link && link.dataset.reader) return link.click();
    return void window.open(cursor, "_blank", "noopener");
  }
  if (key === "escape" && cursor) {
    cursor = null;
    return render();
  }
  if (key === "escape" && popup !== null) return togglePopup(popup);
  if (key === "r") return post("/api/reload");
  if (key === "t") return nextTheme();
  if (key === "a") return acknowledge();
  for (const pomodoro of layout.pomodoros) {
    if (key === pomodoro.start_key) return post(`/api/pomodoro/${pomodoro.name}/toggle`);
    if (key === pomodoro.reset_key) return post(`/api/pomodoro/${pomodoro.name}/reset`);
  }
  layout.panels.forEach((panel, index) => {
    if (panel.key === key) togglePopup(index);
    else if (panel.page_key === key) nextPage(index);
  });
  render();
}

// ---------------------------------------------------------------- link cursor

const ARROWS = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] };
const KEY_NAMES = { enter: "↵", escape: "ESC" };

// The links that can be seen: those of the open pop-up, or else of the grid, and not cut off by a panel.
function visibleLinks() {
  const root = document.getElementById(popup !== null ? "popup" : "panels");
  return [...root.querySelectorAll("a[href]")].filter((link) => {
    const box = link.getBoundingClientRect();
    const body = link.closest(".body");
    if (!box.width || !box.height || !body) return Boolean(box.width && box.height);
    const area = body.getBoundingClientRect();
    return box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
  });
}

// To the nearest link in that direction, measured between edges: a list of headlines (all starting
// at the same left edge) is entered at the top. The distance across counts double, and is zero while
// the two overlap, so a column of headlines or of icons is followed straight down.
function moveCursor([dx, dy]) {
  const links = visibleLinks();
  const current = links.find((link) => link.getAttribute("href") === cursor);
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
  cursor = target.getAttribute("href");
  render();
  target = visibleLinks().find((link) => link.getAttribute("href") === cursor);
  if (target) target.scrollIntoView({ block: "nearest" });
}

// Panels are drawn again every second: put the cursor back on its link, or drop it if it's gone.
function renderCursor() {
  if (!cursor) return;
  const link = visibleLinks().find((node) => node.getAttribute("href") === cursor);
  if (link) link.classList.add("cursor");
  else {
    cursor = null;
    renderStatus();
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
  if (reader) closeReader();
  else togglePopup(popup);
});
addEventListener("pointerdown", unlockAudio);
start();

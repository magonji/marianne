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
  box.hidden = popup === null;
  if (popup === null) return;
  box.replaceChildren(drawPanel(panelViews()[popup]));
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
  }, labelText(reading));
  const values = el("span", { class: "values" }, drawValue(panel, reading, wide ? widths.valueWidth : 0));
  for (const extra of reading.extra || []) values.append("  ", drawValue(panel, extra, 0));
  return el("div", { class: `row${wide ? " wide" : ""}` }, label, wide ? null : el("span", { class: "leader" }), values);
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
  const key = (letter, text, action, flashing = false) =>
    el("button", { class: flashing ? "flashing" : null, onclick: action }, `[${letter.toUpperCase()}]${text}`);
  items.push(key("r", "REFRESCAR", () => post("/api/reload")));
  items.push(key("t", "TEMA", nextTheme));
  if (state && unseenAlerts().length) items.push(key("a", "VISTO", acknowledge, true));
  for (const pomodoro of layout.pomodoros) {
    const running = state && state.pomodoro && state.pomodoro.running;
    items.push(key(pomodoro.start_key, running ? "PAUSAR" : "POMODORO", () => post(`/api/pomodoro/${pomodoro.name}/toggle`)));
    items.push(key(pomodoro.reset_key, "REINICIAR", () => post(`/api/pomodoro/${pomodoro.name}/reset`)));
  }
  for (const view of panelViews()) {
    if (view.panel.page_key && !view.panel.key) items.push(key(view.panel.page_key, upper(view.panel.title), () => nextPage(view.index)));
  }
  for (const view of panelViews()) {
    if (!view.panel.key) continue;
    // A hidden panel with new alerts: the menu entry flashes so it isn't missed.
    const fresh = view.data.readings.some((reading) => parts(reading).some((part) => part.alert && !seen.has(alertKey(view.panel, part))));
    items.push(key(view.panel.key, upper(view.panel.title) + (fresh ? "!" : ""), () => togglePopup(view.index), fresh));
  }
  if (!audio || audio.state !== "running") items.push(el("span", {}, "♪ PULSA UNA TECLA PARA ACTIVAR EL SONIDO"));
  items.push(el("span", { class: "ready" }, "READY"));
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
  unlockAudio();
  noticeFlashUntil = 0;
  const key = event.key.toLowerCase();
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
// A click outside the pop-up panel closes it.
document.getElementById("popup").addEventListener("click", (event) => {
  if (event.target.id === "popup") togglePopup(popup);
});
addEventListener("pointerdown", unlockAudio);
start();

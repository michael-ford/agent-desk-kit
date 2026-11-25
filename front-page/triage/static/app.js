// Intake triage: front end. No build, no dependencies.
import { VoiceSession } from "/voice-session.js";
import { TalkController } from "/talk.js";

const $ = (sel, root = document) => root.querySelector(sel);
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("intake." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem("intake." + k, JSON.stringify(v)); } catch {} },
};

const state = {
  files: [],
  data: null,
  file: null,
  loadedAt: Date.now(),
  vaultName: "vault",
  phase: LS.get("phase", "action"),   // "action" | "awareness"
  view: LS.get("view2", "one"),        // action phase: "one" | "list"
  group: LS.get("group", "project"),
  board: "all",
  project: "all",
  source: "all",
  showSnoozed: LS.get("showSnoozed", false),
  showResolved: false,
  sel: null,          // { raw, occurrence } of the selected item
  awOpen: false,      // awareness: is the selected row expanded
  composer: null,     // { kind, key }
  busy: false,
  justAnswered: new Set(),
  talkFocus: null,    // "i12": the item the talk-through is on
  needsRender: false,
};

// ------------------------------------------------------------------ api

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (method !== "GET") opts.headers["X-Intake-Triage"] = "1";
  if (body !== undefined) {
    if (body instanceof Blob) { opts.body = body; }
    else { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw Object.assign(new Error("Can't reach the triage server. Is run.sh still running?"), { offline: true }); }
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) {
    throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { conflict: !!json.conflict, status: res.status });
  }
  return json;
}

// ------------------------------------------------------------------ dates

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const parseISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toISO = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const fmtShort = (d) => `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const fmtLong = (d) => `${LONG_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]}`;
const fmtStamp = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;

function snoozeChoices(todayISO) {
  const t = parseISO(todayISO);
  let mon = addDays(t, 1);
  while (mon.getUTCDay() !== 1) mon = addDays(mon, 1);
  return [
    { key: "1", label: "Tomorrow", date: addDays(t, 1) },
    { key: "2", label: "Monday", date: mon },
    { key: "3", label: "Next week", date: addDays(t, 7) },
  ];
}

// "2026-10-24 09:02 PT" -> "09:02" today, "Oct 23, 09:02" otherwise
function noteTime(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/.exec(stamp || "");
  if (!m) return stamp || "";
  return m[1] === state.data.today ? m[2] : `${fmtStamp(parseISO(m[1]))}, ${m[2]}`;
}

// ------------------------------------------------------------------ inline markdown

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function renderInline(src) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, anchor, alias) => {
    const url = `obsidian://open?vault=${encodeURIComponent(state.vaultName)}&file=${encodeURIComponent(target.trim())}`;
    return hold(`<a class="wikilink" href="${esc(url)}">${esc((alias || target + (anchor || "")).trim())}</a>`);
  });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>`));
  s = s.replace(/https?:\/\/[^\s<>()\u0000]+[^\s<>()\u0000.,;:!?'"]/g, (u) => {
    const pretty = u.replace(/^https?:\/\/(www\.)?/, "").replace(/(.{48}).+/, "$1…");
    return hold(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(pretty)}</a>`);
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
}

const plain = (s) => (s || "").replace(/\*\*/g, "").replace(/`/g, "");

// ------------------------------------------------------------------ derived

const keyOf = (it) => `${it.occurrence}\u0001${it.raw}`;
const isSnoozed = (it) => !it.checked && it.snoozedUntil && it.snoozedUntil > state.data.today;
const isOpen = (it) => !it.checked && !isSnoozed(it);

function baseFilter(it, skip) {
  if (it.checked && !state.showResolved) return false;
  if (isSnoozed(it) && !state.showSnoozed) return false;
  if (skip !== "board" && state.board !== "all" && (it.board || "none") !== state.board) return false;
  if (skip !== "project" && state.project !== "all" && (it.projectKey || "none") !== state.project) return false;
  if (skip !== "source" && state.source !== "all" && (it.sourceKind || "none") !== state.source) return false;
  return true;
}
const inPhase = (it) => it.kind === state.phase;
const talkOn = (it) => state.talkFocus !== null && state.talkFocus === `i${it.id}`;

function projectLabels(items) {
  const counts = new Map();
  for (const it of items) {
    const k = it.projectKey || "none";
    if (!counts.has(k)) counts.set(k, new Map());
    const m = counts.get(k);
    const label = it.project || "No project";
    m.set(label, (m.get(label) || 0) + 1);
  }
  const labels = new Map();
  for (const [k, m] of counts) labels.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return labels;
}

// Order groups by how many items the whole page has for them (resolved included),
// so a group doesn't jump around the screen as you work through it.
function pageWeights(field) {
  const w = new Map();
  for (const it of state.data.items) { const k = it[field] || "none"; w.set(k, (w.get(k) || 0) + 1); }
  return w;
}

const AGE_BUCKETS = [
  { max: 0, label: "Today" },
  { max: 2, label: "A day or two" },
  { max: 6, label: "This week" },
  { max: Infinity, label: "A week or more" },
];

function groupItems(items, g = state.group) {
  if (g === "none") return [{ key: "all", label: null, items }];
  const labels = projectLabels(state.data.items);
  const groups = new Map();
  for (const it of items) {
    let k, label;
    if (g === "project") { k = it.projectKey || "none"; label = labels.get(k); }
    else if (g === "board") { k = it.board || "none"; label = { ME: "ME: the owner's hands", AGENT: "AGENT: the assistant's board", "n/a": "No board (n/a)", none: "Unboarded" }[k]; }
    else if (g === "source") { k = it.sourceKind || "none"; label = k === "none" ? "No source" : cap(k); }
    else if (g === "section") { k = [it.section, it.subsection].filter(Boolean).join(" · ") || "none"; label = k === "none" ? "Top of page" : k; }
    else if (g === "age") { const i = AGE_BUCKETS.findIndex((b) => it.age <= b.max); k = String(i); label = AGE_BUCKETS[i].label; }
    if (!groups.has(k)) groups.set(k, { key: k, label, items: [] });
    groups.get(k).items.push(it);
  }
  let out = [...groups.values()];
  if (g === "project" || g === "source") {
    const w = pageWeights(g === "project" ? "projectKey" : "sourceKind");
    out.sort((a, b) => (a.key === "none") - (b.key === "none") || (w.get(b.key) || 0) - (w.get(a.key) || 0) || a.label.localeCompare(b.label));
  }
  if (g === "board") { const order = ["ME", "AGENT", "n/a", "none"]; out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)); }
  if (g === "age") out.sort((a, b) => +b.key - +a.key);
  if (g === "age") for (const grp of out) grp.items.sort((a, b) => b.age - a.age);
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function visible() {
  if (!state.data) return { groups: [], flat: [] };
  const items = state.data.items.filter((it) => inPhase(it) && baseFilter(it));
  const groups = groupItems(items, state.phase === "awareness" ? "project" : state.group);
  return { groups, flat: groups.flatMap((g) => g.items) };
}

function selectedItem(flat) {
  if (!state.sel) return null;
  return flat.find((it) => it.raw === state.sel.raw && it.occurrence === state.sel.occurrence) || null;
}

function ensureSelection(flat, fallbackIndex = 0) {
  if (!flat.length) { state.sel = null; return null; }
  let it = selectedItem(flat);
  if (!it) {
    it = flat[Math.max(0, Math.min(fallbackIndex, flat.length - 1))];
    state.sel = { raw: it.raw, occurrence: it.occurrence };
  }
  return it;
}

// ------------------------------------------------------------------ render helpers

const icon = (id) => {
  const src = document.getElementById("icons").content.getElementById(id);
  const svg = src.cloneNode(true);
  svg.removeAttribute("id");
  svg.setAttribute("aria-hidden", "true");
  return svg;
};

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  return n;
}

const SVGNS = "http://www.w3.org/2000/svg";
function leafMotif(cls = "leaf-motif") {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 200 200");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVGNS, "use");
  use.setAttribute("href", "#monstera");
  use.setAttribute("width", "200"); use.setAttribute("height", "200");
  svg.append(use);
  return svg;
}

// ------------------------------------------------------------------ the growing plant

const PLANT_LEAVES = [
  // [x, y, angle, side] along the stem, bottom to top
  [40, 86, -20, 1], [40, 79, 200, -1], [41, 71, -28, 1], [40, 63, 208, -1], [41, 55, -32, 1],
  [41, 47, 212, -1], [41, 39, -36, 1], [42, 31, 216, -1], [43, 23, -40, 1], [44, 15, 220, -1],
];
function buildPlant(host) {
  const leaves = PLANT_LEAVES.map(([x, y, a], i) =>
    `<g transform="translate(${x} ${y}) rotate(${a})"><path class="pl-leaf" style="--i:${i}" d="M0 0C5-7 16-9 23-3 16 3 6 4 0 0z"/></g>`).join("");
  host.innerHTML = `<svg viewBox="0 0 80 112" class="plant" aria-hidden="true">
    <path class="pl-stem" pathLength="100" d="M40 94C38 76 44 62 41 46 39 34 42 22 45 8"/>
    ${leaves}
    <path class="pl-pot" d="M24 92h32l-4 18H28z"/><rect class="pl-rim" x="21" y="89" width="38" height="6" rx="2"/>
  </svg>`;
}
function updatePlant(host, frac) {
  if (!host.firstElementChild) buildPlant(host);
  // A sprout with two seed leaves to start; one more leaf per tenth of the queue cleared.
  const n = 2 + Math.round(frac * (PLANT_LEAVES.length - 2));
  host.querySelectorAll(".pl-leaf").forEach((p, i) => p.classList.toggle("grown", i < n));
  host.querySelector(".pl-stem").style.strokeDashoffset = String(100 - Math.max(22, frac * 100));
}

// ------------------------------------------------------------------ chrome

function phaseCounts() {
  const d = state.data;
  const pool = d.items.filter((it) => !it.checked && (state.showSnoozed || !isSnoozed(it)) && baseFilter(it));
  return { action: pool.filter((it) => it.kind === "action").length, awareness: pool.filter((it) => it.kind === "awareness").length };
}

function renderChrome() {
  const d = state.data;
  const fd = parseISO(d.date);
  const diff = Math.round((parseISO(d.today) - fd) / 86400000);
  const when = diff === 0 ? "today" : diff === 1 ? "yesterday" : `${diff} days ago`;
  $("#subtitle").textContent = `${fmtLong(fd)} · ${when}`;
  document.title = `Intake · ${fmtShort(fd)}`;

  const sel = $("#file-select");
  const yday = toISO(addDays(parseISO(d.today), -1));
  sel.replaceChildren(...state.files.map((f) => {
    const dd = parseISO(f.date);
    const rel = f.date === d.today ? "Today, " : f.date === yday ? "Yesterday, " : "";
    const label = rel ? `${rel}${dd.getUTCDate()} ${MONTHS[dd.getUTCMonth()]}` : fmtShort(dd);
    return el("option", { value: f.name, selected: f.name === d.file }, label + (dd.getUTCFullYear() !== parseISO(d.today).getUTCFullYear() ? " " + dd.getUTCFullYear() : ""));
  }));

  // phases
  const pc = phaseCounts();
  for (const p of ["action", "awareness"]) {
    const b = $(`#phase-${p}`);
    b.setAttribute("aria-selected", String(state.phase === p));
    b.tabIndex = state.phase === p ? 0 : -1;
    b.querySelector(".n").textContent = pc[p];
  }
  const acts = d.items.filter((it) => it.kind === "action");
  const cleared = acts.filter((it) => it.checked).length;
  updatePlant($("#plant"), acts.length ? cleared / acts.length : 1);
  $("#plant-caption").textContent = acts.length ? `${cleared} of ${acts.length} actions cleared` : "No actions on this page";

  const isAction = state.phase === "action";
  $("#view-seg").hidden = !isAction;
  $("#view-list").setAttribute("aria-pressed", state.view === "list");
  $("#view-one").setAttribute("aria-pressed", state.view === "one");
  $("#group-select").value = state.group;
  $("#group-field").hidden = !isAction || state.view === "one";

  const open = d.items.filter((it) => !it.checked && inPhase(it));
  $("#snoozed-count").textContent = open.filter(isSnoozed).length;
  $("#resolved-count").textContent = d.items.filter((it) => it.checked && inPhase(it)).length;
  $("#show-snoozed").checked = state.showSnoozed;
  $("#show-resolved").checked = state.showResolved;

  // board chips
  const boardPool = d.items.filter((it) => inPhase(it) && baseFilter(it, "board"));
  const bc = (k) => boardPool.filter((it) => (it.board || "none") === k).length;
  const boards = [["all", "All", boardPool.length], ["ME", "ME", bc("ME")], ["AGENT", "AGENT", bc("AGENT")], ["n/a", "n/a", bc("n/a")]];
  if (bc("none")) boards.push(["none", "Unboarded", bc("none")]);
  $("#board-chips").replaceChildren(...boards.map(([k, label, n]) =>
    el("button", { type: "button", class: "chip", "aria-pressed": state.board === k, onclick: () => { state.board = k; state.sel = null; render(); } },
      label, el("span", { class: "n" }, String(n)))));

  // projects: rail and select
  const projPool = d.items.filter((it) => inPhase(it) && baseFilter(it, "project"));
  const labels = projectLabels(d.items);
  const pcount = new Map();
  for (const it of projPool) pcount.set(it.projectKey || "none", (pcount.get(it.projectKey || "none") || 0) + 1);
  if (state.project !== "all" && !pcount.has(state.project)) pcount.set(state.project, 0);
  const pw = pageWeights("projectKey");
  const projs = [...pcount.entries()].sort((a, b) => (a[0] === "none") - (b[0] === "none") || (pw.get(b[0]) || 0) - (pw.get(a[0]) || 0) || (labels.get(a[0]) || a[0]).localeCompare(labels.get(b[0]) || b[0]));
  const setProject = (k) => { state.project = k; state.sel = null; render(); };
  $("#project-index").replaceChildren(
    el("li", {}, el("button", { type: "button", "aria-current": state.project === "all", onclick: () => setProject("all") }, "Everything", el("span", { class: "n" }, String(projPool.length)))),
    ...projs.map(([k, n]) => el("li", {}, el("button", { type: "button", "aria-current": state.project === k, onclick: () => setProject(k) },
      el("span", {}, labels.get(k) || k), el("span", { class: "n" }, String(n))))));
  $("#project-select").replaceChildren(
    el("option", { value: "all" }, `All (${projPool.length})`),
    ...projs.map(([k, n]) => el("option", { value: k, selected: state.project === k }, `${labels.get(k) || k} (${n})`)));
  $("#project-select").value = state.project;

  // sources
  const srcPool = d.items.filter((it) => inPhase(it) && baseFilter(it, "source"));
  const sc = new Map();
  for (const it of srcPool) sc.set(it.sourceKind || "none", (sc.get(it.sourceKind || "none") || 0) + 1);
  if (state.source !== "all" && !sc.has(state.source)) sc.set(state.source, 0);
  $("#source-select").replaceChildren(
    el("option", { value: "all" }, `All (${srcPool.length})`),
    ...[...sc.entries()].sort((a, b) => (a[0] === "none") - (b[0] === "none") || b[1] - a[1]).map(([k, n]) =>
      el("option", { value: k }, `${k === "none" ? "No source" : cap(k)} (${n})`)));
  $("#source-select").value = state.source;
}

function stampFor(it) {
  if (isSnoozed(it) || (it.snoozedUntil && !it.checked)) {
    const due = parseISO(it.snoozedUntil);
    const back = it.snoozedUntil <= state.data.today;
    return el("span", { class: "stamp due", title: `Snoozed until ${fmtLong(due)}` }, back ? `Back ${fmtStamp(due)}` : `Due back ${fmtStamp(due)}`);
  }
  const o = parseISO(it.origin);
  const age = it.age;
  const bucket = age <= 1 ? "fresh" : age <= 5 ? "warm" : "old";
  const ageText = age <= 0 ? "today" : age === 1 ? "1 day" : `${age} days`;
  return el("span", { class: "stamp", "data-age": bucket, title: `First seen ${fmtLong(o)}` }, `${fmtStamp(o)} · ${ageText}`);
}

function sourceBits(it) {
  if (!it.source) return [];
  const kind = it.sourceKind || "";
  let detail = it.source.slice(kind.length).trim().replace(/^\((.*)\)$/, "$1").replace(/^[—:-]\s*/, "");
  return [el("span", { class: "src" }, kind || it.source), detail ? el("span", { class: "src-detail" }, detail) : null];
}

// ------------------------------------------------------------------ notes, questions, answers

const THINK_LIMIT = 180; // seconds before "no answer yet"

function pendingAge(it) {
  if (!it.pendingAsk) return 0;
  return (it.pendingAsk.ageSec ?? 0) + (Date.now() - state.loadedAt) / 1000;
}

function renderNotes(it) {
  const notes = it.notes || [];
  if (!notes.length) return null;
  const lastAssistant = notes.map((n) => n.who).lastIndexOf("Assistant");
  const fresh = state.justAnswered.has(keyOf(it));
  const lis = [];
  notes.forEach((n, i) => {
    if (n.kind === "question") {
      lis.push(el("li", { class: "note-ask" }, el("span", { class: "who" }, "You asked"), " ", el("span", { html: renderInline(n.text) }),
        el("span", { class: "when" }, noteTime(n.stamp))));
      if (it.pendingAsk && it.pendingAsk.index === i) {
        const slow = pendingAge(it) > THINK_LIMIT;
        lis.push(el("li", { class: `note-thinking${slow ? " is-slow" : ""}`, role: "status" },
          slow ? "No answer after 3 minutes. The assistant may be in the middle of something; its answer will show up here when it writes it."
               : el("span", {}, el("span", { class: "sprouts", "aria-hidden": "true" }, el("i"), el("i"), el("i")), "The assistant is thinking…")));
      }
    } else if (n.who === "Assistant") {
      const li = el("li", { class: `note-assistant${fresh && i === lastAssistant ? " is-new" : ""}` },
        el("span", { class: "who" }, "Assistant"), " ", el("span", { html: renderInline(n.text) }),
        n.stamp ? el("span", { class: "when" }, noteTime(n.stamp)) : null);
      if (n.resolved && !it.checked && i === lastAssistant) {
        li.append(el("span", { class: "resolve-offer" },
          el("button", { type: "button", class: "btn btn-yes", onclick: () => runAction(it, "done", { text: "" }) }, icon("i-done"), "Yes, done")));
      }
      lis.push(li);
    } else if (n.kind === "comment") {
      const toAssistant = /^→ Assistant:/.test(n.text);
      lis.push(el("li", { class: toAssistant ? "to-assistant" : "mine" }, el("span", { html: renderInline(n.text) }), el("span", { class: "when" }, noteTime(n.stamp))));
    } else {
      lis.push(el("li", { html: renderInline(n.text) }));
    }
  });
  return el("ul", { class: "margin-notes", "aria-label": "Notes" }, ...lis);
}

function kindToggle(it) {
  if (it.checked) return null;
  const to = it.kind === "action" ? "awareness" : "action";
  return el("button", { type: "button", class: "kind-toggle", title: it.kindSource === "tag" ? `Tagged #${it.kind}` : `Guessed ${it.kind}; no tag yet`,
    onclick: () => runAction(it, "reclassify", { kind: to }) },
    to === "awareness" ? "Just awareness?" : "Needs action?");
}

// ------------------------------------------------------------------ action cards

function renderCard(it, { big = false } = {}) {
  const key = keyOf(it);
  const current = state.sel && it.raw === state.sel.raw && it.occurrence === state.sel.occurrence;
  const card = el("article", {
    class: `card${isSnoozed(it) ? " is-snoozed" : ""}${it.checked ? " is-resolved" : ""}${talkOn(it) ? " talk-focus" : ""}`,
    "aria-current": current ? "true" : null,
    "data-key": key,
    tabindex: current ? "0" : "-1",
    "aria-label": (it.checked ? "Resolved: " : "") + plain(it.text).slice(0, 120),
  });
  card.addEventListener("click", (e) => {
    if (e.target.closest("a, button, textarea, input, select, .composer")) return;
    if (!current) { state.sel = { raw: it.raw, occurrence: it.occurrence }; if (state.composer && state.composer.key !== key) state.composer = null; render(); }
  });

  const meta = el("div", { class: "card-meta" },
    ...sourceBits(it),
    el("span", { class: "meta-right" },
      it.board ? el("span", { class: "board", "data-board": it.board, title: it.board === "ME" ? "the owner's board" : it.board === "AGENT" ? "the assistant's board" : "No board" }, it.board) : null,
      it.boardNote ? el("span", { class: "board-note" }, it.boardNote) : null,
      it.project ? el("span", { class: "proj" }, it.project) : null,
      stampFor(it)));
  card.append(meta);
  card.append(el("p", { class: "card-text", html: renderInline(it.text) }));

  if (it.checked && it.disposition) {
    card.append(el("p", { class: `disposition${/^dropped/.test(it.disposition) ? " dropped" : ""}`, html: renderInline(it.disposition) }));
  }
  const notes = renderNotes(it);
  if (notes) card.append(notes);

  if (!it.checked) {
    const opts = optionChips(it, key);
    if (opts) card.append(opts);
    const act = (kind) => () => openComposer(it, kind);
    card.append(el("div", { class: "actions", role: "group", "aria-label": "Actions" },
      el("button", { type: "button", class: "btn btn-primary", onclick: act("done") }, icon("i-done"), "Done", el("kbd", {}, "d")),
      el("button", { type: "button", class: "btn", onclick: act("snooze") }, icon("i-snooze"), big ? "Reschedule" : "Later", el("kbd", {}, "r")),
      el("button", { type: "button", class: "btn", onclick: act("comment") }, icon("i-comment"), "Comment", el("kbd", {}, "c")),
      el("button", { type: "button", class: "btn btn-ask", onclick: act("ask") }, icon("i-ask"), "Ask", el("kbd", {}, "a")),
      el("button", { type: "button", class: "btn btn-danger", onclick: act("drop") }, icon("i-drop"), "Drop", el("kbd", {}, "x")),
      el("button", { type: "button", class: "btn btn-assistant", onclick: act("assistant") }, icon("i-assistant"), "Assistant", el("kbd", {}, "m"))));
    card.append(el("div", { class: "card-foot" }, kindToggle(it)));
  }
  if (state.composer && state.composer.key === key) card.append(renderComposer(it));
  return card;
}

// The item's own question, answered in one tap: numbered chips above the action
// row, keys 1-9. A note already typed into an open Done composer rides along.
function optionChips(it, key) {
  if (!it.options?.length) return null;
  const pick = (option) => () => {
    const c = state.composer;
    const note = c && c.key === key && c.kind === "done" ? (c.draft || "").trim() : "";
    runAction(it, "choose", { option, text: note });
  };
  return el("div", { class: "options", role: "group", "aria-label": "Answer" },
    ...it.options.slice(0, 9).map((o, i) =>
      el("button", { type: "button", class: "btn btn-option", onclick: pick(o), title: `Done, chose "${o}"` },
        el("kbd", {}, String(i + 1)), el("span", { class: "opt-label" }, o))));
}

const COMPOSER = {
  done: { label: "Done", hint: "note, optional", placeholder: "Anything worth recording? Enter saves.", button: "Mark done", required: false },
  comment: { label: "Comment", hint: "The assistant reads these at its next sweep", placeholder: "Tell the assistant what to do with this…", button: "Save comment", required: true },
  ask: { label: "Ask the assistant", hint: "it answers right here, usually within a minute or two", placeholder: "What do you want to know about this?", button: "Ask", required: true },
  drop: { label: "Drop", hint: "reason, optional", placeholder: "Why it's not worth doing (optional)", button: "Drop it", required: false },
  assistant: { label: "Hand to the assistant", hint: "flagged → the assistant, and queued in the triage inbox", placeholder: "What should the assistant do?", button: "Hand over", required: true },
};

function renderComposer(it) {
  const kind = state.composer.kind;
  if (kind === "snooze") return renderSnooze(it);
  const cfg = COMPOSER[kind];
  const id = `composer-${Math.random().toString(36).slice(2, 8)}`;
  const ta = el("textarea", { id, rows: "2", placeholder: cfg.placeholder, "aria-describedby": `${id}-interim` });
  ta.value = state.composer.draft || "";
  const err = el("p", { class: "composer-error", id: `${id}-err`, role: "alert" });
  ta.addEventListener("input", () => {
    state.composer.draft = ta.value;
    if (ta.getAttribute("aria-invalid")) { ta.removeAttribute("aria-invalid"); err.textContent = ""; }
  });
  const interim = el("p", { class: "interim", id: `${id}-interim`, "aria-live": "polite", "data-idle": dictation.idleHint() });
  const mic = el("button", { type: "button", class: "mic", "aria-pressed": "false", "aria-label": "Dictate", title: "Dictate (Space while the field is empty)" }, icon("i-mic"));
  mic.addEventListener("click", () => dictation.toggle(ta, interim, mic));
  const submit = () => submitComposer(it, kind, ta, cfg);
  ta.addEventListener("keydown", (e) => composerKeys(e, ta, interim, mic, submit));
  ta.addEventListener("keyup", (e) => composerKeyUp(e));
  const box = el("div", { class: "composer", role: "group", "aria-label": cfg.label },
    el("label", { class: "composer-label", for: id }, cfg.label, " ", el("span", { class: "hint" }, `· ${cfg.hint}`)),
    el("div", { class: "composer-row" }, ta, mic),
    interim,
    err,
    el("div", { class: "composer-actions" },
      el("span", { class: "spacer" }),
      el("button", { type: "button", class: "btn btn-quiet", onclick: closeComposer }, "Cancel", el("kbd", {}, "esc")),
      el("button", { type: "button", class: `btn btn-primary${kind === "drop" ? " is-drop" : ""}`, onclick: submit }, cfg.button, el("kbd", {}, "↵"))));
  box._focus = () => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); };
  box._autostart = () => dictation.start(ta, interim, mic);
  return box;
}

function renderSnooze(it) {
  const choices = snoozeChoices(state.data.today);
  const custom = el("input", { type: "date", "aria-label": "Custom date", min: toISO(addDays(parseISO(state.data.today), 1)) });
  const go = (date) => runAction(it, "snooze", { date });
  const buttons = choices.map((c) => el("button", { type: "button", class: "date-btn", onclick: () => go(toISO(c.date)) },
    el("span", { class: "l" }, c.label, el("kbd", {}, c.key)), el("span", { class: "d" }, fmtShort(c.date))));
  if (it.snoozedUntil) buttons.unshift(el("button", { type: "button", class: "date-btn", onclick: () => go(state.data.today) },
    el("span", { class: "l" }, "Back today", el("kbd", {}, "0")), el("span", { class: "d" }, fmtShort(parseISO(state.data.today)))));
  custom.addEventListener("keydown", (e) => { if (e.key === "Enter" && custom.value) { e.preventDefault(); go(custom.value); } });
  const box = el("div", { class: "composer", role: "group", "aria-label": "Reschedule" },
    el("span", { class: "composer-label" }, "Reschedule ", el("span", { class: "hint" }, "· hidden until the date, still on the page")),
    el("div", { class: "dates" }, ...buttons,
      el("span", { class: "date-custom" }, custom,
        el("button", { type: "button", class: "btn btn-quiet", onclick: () => custom.value ? go(custom.value) : custom.focus() }, "Snooze"))),
    el("div", { class: "composer-actions" },
      el("button", { type: "button", class: "btn btn-quiet", onclick: closeComposer }, "Cancel", el("kbd", {}, "esc"))));
  box._focus = () => box.querySelector(".date-btn").focus();
  box._pick = (k) => {
    if (k === "0" && it.snoozedUntil) return go(state.data.today);
    const c = choices.find((x) => x.key === k);
    if (c) go(toISO(c.date));
  };
  return box;
}

function renderList(groups) {
  const wrap = el("div", { class: "groups" });
  for (const g of groups) {
    const sec = el("section", { class: "group", "aria-label": g.label || "Items" });
    if (g.label) sec.append(el("header", { class: "group-head" }, el("h2", {}, g.label), el("span", { class: "n" }, String(g.items.length))));
    sec.append(el("div", { class: "group-list" }, ...g.items.map((it) => renderCard(it))));
    wrap.append(sec);
  }
  return wrap;
}

function listenButton() {
  const on = voice.active;
  return el("button", { type: "button", class: `btn listen${on ? " is-on" : ""}`, "aria-pressed": String(on), onclick: toggleVoice,
    title: on ? "Stop listening (l)" : "Triage by voice: one tap, then talk card to card (l)" },
    icon("i-mic"), on ? "Listening" : "Talk", el("kbd", {}, "l"));
}

function renderOne(flat) {
  const it = selectedItem(flat);
  const i = flat.indexOf(it);
  const next = flat[i + 1];
  return el("div", { class: "one" },
    el("div", { class: "one-nav" },
      el("button", { type: "button", class: "btn btn-quiet", disabled: i <= 0, onclick: () => move(-1), "aria-label": "Previous item" }, icon("i-prev"), el("span", { class: "wide-only" }, "Previous"), el("kbd", {}, "←")),
      el("span", { class: "one-mid" }, el("span", { class: "one-pos", "aria-live": "polite" }, `${i + 1} of ${flat.length}`), listenButton()),
      el("button", { type: "button", class: "btn btn-quiet", onclick: () => move(1), "aria-label": i >= flat.length - 1 ? "On to awareness" : "Next item" },
        el("span", { class: "wide-only" }, i >= flat.length - 1 ? "Awareness" : "Next"), el("kbd", {}, "→"), icon("i-next"))),
    renderCard(it, { big: true }),
    next ? el("p", { class: "one-upnext" }, "Up next: ", el("span", {}, plain(next.text).slice(0, 110) + (next.text.length > 110 ? "…" : ""))) : null);
}

// ------------------------------------------------------------------ awareness digest

function renderDigest(groups) {
  const wrap = el("div", { class: "digest" },
    el("div", { class: "digest-intro" },
      el("p", {}, "Things to know about. Tap a line to open it; leave a note or ask the assistant."), listenButton()));
  for (const g of groups) {
    const sec = el("section", { class: "dgroup", "aria-label": g.label || "Items" });
    if (g.label) sec.append(el("header", { class: "group-head" }, el("h2", {}, g.label), el("span", { class: "n" }, String(g.items.length))));
    sec.append(el("ul", { class: "rows" }, ...g.items.map(renderRow)));
    wrap.append(sec);
  }
  return wrap;
}

function renderRow(it) {
  const key = keyOf(it);
  const current = state.sel && it.raw === state.sel.raw && it.occurrence === state.sel.occurrence;
  const open = current && state.awOpen;
  const hasAssistant = (it.notes || []).some((n) => n.who === "Assistant");
  const li = el("li", { class: `row${open ? " is-open" : ""}${it.checked ? " is-resolved" : ""}${isSnoozed(it) ? " is-snoozed" : ""}${talkOn(it) ? " talk-focus" : ""}`, "data-key": key, "aria-current": current ? "true" : null });
  const head = el("button", { type: "button", class: "row-head", "aria-expanded": String(!!open), tabindex: current ? "0" : "-1",
    onclick: () => {
      if (current) state.awOpen = !state.awOpen;
      else { state.sel = { raw: it.raw, occurrence: it.occurrence }; state.awOpen = true; }
      render({ focus: true });
    } },
    el("span", { class: "row-src" }, it.sourceKind || "note"),
    el("span", { class: "row-text", html: renderInline(it.text) }),
    el("span", { class: "row-flags" },
      it.pendingAsk ? el("span", { class: "flag thinking", title: "Waiting for the assistant" }, "asking") : hasAssistant ? el("span", { class: "flag assistant", title: "The assistant left a note" }, "The assistant") : null,
      it.checked ? el("span", { class: "flag" }, "done") : null,
      el("span", { class: "row-age" }, it.age <= 0 ? "today" : `${it.age}d`)));
  li.append(head);
  if (open) {
    const body = el("div", { class: "row-body" });
    body.append(el("div", { class: "card-meta" }, ...sourceBits(it), el("span", { class: "meta-right" },
      it.board ? el("span", { class: "board", "data-board": it.board }, it.board) : null, stampFor(it))));
    const notes = renderNotes(it);
    if (notes) body.append(notes);
    if (!it.checked) {
      body.append(
        inlineForm(it, "comment", "Comment", "A note for the assistant's next sweep"),
        inlineForm(it, "ask", "Ask the assistant", "What do you want to know?"),
        el("div", { class: "row-actions" },
          el("button", { type: "button", class: "btn btn-primary", onclick: () => runAction(it, "done", { text: "" }) }, icon("i-done"), "Done", el("kbd", {}, "d")),
          el("button", { type: "button", class: "btn btn-danger", onclick: () => runAction(it, "drop", { text: "" }) }, icon("i-drop"), "Drop", el("kbd", {}, "x")),
          el("span", { class: "spacer" }),
          kindToggle(it)));
    }
    li.append(body);
  }
  return li;
}

function inlineForm(it, action, label, placeholder) {
  const id = `f-${action}-${Math.random().toString(36).slice(2, 7)}`;
  const input = el("input", { id, type: "text", class: "inline-input", placeholder, autocomplete: "off", "data-action": action });
  const submit = async () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.disabled = true;
    const ok = await runAction(it, action, { text });
    if (!ok) { input.disabled = false; input.focus(); }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    if (e.key === "Escape") { e.preventDefault(); input.blur(); render({ focus: true }); }
  });
  return el("div", { class: "inline-form" },
    el("label", { for: id }, label),
    input,
    el("button", { type: "button", class: `btn btn-quiet${action === "ask" ? " btn-ask" : ""}`, onclick: submit }, action === "ask" ? "Ask" : "Save"));
}

// ------------------------------------------------------------------ empty and finished states

const inFilters = (it) => (state.board === "all" || (it.board || "none") === state.board) &&
  (state.project === "all" || (it.projectKey || "none") === state.project) &&
  (state.source === "all" || (it.sourceKind || "none") === state.source);

function emptyState() {
  const phaseItems = state.data.items.filter((it) => inPhase(it) && inFilters(it));
  const anyHidden = phaseItems.some((it) => !it.checked && !baseFilter(it));
  const allClear = !phaseItems.some(isOpen);
  const filtered = state.board !== "all" || state.project !== "all" || state.source !== "all";
  const pc = phaseCounts();
  if (state.phase === "action" && allClear && phaseItems.length) {
    return el("div", { class: "empty finished" },
      leafMotif("leaf-motif big"),
      el("h2", {}, filtered ? "Everything here is tended." : "Every action is tended."),
      el("p", {}, pc.awareness ? `${pc.awareness} awareness item${pc.awareness === 1 ? "" : "s"} left to read. It's a quick skim.` : "Nothing left to read either."),
      pc.awareness ? el("button", { type: "button", class: "btn btn-primary empty-action", onclick: () => setPhase("awareness") }, "Read the awareness digest", el("kbd", {}, "p")) : emptyAction(true));
  }
  return el("div", { class: "empty" },
    leafMotif(),
    el("h2", {}, !phaseItems.length ? "Nothing matches." : allClear ? (state.phase === "awareness" ? "All read." : "Nothing left to tend.") : "Nothing matches."),
    el("p", {}, allClear ? "Every open item here is done, dropped or snoozed." : anyHidden ? "Clear a filter, or show snoozed items, to see more." : ""),
    emptyAction(allClear));
}

// One clear next step from an empty view.
function emptyAction(allClear) {
  const filtered = state.board !== "all" || state.project !== "all" || state.source !== "all";
  if (filtered) {
    return el("button", { type: "button", class: "btn btn-quiet empty-action", onclick: () => {
      state.board = state.project = state.source = "all"; state.sel = null; render({ focus: true });
    } }, "Clear filters");
  }
  if (!allClear && !state.showSnoozed) {
    return el("button", { type: "button", class: "btn btn-quiet empty-action", onclick: () => {
      state.showSnoozed = true; LS.set("showSnoozed", true); render({ focus: true });
    } }, "Show snoozed");
  }
  if (state.phase === "awareness" && phaseCounts().action) {
    return el("button", { type: "button", class: "btn btn-quiet empty-action", onclick: () => setPhase("action") }, "Back to actions");
  }
  const idx = state.files.findIndex((f) => f.name === state.data.file);
  const older = idx >= 0 ? state.files[idx + 1] : null;
  if (older) {
    return el("button", { type: "button", class: "btn btn-quiet empty-action", onclick: async () => {
      state.composer = null; state.sel = null;
      await load(older.name);
      history.replaceState(null, "", `#${older.name}`);
      render({ focus: true });
    } },
      `Open the ${fmtShort(parseISO(older.date))} page`);
  }
  return null;
}

// ------------------------------------------------------------------ render

let lastFocusKey = null;
function render({ focus = false } = {}) {
  if (!state.data) return;
  state.needsRender = false;
  renderChrome();
  const { groups, flat } = visible();
  ensureSelection(flat);
  const phaseItems = state.data.items.filter(inPhase);
  const open = phaseItems.filter((it) => !it.checked);
  const shown = flat.filter((it) => !it.checked).length;
  const snoozed = open.filter(isSnoozed).length;
  const pool = open.filter((it) => state.showSnoozed || !isSnoozed(it)).length;
  const filtered = state.board !== "all" || state.project !== "all" || state.source !== "all";
  $("#tally").innerHTML = (filtered ? `<strong>${shown}</strong> of ${pool} open` : `<strong>${pool}</strong> open`) +
    (snoozed ? ` · ${snoozed} snoozed${state.showSnoozed ? " (shown)" : ""}` : "") +
    ` · ${phaseItems.length - open.length} resolved`;

  const root = $("#items");
  let body;
  if (!flat.length) body = emptyState();
  else if (state.phase === "awareness") body = renderDigest(groups);
  else body = state.view === "one" ? renderOne(flat) : renderList(groups);
  root.replaceChildren(body);

  const cur = root.querySelector('.card[aria-current="true"], .row[aria-current="true"] .row-head');
  const comp = root.querySelector(".composer");
  if (comp && comp._focus && state.composer && !state.composer.focused) {
    state.composer.focused = true;
    comp._focus();
    if (state.composer.autostart) { state.composer.autostart = false; comp._autostart?.(); }
  } else if (cur && (focus || (state.sel && keyOf(state.sel) !== lastFocusKey))) {
    if (!root.contains(document.activeElement) || document.activeElement === root || focus) cur.focus({ preventScroll: true });
    (cur.closest(".row") || cur).scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  if (state.sel) lastFocusKey = keyOf(state.sel);
  syncVoiceButton();
}

// Don't re-render under the owner's fingers: an open composer or a half-typed note.
function typing() {
  if (state.composer) return true;
  const a = document.activeElement;
  return !!(a && a.matches?.("#items input, #items textarea") && a.value.trim());
}

// ------------------------------------------------------------------ actions

function openComposer(it, kind, { autostart = false } = {}) {
  if (it.checked) return;
  if (voice.active) { voice.stop("composer"); toast("Stopped listening while you type"); }
  dictation.cancel();
  state.sel = { raw: it.raw, occurrence: it.occurrence };
  state.composer = { kind, key: keyOf(it), draft: "", autostart, focused: false };
  render();
}

function closeComposer() {
  dictation.cancel();
  state.composer = null;
  render({ focus: true });
}

async function submitComposer(it, kind, ta, cfg) {
  if (state.busy) return;
  if (dictation.active) await dictation.stop();
  const text = ta.value.trim();
  if (cfg.required && !text) {
    const err = ta.closest(".composer")?.querySelector(".composer-error");
    if (err) err.textContent = `Write or dictate something first: ${kind === "assistant" ? "tell the assistant what you want" : kind === "ask" ? "what's the question?" : "a comment can't be empty"}.`;
    ta.setAttribute("aria-invalid", "true");
    ta.setAttribute("aria-describedby", `${ta.id}-interim ${ta.id}-err`);
    ta.focus();
    return;
  }
  runAction(it, kind, { text });
}

const PAST = { choose: "Chose", done: "Marked done", snooze: "Snoozed", comment: "Comment saved", drop: "Dropped", assistant: "Handed to the assistant", ask: "Asked the assistant", reclassify: "Moved" };

function pastTense(action, extra) {
  if (action === "snooze") return `Rescheduled to ${fmtShort(parseISO(extra.date))}`;
  if (action === "reclassify") return extra.kind === "awareness" ? "Moved to awareness" : "Moved to actions";
  if (action === "drop" && extra.text) return `Dropped: ${extra.text}`;
  if (action === "choose") return `Chose "${extra.option}"`;
  return PAST[action];
}

// Returns true on success. Every action moves on to the next item except Ask,
// whose answer lands on this card. opts.voice: shorter toast, and always advance.
async function runAction(it, action, extra = {}, opts = {}) {
  if (state.busy) return false;
  state.busy = true;
  const { flat } = visible();
  const idx = flat.findIndex((x) => x.raw === it.raw && x.occurrence === it.occurrence);
  try {
    const res = await api("/api/action", { method: "POST", body: { file: state.data.file, raw: it.raw, occurrence: it.occurrence, action, ...extra } });
    state.composer = null;
    dictation.cancel();
    const leavesView = action === "done" || action === "choose" || action === "drop" || action === "reclassify" ||
      (action === "snooze" && !(state.showSnoozed || extra.date <= state.data.today));
    await load(state.data.file, { quiet: true });
    if (!leavesView) {
      const same = state.data.items.filter((x) => x.raw === res.newRaw);
      state.sel = same.length ? { raw: res.newRaw, occurrence: Math.min(it.occurrence, same.length - 1) } : null;
      if (opts.voice || action !== "ask") { const after = visible().flat; const j = after.findIndex((x) => state.sel && x.raw === state.sel.raw); if (j >= 0 && after[j + 1]) state.sel = { raw: after[j + 1].raw, occurrence: after[j + 1].occurrence }; else if (j >= 0) opts.reachedEnd = true; }
    } else {
      state.sel = null;
      const after = visible().flat;
      if (opts.voice && idx >= after.length) opts.reachedEnd = true;
      ensureSelection(after, idx);
    }
    render({ focus: true });
    let sub = res.git?.committed ? `committed ${res.git.sha}` : res.git?.note || "";
    if (action === "ask") sub = res.trigger?.queued ? "The assistant has been pinged; its answer will appear on the card" : sub;
    if (res.warning) toast(res.warning, { error: true, sticky: true });
    toast(pastTense(action, extra), { sub: opts.voice ? "" : sub, undo: true, ms: opts.voice ? 3000 : undefined });
    if (action === "ask") watchAsks();
    return true;
  } catch (e) {
    toast(e.message, { error: true, sticky: e.conflict, reload: e.conflict });
    if (e.conflict) await load(state.data.file, { quiet: true }).then(() => render()).catch(() => {});
    return false;
  } finally {
    state.busy = false;
  }
}

async function undo() {
  if (state.busy) return;
  state.busy = true;
  try {
    const res = await api("/api/undo", { method: "POST", body: {} });
    if (res.file && state.data && res.file !== state.data.file) toast(`Undid an action on ${res.file}`);
    await load(state.data.file, { quiet: true });
    const back = state.data.items.find((x) => x.raw === res.raw);
    if (back) {
      state.sel = { raw: back.raw, occurrence: back.occurrence };
      if (back.kind !== state.phase) { state.phase = back.kind; LS.set("phase", state.phase); }
    }
    render({ focus: true });
    toast(`Undid: ${PAST[res.undone] ? PAST[res.undone].toLowerCase() : res.undone}`, { sub: res.git?.committed ? `committed ${res.git.sha}` : res.git?.note || "", ms: 3000 });
    if (res.warning) toast(res.warning, { error: true, sticky: true });
  } catch (e) {
    toast(e.message, { error: true, sticky: e.conflict });
  } finally {
    state.busy = false;
  }
}

// Returns false when there's nowhere further to go.
function move(delta) {
  const { flat } = visible();
  if (!flat.length) return false;
  const cur = selectedItem(flat);
  const from = cur ? flat.indexOf(cur) : -1;
  if (delta > 0 && from >= flat.length - 1 && state.phase === "action") {
    if (phaseCounts().awareness) { setPhase("awareness"); toast("On to the awareness digest", { ms: 3000 }); return true; }
    return false;
  }
  let i = cur ? from + delta : 0;
  i = Math.max(0, Math.min(flat.length - 1, i));
  if (i === from) return false;
  state.sel = { raw: flat[i].raw, occurrence: flat[i].occurrence };
  if (state.composer && state.composer.key !== keyOf(flat[i])) { dictation.cancel(); state.composer = null; }
  render({ focus: true });
  return true;
}

function setPhase(p) {
  if (state.phase === p) return;
  state.phase = p;
  LS.set("phase", p);
  state.sel = null;
  state.composer = null;
  state.awOpen = p === "awareness" && voice.active;
  render({ focus: true });
}

// ------------------------------------------------------------------ toasts

function toast(msg, { sub = "", error = false, sticky = false, undo: withUndo = false, reload = false, ms, action } = {}) {
  voice.ignore(msg);
  const shelf = $("#toasts");
  while (shelf.children.length >= 3) shelf.firstElementChild.remove();
  const t = el("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" },
    el("span", { class: "msg" }, msg, sub ? el("span", { class: "sub" }, sub) : null));
  if (withUndo) t.append(el("button", { type: "button", onclick: () => { t.remove(); undo(); } }, "Undo"));
  if (action) t.append(el("button", { type: "button", onclick: () => { t.remove(); action.fn(); } }, action.label));
  if (reload) t.append(el("button", { type: "button", onclick: () => { t.remove(); load(state.data.file).then(() => render()); } }, "Reload"));
  t.append(el("button", { type: "button", "aria-label": "Dismiss", onclick: () => t.remove() }, "×"));
  shelf.append(t);
  if (!sticky) setTimeout(() => t.remove(), ms || (error ? 9000 : 6000));
}

// ------------------------------------------------------------------ asks: poll for the assistant's answers

let askTimer = null;
function pendingKeys(data) {
  return new Set((data?.items || []).filter((it) => it.pendingAsk).map(keyOf));
}
function watchAsks() {
  if (askTimer || !pendingKeys(state.data).size) return;
  askTimer = setInterval(pollAsks, 5000);
}
async function pollAsks() {
  if (!state.data) return;
  const before = pendingKeys(state.data);
  if (!before.size) { clearInterval(askTimer); askTimer = null; return; }
  if (state.busy) return;
  let fresh;
  try { fresh = await api(`/api/items?file=${encodeURIComponent(state.data.file)}`); } catch { return; }
  const answered = fresh.items.filter((it) => before.has(keyOf(it)) && !it.pendingAsk);
  const changed = fresh.mtime !== state.data.mtime;
  state.data = fresh;
  state.loadedAt = Date.now();
  for (const it of answered) {
    if (talk.active) {
      const ans = (it.notes || []).filter((n) => n.who === "Assistant").pop();
      talk.queueNote(`[App update, not the owner speaking] the assistant answered the owner's question on i${it.id} (${plain(it.text).slice(0, 60)}): "${ans ? ans.text : "(no text)"}"`);
    }
    state.justAnswered.add(keyOf(it));
    const k = keyOf(it);
    setTimeout(() => state.justAnswered.delete(k), 8000);
    const onScreen = state.sel && state.sel.raw === it.raw && state.sel.occurrence === it.occurrence;
    if (!onScreen) {
      toast("The assistant answered", { sub: plain(it.text).slice(0, 70), ms: 8000, action: { label: "Show", fn: () => {
        if (it.kind !== state.phase) { state.phase = it.kind; LS.set("phase", it.kind); }
        state.sel = { raw: it.raw, occurrence: it.occurrence }; state.awOpen = true; render({ focus: true });
      } } });
    }
  }
  // Re-render for answers, and once a minute anyway so "thinking" can turn into "no answer yet".
  if (typing()) { state.needsRender = true; }
  else if (answered.length || changed || before.size) render();
  if (!pendingKeys(state.data).size) { clearInterval(askTimer); askTimer = null; }
}

// ------------------------------------------------------------------ dictation (inside composers)

class Dictation {
  constructor() {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.forceRecord = false;
    this.active = false;
    this.session = 0;
  }
  get mode() {
    if (this.SR && !this.forceRecord) return "speech";
    if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) return "record";
    return "none";
  }
  get lang() { return LS.get("lang", "en-US"); }
  idleHint() {
    if (this.mode === "speech") return "Tap the mic or press Space to dictate. Enter saves.";
    if (this.mode === "record") return "Tap the mic or press Space to record; Whisper transcribes when you stop.";
    return "Dictation isn't available in this browser.";
  }

  toggle(ta, interim, btn) { return this.active ? this.stop() : this.start(ta, interim, btn); }

  async start(ta, interim, btn) {
    if (this.active) return;
    if (this.mode === "none") { toast("No speech recognition or recorder in this browser.", { error: true }); return; }
    const id = ++this.session;
    Object.assign(this, { ta, interim, btn, active: true, stopRequested: false });
    btn.setAttribute("aria-pressed", "true");
    btn.setAttribute("aria-label", "Stop dictating");
    if (this.mode === "speech") this._startSpeech(id);
    else await this._startRecord(id);
  }

  _setText(v) {
    if (!document.contains(this.ta)) return;
    this.ta.value = v;
    if (state.composer) state.composer.draft = v;
  }

  _startSpeech(id) {
    const rec = new this.SR();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    const base = this.ta.value;
    let lastInterim = "";
    this.interim.textContent = "Listening…";
    const live = () => this.session === id && this.rec === rec;
    rec.onresult = (e) => {
      if (!live()) return;
      let finals = "", inter = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += r[0].transcript; else inter += r[0].transcript;
      }
      this._setText(joinText(base, finals));
      lastInterim = inter.trim();
      this.interim.textContent = lastInterim || (finals ? "" : "Listening…");
    };
    rec.onerror = (e) => {
      if (!live() || e.error === "no-speech" || e.error === "aborted") return;
      this.stopRequested = true;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast("Microphone blocked. Allow it for this site in Chrome's address-bar settings.", { error: true });
      } else if (e.error === "network" || e.error === "language-not-supported") {
        this.forceRecord = true;
        toast("Chrome's speech service didn't answer. Switched to the Whisper fallback; tap the mic again.", { error: true });
      } else {
        toast(`Dictation error: ${e.error}`, { error: true });
      }
    };
    rec.onend = () => {
      if (!live()) return;
      if (lastInterim) this._setText(joinText(this.ta.value, lastInterim));
      if (!this.stopRequested && document.contains(this.ta)) {
        // Chrome ends a session after a long pause; keep going until the owner stops it.
        try { this._startSpeech(id); return; } catch {}
      }
      this._finish(id);
    };
    rec.start();
  }

  async _startRecord(id) {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { toast("Microphone blocked. Allow it for this site in the browser settings.", { error: true }); return this._finish(id); }
    if (this.session !== id) { stream.getTracks().forEach((t) => t.stop()); return; }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    this.mr = mr;
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (this.session !== id || this.cancelled) return;
      this.btn.classList.add("is-busy");
      this.interim.textContent = "Transcribing with Whisper…";
      try {
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        const res = await api("/api/transcribe", { method: "POST", body: blob, headers: { "Content-Type": blob.type, "X-Lang": this.lang } });
        if (res.text && this.session === id) this._setText(joinText(this.ta.value, res.text));
      } catch (e) {
        toast(`Whisper fallback failed: ${e.message}`, { error: true, sticky: true });
      }
      this.btn.classList.remove("is-busy");
      this._finish(id);
    };
    mr.start();
    this.interim.textContent = "Recording… tap the mic or press Space to stop.";
  }

  stop() {
    if (!this.active) return Promise.resolve();
    const id = this.session;
    this.stopRequested = true;
    return new Promise((resolve) => {
      this._resolve = resolve;
      // Never hang a save on a stuck session; Whisper gets longer than Chrome.
      setTimeout(() => this._finish(id), this.mr ? 45000 : 4000);
      try {
        if (this.rec) this.rec.stop();
        else if (this.mr && this.mr.state !== "inactive") this.mr.stop();
        else this._finish(id);
      } catch { this._finish(id); }
    });
  }

  cancel() {
    if (!this.active) return;
    this.cancelled = true;
    const rec = this.rec, mr = this.mr;
    this._finish(this.session);
    this.session++;
    try { rec?.abort(); } catch {}
    try { if (mr && mr.state !== "inactive") mr.stop(); } catch {}
  }

  _finish(id) {
    if (id !== this.session || (!this.active && !this._resolve)) return;
    this.active = false;
    this.cancelled = false;
    this.rec = null; this.mr = null;
    if (this.btn) { this.btn.setAttribute("aria-pressed", "false"); this.btn.setAttribute("aria-label", "Dictate"); this.btn.classList.remove("is-busy"); }
    if (this.interim && document.contains(this.interim)) this.interim.textContent = "";
    if (this.ta && document.contains(this.ta)) this.ta.focus();
    const r = this._resolve; this._resolve = null; r?.();
  }
}

function joinText(a, b) {
  b = (b || "").trim();
  if (!b) return a;
  if (!a.trim()) return cap(b);
  return a.replace(/\s*$/, "") + " " + b;
}

const dictation = new Dictation();

// ------------------------------------------------------------------ voice commands: one tap, card to card

const voice = new VoiceSession({
  Recognizer: window.SpeechRecognition || window.webkitSpeechRecognition,
  lang: LS.get("lang", "en-US"),
  onFinal: (text) => applyVoice(text),
  onInterim: (t) => { if (t) voiceBar({ live: t }); },
  onState: (s, why) => {
    document.body.classList.toggle("listening", s !== "off");
    if (s === "off") { $("#voicebar").hidden = true; if (why === "stopped") toast("Stopped listening", { ms: 2500 }); }
    else { $("#voicebar").hidden = false; voiceBar({ status: s === "busy" ? "Working…" : "Listening" }); }
    syncVoiceButton();
  },
  onError: (code, msg) => toast(msg, { error: true, sticky: code === "unsupported" }),
});

function voiceBar({ status, live, heard, result, bad } = {}) {
  const bar = $("#voicebar");
  if (status !== undefined) bar.querySelector(".vb-status").textContent = status;
  if (live !== undefined) { bar.querySelector(".vb-live").textContent = live; bar.querySelector(".vb-result").textContent = ""; }
  if (heard !== undefined) bar.querySelector(".vb-live").textContent = `“${heard}”`;
  if (result !== undefined) {
    const r = bar.querySelector(".vb-result");
    r.textContent = result;
    r.classList.toggle("bad", !!bad);
  }
}

function syncVoiceButton() {
  const b = $("#voice-btn");
  b.setAttribute("aria-pressed", String(voice.active));
  b.setAttribute("aria-label", voice.active ? "Stop listening" : "Triage by voice");
  b.title = voice.active ? "Stop listening (l)" : "Triage by voice (l)";
  document.querySelectorAll("#items .listen").forEach((x) => {
    x.classList.toggle("is-on", voice.active);
    x.setAttribute("aria-pressed", String(voice.active));
    x.childNodes[1].textContent = voice.active ? "Listening" : "Talk";
  });
}

function toggleVoice() {
  if (voice.active) { voice.stop(); return; }
  if (talk.active) talk.stop("stopped");
  if (state.composer) closeComposer();
  dictation.cancel();
  voice.lang = LS.get("lang", "en-US");
  voice.Recognizer = window.SpeechRecognition || window.webkitSpeechRecognition; // read late so a polyfill or test double can stand in
  if (voice.start()) {
    if (state.phase === "awareness") state.awOpen = true;
    voiceBar({ live: "Say done, drop, later, Monday, comment …, ask …, next, back, undo, or stop. On a question, say the answer.", result: "" });
    render({ focus: true });
  }
}

const SAID = {
  done: "Done", choose: "Chose", drop: "Drop", reschedule: "Reschedule", comment: "Comment", ask: "Ask the assistant", assistant: "Tell the assistant",
  next: "Next", prev: "Back", skip: "Skip", undo: "Undo", stop: "Stop",
};

async function applyVoice(text) {
  voiceBar({ heard: text, result: "" });
  const cur = selectedItem(visible().flat);
  const options = cur && !cur.checked ? (cur.options || []) : [];
  let intent;
  try { intent = await api("/api/voice", { method: "POST", body: { text, phase: state.phase, options } }); }
  catch (e) { voiceBar({ result: `Couldn't read that: ${e.message}`, bad: true }); return; }
  const a = intent.action;
  if (a === "unknown") { voiceBar({ result: "Not a command. Nothing changed.", bad: true }); return; }
  voiceBar({ result: SAID[a] + (intent.option ? ` "${intent.option}"` : "") + (intent.date ? ` → ${fmtShort(parseISO(intent.date))}` : "") + (intent.text ? `: ${intent.text}` : "") + (intent.tier === 2 ? " (model)" : "") });
  if (a === "stop") { voice.stop(); return; }
  if (a === "undo") { await undo(); return; }
  if (a === "next" || a === "skip") { if (!move(1)) voiceBar({ result: "That's the last one.", bad: true }); return; }
  if (a === "prev") { if (!move(-1)) voiceBar({ result: "Already at the first one.", bad: true }); return; }

  const { flat } = visible();
  const it = selectedItem(flat);
  if (!it || it.checked) { voiceBar({ result: "No open item selected.", bad: true }); return; }
  const map = { done: "done", choose: "choose", drop: "drop", reschedule: "snooze", comment: "comment", ask: "ask", assistant: "assistant" };
  const extra = a === "reschedule" ? { date: intent.date } : a === "choose" ? { option: intent.option, text: intent.text || "" } : { text: intent.text || "" };
  const opts = { voice: true };
  const ok = await runAction(it, map[a], extra, opts);
  if (ok && state.phase === "awareness") state.awOpen = true;
  if (ok && state.phase === "action" && (opts.reachedEnd || !visible().flat.some(isOpen))) {
    if (phaseCounts().awareness) { setPhase("awareness"); toast("Actions clear. On to the awareness digest", { ms: 3000 }); }
  } else if (ok) render({ focus: true });
}

// ------------------------------------------------------------------ keyboard

// Space inside a text field: tap toggles the mic, hold is push-to-talk.
// Only while the field is empty or while dictating, so typed spaces still work.
let spaceDown = null;
function composerKeys(e, ta, interim, mic, submit) {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); submit(); return; }
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (dictation.active) dictation.cancel(); else closeComposer(); return; }
  if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.repeat) { if (spaceDown) e.preventDefault(); return; }
    if (dictation.active) { e.preventDefault(); spaceDown = { at: Date.now(), stop: true }; return; }
    if (!ta.value.trim()) { e.preventDefault(); spaceDown = { at: Date.now(), stop: false }; dictation.start(ta, interim, mic); }
  }
}
function composerKeyUp(e) {
  if (e.key !== " " || !spaceDown) return;
  const held = Date.now() - spaceDown.at;
  const wasStop = spaceDown.stop;
  spaceDown = null;
  if (wasStop || held > 450) dictation.stop();
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.("textarea, input, select, dialog[open]")) {
    if (e.key === "Escape" && t.closest("input[type=date]") && state.composer) { e.preventDefault(); closeComposer(); }
    return;
  }
  if (!state.data) return;
  const { flat } = visible();
  const it = selectedItem(flat);
  const one = state.phase === "action" && state.view === "one";
  const digest = state.phase === "awareness";

  if (state.composer?.kind === "snooze" && /^[0-3]$/.test(e.key)) {
    e.preventDefault();
    $("#items .composer")?._pick?.(e.key);
    return;
  }
  // Arrows are primary: left/right card to card, up/down down the list.
  // j/k: k forward, j back.
  if ((one && e.key === "ArrowRight") || (!one && e.key === "ArrowDown") || e.key === "k") { e.preventDefault(); move(1); return; }
  if ((one && e.key === "ArrowLeft") || (!one && e.key === "ArrowUp") || e.key === "j") { e.preventDefault(); move(-1); return; }
  switch (e.key) {
    case "Escape":
      if (state.composer) { e.preventDefault(); closeComposer(); }
      else if (voice.active) { e.preventDefault(); voice.stop(); }
      else if (talk.active) { e.preventDefault(); talk.stop("stopped"); }
      else if (digest && state.awOpen) { e.preventDefault(); state.awOpen = false; render({ focus: true }); }
      return;
    case "u": e.preventDefault(); undo(); return;
    case "v": if (!digest) { e.preventDefault(); setView(state.view === "one" ? "list" : "one"); } return;
    case "p": e.preventDefault(); setPhase(state.phase === "action" ? "awareness" : "action"); return;
    case "l": e.preventDefault(); toggleVoice(); return;
    case "s": e.preventDefault(); state.showSnoozed = !state.showSnoozed; LS.set("showSnoozed", state.showSnoozed); render(); return;
    case "t": e.preventDefault(); toggleTheme(); return;
    case "T": e.preventDefault(); toggleTalk(); return;
    case "?": e.preventDefault(); openHelp(); return;
  }
  if (!it || it.checked) return;
  if (t.closest?.("button:not(.row-head)") && (e.key === " " || e.key === "Enter")) return; // let buttons work

  if (digest) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); state.awOpen = !state.awOpen; render({ focus: true }); return; }
    if (e.key === "d" || e.key === "D") { e.preventDefault(); runAction(it, "done", { text: "" }); return; }
    if (e.key === "x") { e.preventDefault(); runAction(it, "drop", { text: "" }); return; }
    if (e.key === "c" || e.key === "a") {
      e.preventDefault();
      state.awOpen = true; render();
      $(`#items .row[aria-current="true"] input[data-action="${e.key === "c" ? "comment" : "ask"}"]`)?.focus();
    }
    return;
  }
  if (/^[1-9]$/.test(e.key) && it.options?.[+e.key - 1]) { e.preventDefault(); runAction(it, "choose", { option: it.options[+e.key - 1], text: "" }); return; }
  const map = { d: "done", r: "snooze", c: "comment", a: "ask", x: "drop", m: "assistant" };
  if (e.key === "D") { e.preventDefault(); runAction(it, "done", { text: "" }); return; }
  if (map[e.key]) { e.preventDefault(); openComposer(it, map[e.key]); return; }
  if (e.key === " " && !e.repeat) {
    // The fast path: Space, speak, Space, Enter.
    e.preventDefault();
    spaceDown = { at: Date.now(), stop: false };
    openComposer(it, "comment", { autostart: true });
  }
});
document.addEventListener("keyup", (e) => { if (e.key === " " && spaceDown && !e.target.closest?.("textarea")) composerKeyUp(e); });
document.addEventListener("focusout", () => { setTimeout(() => { if (state.needsRender && !typing()) render(); }, 0); });

// ------------------------------------------------------------------ talk it through: a spoken conversation about the page
//
// The controller (talk.js) owns the conversation; the provider adapter owns the
// audio; the server owns every write. This block only draws the dock and keeps
// the page in step with what the conversation did.

const TALK_STATUS = { connecting: "Connecting…", live: "Listening", speaking: "Speaking", reconnecting: "Reconnecting…", ending: "Wrapping up" };
const TALK_ENDED = { idle: "Ended: quiet for three minutes", done: "Ended. Tap to start again", stopped: "Stopped. Tap to start again", error: "Stopped. Tap to try again" };
let talkLog = [];

const talk = new TalkController({
  api: (path, body) => api(path, { method: "POST", body }),
  connect: async (info, handlers) => {
    const mod = info.connect?.kind === "fake" ? await import("/talk-fake.js") : await import("/talk-openai.js");
    return mod.connect(info, handlers);
  },
  onCaption: renderCaptions,
  onState: talkState,
  onUi: (ui) => { talkUi(ui).catch((e) => toast(e.message, { error: true })); },
  onError: (msg) => toast(msg, { error: true, ms: 12000 }),
});

function talkDockOpen() { return !$("#talkdock").hidden; }

function openTalk() {
  const dock = $("#talkdock");
  dock.hidden = false;
  document.body.classList.add("talking");
  $("#talk-btn").setAttribute("aria-pressed", "true");
  startTalk();
}
function closeTalk() {
  talk.stop("stopped");
  $("#talkdock").hidden = true;
  document.body.classList.remove("talking");
  $("#talk-btn").setAttribute("aria-pressed", "false");
  state.talkFocus = null;
  render();
}
function toggleTalk() { talkDockOpen() ? closeTalk() : openTalk(); }

function startTalk() {
  if (talk.active || !state.data) return;
  if (voice.active) voice.stop();
  if (state.composer) closeComposer();
  dictation.cancel();
  talk.file = state.data.file;
  talkLog = [];
  renderTalkLog();
  showConfirm(null);
  renderCaptions([]);
  talk.start();
}

function talkState(s, why) {
  const dock = $("#talkdock");
  dock.dataset.state = s;
  const on = s !== "off";
  const orb = $("#tk-orb");
  orb.setAttribute("aria-pressed", String(on));
  orb.setAttribute("aria-label", on ? "Stop talking" : "Start talking");
  $("#tk-mute").hidden = !on;
  if (!on) { talk.muted = false; syncMute(); }
  $("#tk-status").textContent = on ? TALK_STATUS[s] || s : (TALK_ENDED[why] || "Tap to start");
}

function syncMute() {
  const b = $("#tk-mute");
  b.setAttribute("aria-pressed", String(talk.muted));
  b.textContent = talk.muted ? "Unmute" : "Mute";
  $("#talkdock").dataset.muted = String(talk.muted);
  if (talk.muted && talk.state === "live") $("#tk-status").textContent = "Muted";
  else if (talk.state === "live") $("#tk-status").textContent = TALK_STATUS.live;
}

function renderCaptions(caps) {
  const box = $("#tk-captions");
  const dock = $("#talkdock");
  const shown = caps.filter((c) => c.text).slice(-6);
  if (!shown.length) {
    box.replaceChildren(el("li", { class: "hint" }, talk.active ? "It opens with what matters most. Talk over it any time." : "Tap the circle and talk it through. Say “that’s all” to finish."));
  } else {
    box.replaceChildren(...shown.map((c) => el("li", { class: `${c.who}${c.final ? "" : " interim"}` }, c.text)));
    box.scrollTop = box.scrollHeight;
  }
  const last = caps[caps.length - 1];
  if (talk.state === "live" || dock.dataset.state === "speaking") {
    dock.dataset.state = last && last.who === "aide" && !last.final ? "speaking" : "live";
    if (!talk.muted) $("#tk-status").textContent = TALK_STATUS[dock.dataset.state];
  }
}

function renderTalkLog() {
  const list = $("#tk-log");
  if (!talkLog.length) {
    list.replaceChildren(el("li", { class: "tk-none" }, "Nothing yet. Everything it changes shows here, with undo."));
    return;
  }
  list.replaceChildren(...talkLog.slice().reverse().map((e) => el("li", { class: e.undone ? "undone" : "", "data-seq": String(e.seq) },
    el("span", { class: "tkl-label", title: e.label }, e.label),
    el("span", { class: "tkl-at" }, e.undone ? `${e.at} · undone` : e.at),
    e.undone ? null : el("button", { type: "button", class: "btn btn-quiet tkl-undo", onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try { await talk.undoEntry(e.seq); toast("Undone", { sub: e.label, ms: 3500 }); }
      catch (err) { toast(err.message, { error: true }); renderTalkLog(); }
    } }, "Undo"))));
}

function showConfirm(p) {
  const box = $("#tk-confirm");
  if (!p) { box.hidden = true; box.replaceChildren(); return; }
  const decide = (d) => async (ev) => {
    box.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try { await talk.approve(p.id, d); if (d === "no") showConfirm(null); }
    catch (err) { toast(err.message, { error: true }); showConfirm(null); }
  };
  box.replaceChildren(
    el("div", { class: "tkc-text" }, `${p.summary}?`, el("small", { title: p.items.join("\n") }, p.items.join(" · "))),
    el("button", { type: "button", class: "btn btn-yes", onclick: decide("yes") }, "Yes, do it"),
    el("button", { type: "button", class: "btn btn-quiet", onclick: decide("no") }, "No"));
  box.hidden = false;
}

async function talkUi(ui) {
  if (!ui) return;
  if (ui.changed && state.data) {
    try { await load(state.data.file, { quiet: true }); } catch {}
  }
  if (ui.log) {
    const k = talkLog.findIndex((e) => e.seq === ui.log.seq);
    if (k >= 0) talkLog[k] = ui.log; else talkLog.push(ui.log);
    renderTalkLog();
  }
  if ("pending" in ui) showConfirm(ui.pending);
  if (ui.focus && state.data) {
    const it = state.data.items.find((x) => `i${x.id}` === ui.focus);
    if (it) {
      state.talkFocus = ui.focus;
      if (it.kind !== state.phase) { state.phase = it.kind; LS.set("phase", it.kind); }
      if (state.composer) state.composer = null;
      state.sel = { raw: it.raw, occurrence: it.occurrence };
      state.awOpen = it.kind === "awareness";
    }
  }
  if (ui.changed || ui.focus) render({ focus: !!ui.focus });
  if (ui.asked) watchAsks();
}

$("#talk-btn").addEventListener("click", toggleTalk);
$("#tk-orb").addEventListener("click", () => { talk.active ? talk.stop("stopped") : startTalk(); });
$("#tk-mute").addEventListener("click", () => { talk.mute(!talk.muted); syncMute(); });
$("#tk-close").addEventListener("click", closeTalk);
renderCaptions([]);

// ------------------------------------------------------------------ chrome wiring

function setView(v) {
  state.view = v;
  LS.set("view2", v);
  render({ focus: true });
}

function currentTheme() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("intake.theme", next);
  syncThemeButton();
}
function syncThemeButton() {
  const dark = currentTheme() === "dark";
  $("#theme-btn").setAttribute("aria-label", dark ? "Switch to daylight" : "Switch to evening lamp light");
  $("#theme-btn").title = (dark ? "Daylight" : "Evening lamp light") + " (t)";
}

function openHelp() {
  $("#lang-select").value = dictation.lang;
  const mode = dictation.mode;
  $("#mic-mode").textContent = mode === "speech"
    ? "Voice uses Chrome's built-in speech recognition (audio goes to Google's speech service). Commands the grammar doesn't know go to a small decision model through the triage server. If dictation in a comment box fails, the app switches to local recording plus Groq Whisper."
    : mode === "record" ? "This browser has no live speech recognition, so voice commands are off. Dictation in a comment box records locally and sends the clip to Groq Whisper." : "No dictation available in this browser.";
  $("#help").showModal();
}

$("#view-list").addEventListener("click", () => setView("list"));
$("#view-one").addEventListener("click", () => setView("one"));
$("#phase-action").addEventListener("click", () => setPhase("action"));
$("#phase-awareness").addEventListener("click", () => setPhase("awareness"));
$("#phases").addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setPhase(state.phase === "action" ? "awareness" : "action"); $(`#phase-${state.phase}`).focus(); }
});
$("#voice-btn").addEventListener("click", toggleVoice);
$("#vb-stop").addEventListener("click", () => voice.stop());
$("#theme-btn").addEventListener("click", toggleTheme);
$("#help-btn").addEventListener("click", openHelp);
$("#lang-select").addEventListener("change", (e) => LS.set("lang", e.target.value));
$("#group-select").addEventListener("change", (e) => { state.group = e.target.value; LS.set("group", state.group); render(); });
$("#project-select").addEventListener("change", (e) => { state.project = e.target.value; state.sel = null; render(); });
$("#source-select").addEventListener("change", (e) => { state.source = e.target.value; state.sel = null; render(); });
$("#show-snoozed").addEventListener("change", (e) => { state.showSnoozed = e.target.checked; LS.set("showSnoozed", state.showSnoozed); render(); });
$("#show-resolved").addEventListener("change", (e) => { state.showResolved = e.target.checked; render(); });
$("#file-select").addEventListener("change", async (e) => {
  if (talk.active) talk.stop("stopped");
  state.composer = null; state.sel = null; state.project = "all"; state.source = "all"; state.board = "all";
  await load(e.target.value);
  history.replaceState(null, "", e.target.value === state.files[0]?.name ? location.pathname : `#${e.target.value}`);
  render({ focus: true });
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeButton);

// ------------------------------------------------------------------ load

async function load(file, { quiet = false } = {}) {
  try {
    const q = file ? `?file=${encodeURIComponent(file)}` : "";
    state.data = await api(`/api/items${q}`);
    state.loadedAt = Date.now();
    state.file = state.data.file;
  } catch (e) {
    if (!quiet) $("#items").replaceChildren(el("p", { class: "loading" }, e.message));
    throw e;
  }
}

async function refreshIfChanged() {
  if (!state.data || typing() || state.busy || document.hidden) return;
  try {
    const prev = state.data.mtime;
    const files = await api("/api/files");
    const newest = files.files[0]?.name;
    const wasNewest = state.files[0]?.name === state.data.file;
    state.files = files.files;
    if (wasNewest && newest && newest !== state.data.file) {
      await load(newest, { quiet: true });
      toast(`A new intake page arrived: ${newest}`);
      return render();
    }
    await load(state.data.file, { quiet: true });
    if (state.data.mtime !== prev) render();
    watchAsks();
  } catch {}
}

async function boot() {
  syncThemeButton();
  if (!voice.supported) $("#voice-btn").title = "Voice commands need Chrome or Edge";
  try {
    const [files, status] = await Promise.all([api("/api/files"), api("/api/status")]);
    state.files = files.files;
    state.vaultName = status.vault.split("/").filter(Boolean).pop() || "vault";
    const fromHash = decodeURIComponent(location.hash.slice(1));
    await load(state.files.some((f) => f.name === fromHash) ? fromHash : undefined);
    // Land on actions while there are any.
    if (state.phase === "awareness" && phaseCounts().action) state.phase = "action";
    render({ focus: true });
    watchAsks();
  } catch (e) {
    $("#subtitle").textContent = "Couldn't load";
    $("#items").replaceChildren(el("p", { class: "loading" }, e.message));
  }
  window.addEventListener("focus", refreshIfChanged);
  setInterval(refreshIfChanged, 60000);
}

boot();

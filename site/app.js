"use strict";

// Read-only viewer. Everything shown comes from the AREDL API:
//  - data.json is a snapshot of every level's custom copies, rebuilt hourly from the API by GitHub Actions.
//  - When a search narrows to a few levels (or you press Refresh), those levels are re-checked live
//    against the API so you always see the latest copies for the level you looked up.
// There are no forms, no write requests and no HTML injection: API text is only ever set via textContent.

const API_ROOT = "https://api.aredl.net/v2/api";
const LISTS = {
  aredl: { label: "Classic", link: (id) => `https://aredl.net/list/${id}` },
  arepl: { label: "Platformer", link: (id) => `https://aredl.net/list/${id}?list=platformer` },
};
const LIST_KEY = "aredl-copies:list";
const DATA_URL = "data.json";
const CACHE_KEY = "aredl-copies:data:v2";
const COOLDOWN_KEY = "aredl-copies:last-refresh";
const HOUR = 60 * 60 * 1000;
const MAX_AGE = HOUR;              // re-download the snapshot after this long
const COOLDOWN = 30 * 1000;        // refresh button cooldown
const LIVE_TTL = 5 * 60 * 1000;    // don't re-check the same level live more often than this
const LIVE_MAX_LEVELS = 3;         // auto live-check only when the search shows this many levels or fewer
const PAGE = 40;                   // cards rendered per scroll step

const SP_RE = /\b(sp|start\s*-?\s*pos\w*)\b/i;

const STATUSES = ["Published", "Allowed", "Banned"];
const TYPES = [
  { key: "Ldm", label: "LDM" },
  { key: "Bugfix", label: "Bugfix" },
  { key: "GlobedCopy", label: "Globed" },
  { key: "Other", label: "Other" },
  { key: "Startpos", label: "StartPos" },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.key, t.label]));

const $ = (id) => document.getElementById(id);
const els = {
  search: $("search"), list: $("list"), sentinel: $("sentinel"), summary: $("summary"),
  updated: $("updated"), refresh: $("refresh"), error: $("error"),
  statusChips: $("status-chips"), typeChips: $("type-chips"),
  hideEmpty: $("hide-empty"), showLegacy: $("show-legacy"), showPending: $("show-pending"),
  listTabs: [...document.querySelectorAll(".seg-btn")],
};

const state = {
  data: null,            // { generatedAt, fetchedAt, lists: { aredl: [...], arepl: [...] } }
  list: "aredl",         // which list is shown
  live: new Map(),       // levelId -> { at, copies }
  statuses: new Set(STATUSES),
  types: new Set(TYPES.map((t) => t.key)),
  results: [],
  rendered: 0,
  refreshing: false,
};

// ---------- storage helpers (storage can be unavailable; the page works without it) ----------
function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or disabled */ }
}

// ---------- data ----------
function tagsFor(copy) {
  const tags = [copy.type];
  if (copy.type !== "Startpos" && copy.description && SP_RE.test(copy.description)) tags.push("Startpos");
  return tags;
}

function prepare(data) {
  for (const levels of Object.values(data.lists)) {
    for (const level of levels) {
      level.hay = `${level.name} ${level.gdId}`.toLowerCase();
      for (const c of level.copies) c.tags = tagsFor(c);
    }
    // Ranked levels by position; pending levels (no position yet) at the end, alphabetically.
    levels.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.name.localeCompare(b.name));
  }
  return data;
}

function currentLevels() {
  return state.data.lists[state.list] ?? [];
}

function normalizeApiCopy(c) {
  return {
    copyId: c.copy_id,
    type: c.id_type,
    status: c.status,
    description: c.description ?? null,
    createdAt: c.created_at,
  };
}

function copiesOf(level) {
  const live = state.live.get(level.id);
  return live ? live.copies : level.copies;
}

async function fetchSnapshot() {
  const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load data (HTTP ${res.status})`);
  const json = await res.json();
  if (!json || !json.lists || !Object.keys(LISTS).every((k) => Array.isArray(json.lists[k]))) {
    throw new Error("Data file is malformed");
  }
  return { generatedAt: json.generatedAt, fetchedAt: Date.now(), lists: json.lists };
}

function isStale(d) {
  if (!d) return true;
  const now = Date.now();
  if (now - d.fetchedAt > MAX_AGE) return true;
  // The snapshot is rebuilt hourly; if this one is over an hour old, a newer one is probably out.
  // (Wait at least 5 minutes between attempts so a late rebuild doesn't cause a download loop.)
  return now - Date.parse(d.generatedAt) > HOUR + 10 * 60 * 1000 && now - d.fetchedAt > 5 * 60 * 1000;
}

async function loadSnapshot(force) {
  const cached = load(CACHE_KEY);
  if (!force && cached && !isStale(cached)) return prepare(cached);
  try {
    const fresh = await fetchSnapshot();
    save(CACHE_KEY, fresh);
    return prepare(fresh);
  } catch (err) {
    if (cached) { showError(`${err.message}. Showing the copy saved in your browser.`); return prepare(cached); }
    throw err;
  }
}

async function liveCheck(levels, { force = false } = {}) {
  const now = Date.now();
  const listKey = state.list;
  const todo = levels.filter((l) => force || !state.live.has(l.id) || now - state.live.get(l.id).at > LIVE_TTL);
  if (!todo.length) return;
  const results = await Promise.allSettled(todo.map(async (l) => {
    const res = await fetch(`${API_ROOT}/${listKey}/levels/${encodeURIComponent(l.id)}/custom-copies`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error("bad response");
    const copies = arr.map(normalizeApiCopy);
    for (const c of copies) c.tags = tagsFor(c);
    state.live.set(l.id, { at: Date.now(), copies });
  }));
  if (results.some((r) => r.status === "fulfilled")) render(false);
}

// ---------- filtering ----------
function copyPasses(c) {
  return state.statuses.has(c.status) && c.tags.some((t) => state.types.has(t));
}

function filtersActive() {
  return state.statuses.size !== STATUSES.length || state.types.size !== TYPES.length;
}

function computeResults() {
  const tokens = els.search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const hideEmpty = els.hideEmpty.checked || filtersActive();
  const showLegacy = els.showLegacy.checked;
  const showPending = els.showPending.checked;
  const out = [];
  for (const level of currentLevels()) {
    if (!showLegacy && level.status === "Legacy") continue;
    if (!showPending && level.status === "Pending") continue;
    const copies = copiesOf(level);
    if (tokens.length) {
      const ids = copies.map((c) => c.copyId).join(" ");
      const hay = `${level.hay} ${ids}`;
      if (!tokens.every((t) => hay.includes(t))) continue;
    }
    const shown = copies.filter(copyPasses);
    if (hideEmpty && !shown.length) continue;
    out.push({ level, shown });
  }
  return out;
}

// ---------- rendering ----------
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

function renderCopy(c) {
  const idBtn = el("button", { class: "copy-id", type: "button", title: "Copy level ID", text: String(c.copyId) });
  idBtn.addEventListener("click", () => {
    navigator.clipboard?.writeText(String(c.copyId)).then(() => {
      idBtn.classList.add("copied");
      setTimeout(() => idBtn.classList.remove("copied"), 1200);
    }).catch(() => {});
  });

  const tags = el("div", { class: "tags" },
    el("span", { class: `pill st-${c.status}`, text: c.status }),
    ...c.tags.map((t) => el("span", { class: `tag ty-${t}`, text: TYPE_LABEL[t] ?? t })));

  // Who added a copy is deliberately not shown (staff privacy); only the date is.
  const metaBits = [];
  if (c.createdAt) metaBits.push(`added ${dateFmt.format(new Date(c.createdAt))}`);

  return el("li", { class: `copy st-${c.status}` },
    idBtn,
    el("div", { class: "copy-body" },
      tags,
      c.description ? el("p", { class: "desc", text: c.description }) : null,
      metaBits.length ? el("p", { class: "meta", text: metaBits.join(" · ") }) : null));
}

function renderLevel({ level, shown }) {
  const counts = el("span", { class: "counts" });
  for (const s of STATUSES) {
    const n = shown.filter((c) => c.status === s).length;
    if (n) counts.append(el("span", { class: `pill st-${s}`, title: `${n} ${s.toLowerCase()}`, text: `${n} ${s}` }));
  }

  const head = el("div", { class: "level-head" },
    el("span", { class: "pos", text: level.position == null ? "—" : `#${level.position}` }),
    el("a", { class: "lname", href: LISTS[state.list].link(`${level.gdId}${level.twoPlayer ? "_2p" : ""}`), target: "_blank", rel: "noopener", text: level.name }),
    el("span", { class: "gdid", text: String(level.gdId) }),
    level.twoPlayer ? el("span", { class: "badge", text: "2P" }) : null,
    level.status === "Legacy" ? el("span", { class: "badge", text: "Legacy" }) : null,
    level.status === "Pending" ? el("span", { class: "badge pending", title: "Not placed on the list yet", text: "Pending" }) : null,
    state.live.has(level.id) ? el("span", { class: "live", title: "Checked live against the AREDL API", text: "● live" }) : null,
    counts);

  const card = el("article", { class: "level" }, head);
  if (shown.length) {
    const order = { Published: 0, Allowed: 1, Banned: 2 };
    const sorted = [...shown].sort((a, b) => order[a.status] - order[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    card.append(el("ul", { class: "copies" }, ...sorted.map(renderCopy)));
  } else {
    card.append(el("div", { class: "empty", text: "No copies listed for this level." }));
  }
  return card;
}

function renderMore() {
  const next = state.results.slice(state.rendered, state.rendered + PAGE);
  if (!next.length) return;
  const frag = document.createDocumentFragment();
  for (const r of next) frag.append(renderLevel(r));
  els.list.append(frag);
  state.rendered += next.length;
}

let liveTimer = 0;
function render(scheduleLive = true) {
  if (!state.data) return;
  state.results = computeResults();
  state.rendered = 0;
  els.list.replaceChildren();
  if (!state.results.length) {
    els.list.append(el("p", { class: "no-results", text: "No levels match." }));
  } else {
    renderMore();
  }
  const nCopies = state.results.reduce((n, r) => n + r.shown.length, 0);
  els.summary.textContent = `${state.results.length.toLocaleString()} level${state.results.length === 1 ? "" : "s"} · ${nCopies.toLocaleString()} cop${nCopies === 1 ? "y" : "ies"}`;

  if (scheduleLive) {
    clearTimeout(liveTimer);
    const q = els.search.value.trim();
    if (q && state.results.length && state.results.length <= LIVE_MAX_LEVELS) {
      const levels = state.results.map((r) => r.level);
      liveTimer = setTimeout(() => liveCheck(levels), 600);
    }
  }
}

function renderChips() {
  const all = currentLevels().flatMap((l) => l.copies);
  const statusCount = (s) => all.filter((c) => c.status === s).length;
  const typeCount = (t) => all.filter((c) => c.tags.includes(t)).length;

  const make = (container, items, set, cls, count) => {
    container.replaceChildren(...items.map(({ key, label }) => {
      const chip = el("button", { class: `chip ${cls}-${key}`, type: "button", "aria-pressed": String(set.has(key)) },
        label, el("span", { class: "n", text: count(key).toLocaleString() }));
      chip.addEventListener("click", (e) => {
        // Shift/ctrl/cmd-click: show only this one. Plain click: toggle.
        if (e.shiftKey || e.ctrlKey || e.metaKey) { set.clear(); set.add(key); }
        else if (set.has(key)) set.delete(key); else set.add(key);
        for (const b of container.children) b.setAttribute("aria-pressed", String(set.has(b.dataset.key)));
        render();
      });
      chip.dataset.key = key;
      return chip;
    }));
  };
  make(els.statusChips, STATUSES.map((s) => ({ key: s, label: s })), state.statuses, "st", statusCount);
  make(els.typeChips, TYPES, state.types, "ty", typeCount);
}

// ---------- header: last updated + refresh with cooldown ----------
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

function updateHeader() {
  if (state.data) {
    els.updated.textContent = `Data from ${ago(Date.now() - Date.parse(state.data.generatedAt))}`;
    els.updated.title = `AREDL snapshot taken ${new Date(state.data.generatedAt).toLocaleString()}`;
  }
  const last = Number(load(COOLDOWN_KEY)) || 0;
  const left = Math.ceil((last + COOLDOWN - Date.now()) / 1000);
  if (state.refreshing) {
    els.refresh.disabled = true; els.refresh.textContent = "Refreshing…";
  } else if (left > 0) {
    els.refresh.disabled = true; els.refresh.textContent = `Refresh (${left}s)`;
  } else {
    els.refresh.disabled = !state.data; els.refresh.textContent = "Refresh";
  }
}

async function refresh({ manual }) {
  if (state.refreshing) return;
  if (manual) {
    const last = Number(load(COOLDOWN_KEY)) || 0;
    if (Date.now() - last < COOLDOWN) return;
    save(COOLDOWN_KEY, Date.now());
  }
  state.refreshing = true; updateHeader(); hideError();
  try {
    state.data = await loadSnapshot(true);
    // Snapshot copies are newer than any live check made before it was taken.
    const gen = Date.parse(state.data.generatedAt);
    for (const [id, v] of state.live) if (v.at < gen) state.live.delete(id);
    renderChips();
    render(false);
    if (manual && state.results.length && state.results.length <= 10 && els.search.value.trim()) {
      await liveCheck(state.results.map((r) => r.level), { force: true });
    }
  } catch (err) {
    showError(err.message);
  } finally {
    state.refreshing = false; updateHeader();
  }
}

function showError(msg) { els.error.textContent = msg; els.error.hidden = false; }
function hideError() { els.error.hidden = true; }

// ---------- list switch (Classic / Platformer) ----------
function updateUrl() {
  const url = new URL(location.href);
  if (els.search.value.trim()) url.searchParams.set("q", els.search.value.trim()); else url.searchParams.delete("q");
  if (state.list === "arepl") url.searchParams.set("list", "platformer"); else url.searchParams.delete("list");
  history.replaceState(null, "", url);
}

function setList(key, { silent = false } = {}) {
  if (!LISTS[key]) return;
  state.list = key;
  save(LIST_KEY, key);
  for (const tab of els.listTabs) tab.setAttribute("aria-selected", String(tab.dataset.list === key));
  document.title = key === "arepl" ? "AREDL Copies · Platformer" : "AREDL Copies";
  if (silent) return;
  updateUrl();
  if (state.data) { renderChips(); render(); window.scrollTo({ top: 0 }); }
}

// ---------- boot ----------
async function init() {
  els.search.addEventListener("input", () => render());
  els.hideEmpty.addEventListener("change", () => render());
  els.showLegacy.addEventListener("change", () => render());
  els.showPending.addEventListener("change", () => render());
  for (const tab of els.listTabs) tab.addEventListener("click", () => setList(tab.dataset.list));
  els.refresh.addEventListener("click", () => refresh({ manual: true }));
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { rootMargin: "800px" }).observe(els.sentinel);

  // Search from the URL (?q=...) so results can be linked.
  const params = new URLSearchParams(location.search);
  const q = params.get("q");
  if (q) els.search.value = q;
  const fromUrl = params.get("list") === "platformer" ? "arepl" : params.get("list") === "classic" ? "aredl" : null;
  setList(fromUrl ?? (LISTS[load(LIST_KEY)] ? load(LIST_KEY) : "aredl"), { silent: true });
  els.search.addEventListener("change", updateUrl);

  try {
    state.data = await loadSnapshot(false);
    renderChips();
    render();
  } catch (err) {
    showError(`${err.message}. Try again in a minute.`);
    els.summary.textContent = "";
  }
  updateHeader();

  // Tick the cooldown/age display, and auto-refresh once the cached snapshot is an hour old.
  // Automatic attempts are at least 2 minutes apart so a failing request never loops.
  let lastAuto = Date.now();
  setInterval(() => {
    updateHeader();
    const due = state.data ? isStale(state.data) : true;
    if (due && !state.refreshing && document.visibilityState === "visible" && Date.now() - lastAuto > 2 * 60 * 1000) {
      lastAuto = Date.now();
      refresh({ manual: false });
    }
  }, 1000);
}

init();

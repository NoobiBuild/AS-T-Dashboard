/* NoobiBuilds Task Dashboard v2
   Base truth: tasks.json (read-only, fetched)
   Local overlays: localStorage key ast_task_overrides_v1
   Merge order: deletions -> task_overrides -> new_tasks
*/

const STORAGE_KEY = "ast_task_overrides_v1";
const OVERLAYS_VERSION = 1;

/* AI settings storage (separate from task overlays) */
const AI_SETTINGS_KEY = "noobi_ai_settings_v1";

/* ---------- Utilities ---------- */
function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseISODate(s) {
  if (!s || typeof s !== "string") return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
function isoFromDate(dateObj) {
  if (!dateObj) return "";
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day); // Monday start
  date.setDate(date.getDate() + diff);
  date.setHours(12, 0, 0, 0);
  return date;
}
function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(12, 0, 0, 0);
  return e;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0);
}
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12, 0, 0, 0);
}
function safeText(s) {
  return (s ?? "").toString();
}
function uniq(arr) {
  return Array.from(new Set(arr));
}
function normalizeType(t) {
  const v = (t || "").toLowerCase().trim();
  if (!v) return "";
  if (v === "event" || v === "meeting" || v === "task") return v;
  return v;
}
function priorityNum(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 999;
  return n;
}
function dlFile(filename, content, mime = "application/json") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2200);
}

/* ---------- Overlays ---------- */
function defaultOverlays() {
  return {
    version: OVERLAYS_VERSION,
    updated_at: new Date().toISOString(),
    deletions: [],
    task_overrides: {},   // id -> patch
    new_tasks: [],        // full objects
    recurrence_overrides: {} // recId -> {enabled:boolean}
  };
}
function loadOverlays() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultOverlays();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return defaultOverlays();
    return {
      ...defaultOverlays(),
      ...obj,
      deletions: Array.isArray(obj.deletions) ? obj.deletions : [],
      new_tasks: Array.isArray(obj.new_tasks) ? obj.new_tasks : [],
      task_overrides: obj.task_overrides && typeof obj.task_overrides === "object" ? obj.task_overrides : {},
      recurrence_overrides: obj.recurrence_overrides && typeof obj.recurrence_overrides === "object" ? obj.recurrence_overrides : {}
    };
  } catch {
    return defaultOverlays();
  }
}
function saveOverlays(overlays) {
  overlays.updated_at = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overlays));
  updateStorageInfo(overlays);
}

/* ---------- Merge ---------- */
function mergeData(base, overlays) {
  const baseTasks = Array.isArray(base.tasks) ? base.tasks : [];
  const baseEvents = Array.isArray(base.events) ? base.events : [];
  const recRules = Array.isArray(base.recurrence_rules) ? base.recurrence_rules : [];

  const deletions = new Set(overlays.deletions || []);
  const overrides = overlays.task_overrides || {};
  const newTasks = overlays.new_tasks || [];

  // a) deletions
  let tasks = baseTasks.filter(t => t && t.id && !deletions.has(t.id));
  let events = baseEvents.filter(e => e && e.id && !deletions.has(e.id));

  // b) patches
  tasks = tasks.map(t => overrides[t.id] ? { ...t, ...overrides[t.id] } : t);
  events = events.map(e => overrides[e.id] ? { ...e, ...overrides[e.id] } : e);

  // c) append new tasks
  const appended = [];
  for (const nt of newTasks) {
    if (!nt || !nt.id) continue;
    if (deletions.has(nt.id)) continue;
    appended.push(nt);
  }
  tasks = tasks.concat(appended);

  return { ...base, tasks, events, recurrence_rules: recRules, __overlays: overlays };
}

/* ---------- State ---------- */
const state = {
  base: null,
  overlays: loadOverlays(),
  merged: null,
  view: "today",
  actionId: null,
  filters: {
    pillar: "any",
    owner_id: "any",
    month: "any",
    status: "any",
    q: ""
  },
  sort: "due",
  ai: {
    ops: null
  }
};

/* ---------- Base truth fetch ---------- */
async function loadBase() {
  const res = await fetch("./tasks.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load tasks.json (${res.status})`);
  return await res.json();
}

/* ---------- Derived lists ---------- */
function ownersList(base) {
  const arr = base.owners || base.people || [];
  return Array.isArray(arr) ? arr : [];
}
function pillarsList(base) {
  const p = base.pillars;
  if (Array.isArray(p) && p.length) return p;
  const ts = Array.isArray(base.tasks) ? base.tasks : [];
  const codes = uniq(ts.map(t => t?.pillar).filter(Boolean)).sort();
  return codes.map(code => ({ code, name: code }));
}
function ownerName(ownerId) {
  const base = state.merged || state.base || {};
  const owners = ownersList(base);
  const found = owners.find(o => o.owner_id === ownerId || o.id === ownerId);
  return found ? (found.name || ownerId) : (ownerId || "—");
}
function pillarLabel(pillarCode) {
  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const found = pillars.find(p => p.code === pillarCode || p.id === pillarCode || p.pillar === pillarCode);
  return found ? (found.name || found.label || pillarCode) : (pillarCode || "—");
}
function getStatus(t) {
  const patch = state.overlays.task_overrides?.[t.id] || {};
  const status = patch.status || t.status || "";
  return status === "completed" ? "completed" : "open";
}
function isDone(t) { return getStatus(t) === "completed"; }
function isOverdue(t, today) {
  if (isDone(t)) return false;
  const due = parseISODate(t.due_date);
  if (!due) return false;
  return due < today;
}
function matchesFilters(item) {
  const f = state.filters;

  const q = (f.q || "").trim().toLowerCase();
  if (q) {
    const hay = `${item.title || ""} ${item.notes || ""} ${item.id || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }

  if (f.pillar !== "any" && (item.pillar || "") !== f.pillar) return false;
  if (f.owner_id !== "any" && (item.owner_id || "") !== f.owner_id) return false;

  if (f.month !== "any") {
    const d = (item.due_date || item.start_date || "");
    if (!d.startsWith(f.month)) return false;
  }

  if (f.status !== "any") {
    if (f.status === "completed" && item.__status !== "completed") return false;
    if (f.status === "open" && item.__status !== "open") return false;
  }

  return true;
}

function sortItems(items) {
  const today = parseISODate(todayLocalISO());
  const getKey = (it) => {
    if (state.sort === "priority") return priorityNum(it.priority);
    const d = parseISODate(state.sort === "start" ? it.start_date : it.due_date) ||
              parseISODate(state.sort === "start" ? it.due_date : it.start_date);
    return d ? d.getTime() : 9e15;
  };

  return items.slice().sort((a, b) => {
    const ao = (a.__status === "open" && isOverdue(a, today)) ? 0 : 1;
    const bo = (b.__status === "open" && isOverdue(b, today)) ? 0 : 1;
    if (a.__status === "open" && b.__status === "open" && ao !== bo) return ao - bo;

    const ka = getKey(a);
    const kb = getKey(b);
    if (ka !== kb) return ka - kb;

    return safeText(a.title).localeCompare(safeText(b.title));
  });
}

function groupByDate(items) {
  const groups = new Map();
  for (const it of items) {
    const d = parseISODate(it.due_date) || parseISODate(it.start_date);
    const key = d ? isoFromDate(d) : "No date";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return Array.from(groups.entries()).sort((a, b) => {
    if (a[0] === "No date") return 1;
    if (b[0] === "No date") return -1;
    return a[0].localeCompare(b[0]);
  });
}

/* ---------- Build lists per view ---------- */
function buildTaskListForView(view, ignoreStatusFilter = false) {
  const merged = state.merged || {};
  const tasks = Array.isArray(merged.tasks) ? merged.tasks : [];

  const today = parseISODate(todayLocalISO());
  const wStart = startOfWeek(today);
  const wEnd = endOfWeek(today);
  const mStart = startOfMonth(today);
  const mEnd = endOfMonth(today);

  const decorated = tasks.map(t => ({
    ...t,
    __status: isDone(t) ? "completed" : "open",
    type: normalizeType(t.type) || "task"
  }));

  let list = decorated;

  if (view === "completed") list = list.filter(t => t.__status === "completed");
  else list = list.filter(t => t.__status === "open");

  if (view === "today") {
    list = list.filter(t => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      return d && isoFromDate(d) === isoFromDate(today);
    });
  } else if (view === "week") {
    list = list.filter(t => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      return d && d >= wStart && d <= wEnd;
    });
  } else if (view === "month") {
    list = list.filter(t => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      return d && d >= mStart && d <= mEnd;
    });
  } else if (view === "upcoming") {
    list = list.filter(t => {
      const d = parseISODate(t.due_date) || parseISODate(t.start_date);
      if (!d) return true;
      return d >= today;
    });
  }

  const rememberStatus = state.filters.status;
  if (ignoreStatusFilter) state.filters.status = "any";
  list = list.filter(matchesFilters);
  if (ignoreStatusFilter) state.filters.status = rememberStatus;

  list = sortItems(list);
  return list;
}

function buildEventsForView() {
  const merged = state.merged || {};
  const baseEvents = Array.isArray(merged.events) ? merged.events : [];
  const tasks = Array.isArray(merged.tasks) ? merged.tasks : [];

  const taskEvents = tasks
    .filter(t => {
      const type = normalizeType(t.type);
      return type === "event" || type === "meeting";
    })
    .map(t => ({ ...t, __from_tasks: true }));

  const combined = baseEvents.concat(taskEvents).map(e => ({
    ...e,
    __status: isDone(e) ? "completed" : "open",
    type: normalizeType(e.type) || (e.__from_tasks ? "event" : "event")
  }));

  const filtered = combined
    .filter(e => e.__status === "open")
    .filter(matchesFilters);

  return sortItems(filtered);
}

/* ---------- Rendering ---------- */
function viewTitleText(view) {
  const today = parseISODate(todayLocalISO());
  if (view === "today") return `Today (${isoFromDate(today)})`;
  if (view === "week") return `Week (${isoFromDate(startOfWeek(today))} → ${isoFromDate(endOfWeek(today))})`;
  if (view === "month") return `Month (${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")})`;
  if (view === "upcoming") return "Upcoming";
  if (view === "completed") return "Completed";
  if (view === "events") return "Events / Milestones";
  if (view === "pillars") return "Pillars Dashboard";
  if (view === "ai") return "AI Assistant";
  return "Tasks";
}

function updateMetaLine() {
  const base = state.base || {};
  const meta = base.meta || {};
  const tz = meta.timezone ? `• ${meta.timezone}` : "";
  const ver = meta.version ? `v${meta.version}` : "";
  const line = [ver, meta.last_updated ? `updated ${meta.last_updated}` : "", tz].filter(Boolean).join(" ");
  document.getElementById("metaLine").textContent = line || "Task Dashboard";
}
function updateStorageInfo(overlays) {
  const el = document.getElementById("storageInfo");
  try {
    const bytes = new Blob([JSON.stringify(overlays)]).size;
    el.textContent = `Local overlays: ${overlays.deletions.length} deletions • ${Object.keys(overlays.task_overrides||{}).length} patches • ${overlays.new_tasks.length} new • ~${Math.round(bytes/1024)} KB`;
  } catch {
    el.textContent = "Local overlays stored.";
  }
}
function renderSummary() {
  const list = buildTaskListForView("upcoming", true);
  const today = parseISODate(todayLocalISO());
  const wStart = startOfWeek(today);
  const wEnd = endOfWeek(today);

  const todayItems = list.filter(t => {
    const d = parseISODate(t.due_date) || parseISODate(t.start_date);
    return d && isoFromDate(d) === isoFromDate(today);
  });
  const weekItems = list.filter(t => {
    const d = parseISODate(t.due_date) || parseISODate(t.start_date);
    return d && d >= wStart && d <= wEnd;
  });
  const overdue = list.filter(t => isOverdue(t, today));

  document.getElementById("sumToday").textContent = String(todayItems.length);
  document.getElementById("sumWeek").textContent = String(weekItems.length);
  document.getElementById("sumOverdue").textContent = String(overdue.length);
}

function renderRecurring() {
  const base = state.merged || {};
  const rules = Array.isArray(base.recurrence_rules) ? base.recurrence_rules : [];
  const panel = document.getElementById("recurringPanel");

  if (!rules.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const overrides = state.overlays.recurrence_overrides || {};
  panel.innerHTML = `
    <div class="recHead">
      <strong>Recurring</strong>
      <span class="muted small">${rules.length} rule(s)</span>
    </div>
    ${rules.map(r => {
      const enabled = overrides[r.id]?.enabled ?? true;
      const meta = [r.frequency, r.day_of_week].filter(Boolean).join(" ");
      return `
        <div class="rule">
          <div>
            <strong>${safeText(r.title || r.id)}</strong>
            <div class="muted small">${safeText(r.pillar || "")} ${meta ? "• " + meta : ""}</div>
            ${r.notes ? `<div class="muted small">${safeText(r.notes)}</div>` : ""}
          </div>
          <button class="toggle ${enabled ? "on":""}" data-rec="${r.id}" aria-label="Toggle recurrence">
            <span class="dot"></span>
          </button>
        </div>
      `;
    }).join("")}
  `;

  panel.querySelectorAll(".toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.rec;
      const cur = state.overlays.recurrence_overrides?.[id]?.enabled ?? true;
      if (!state.overlays.recurrence_overrides) state.overlays.recurrence_overrides = {};
      state.overlays.recurrence_overrides[id] = { enabled: !cur };
      saveOverlays(state.overlays);
      renderRecurring();
      toast(!cur ? "Recurring enabled" : "Recurring disabled");
    });
  });
}

function renderPillarsDash() {
  const dash = document.getElementById("pillarsDash");
  const byPillar = document.getElementById("dashByPillar");
  const byOwner = document.getElementById("dashByOwner");

  const open = buildTaskListForView("upcoming", true).filter(t => t.__status === "open");
  const today = parseISODate(todayLocalISO());

  function counts(groupKeyFn) {
    const map = new Map();
    for (const t of open) {
      const k = groupKeyFn(t) || "—";
      if (!map.has(k)) map.set(k, { total: 0, overdue: 0, p1: 0 });
      const c = map.get(k);
      c.total += 1;
      if (isOverdue(t, today)) c.overdue += 1;
      if (String(t.priority) === "1") c.p1 += 1;
    }
    return Array.from(map.entries()).sort((a, b) => b[1].total - a[1].total);
  }

  const pillarCounts = counts(t => t.pillar);
  const ownerCounts = counts(t => t.owner_id);

  byPillar.innerHTML = pillarCounts.map(([k, c]) => `
    <div class="dashRow" data-pillar="${k}">
      <div>
        <div><strong>${pillarLabel(k)}</strong></div>
        <small>${k}</small>
      </div>
      <div class="kpis">
        <span class="kpi">${c.total} open</span>
        <span class="kpi ${c.overdue ? "danger":""}">${c.overdue} overdue</span>
        <span class="kpi">${c.p1} P1</span>
      </div>
    </div>
  `).join("") || `<div class="muted small">No open tasks.</div>`;

  byOwner.innerHTML = ownerCounts.map(([k, c]) => `
    <div class="dashRow" data-owner="${k}">
      <div>
        <div><strong>${ownerName(k)}</strong></div>
        <small>${k}</small>
      </div>
      <div class="kpis">
        <span class="kpi">${c.total} open</span>
        <span class="kpi ${c.overdue ? "danger":""}">${c.overdue} overdue</span>
        <span class="kpi">${c.p1} P1</span>
      </div>
    </div>
  `).join("") || `<div class="muted small">No open tasks.</div>`;

  dash.hidden = !(state.view === "pillars");

  // Tap a row to filter quickly (no extra UI weight)
  dash.querySelectorAll("[data-pillar]").forEach(row => {
    row.addEventListener("click", () => {
      state.filters.pillar = row.dataset.pillar;
      document.getElementById("filterPillar").value = state.filters.pillar;
      setView("upcoming");
      toast(`Filtered: ${row.dataset.pillar}`);
    });
  });
  dash.querySelectorAll("[data-owner]").forEach(row => {
    row.addEventListener("click", () => {
      state.filters.owner_id = row.dataset.owner;
      document.getElementById("filterOwner").value = state.filters.owner_id;
      setView("upcoming");
      toast(`Filtered: ${row.dataset.owner}`);
    });
  });
}

function renderList() {
  const listEl = document.getElementById("list");
  listEl.innerHTML = "";

  // AI view
  document.getElementById("aiView").hidden = state.view !== "ai";

  // Pillars view
  renderPillarsDash();

  // List view
  if (state.view === "pillars" || state.view === "ai") return;

  let items = [];
  if (state.view === "events") items = buildEventsForView();
  else items = buildTaskListForView(state.view);

  if (!items.length) {
    listEl.innerHTML = `<div class="muted" style="padding:18px 6px">Nothing here. Quick Add to capture something.</div>`;
    return;
  }

  if (state.view === "completed") {
    const groups = new Map();
    for (const it of items) {
      const patch = state.overlays.task_overrides?.[it.id] || {};
      const c = patch.completed_at ? new Date(patch.completed_at) : null;
      const key = c ? isoFromDate(c) : "Completed";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const sorted = Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
    for (const [k, arr] of sorted) {
      const h = document.createElement("div");
      h.className = "groupTitle";
      h.textContent = k;
      listEl.appendChild(h);
      arr.forEach(it => listEl.appendChild(renderCard(it)));
    }
    return;
  }

  const grouped = groupByDate(items);
  for (const [k, arr] of grouped) {
    const h = document.createElement("div");
    h.className = "groupTitle";
    h.textContent = k;
    listEl.appendChild(h);
    arr.forEach(it => listEl.appendChild(renderCard(it)));
  }
}

function renderCard(t) {
  const today = parseISODate(todayLocalISO());
  const due = parseISODate(t.due_date);
  const start = parseISODate(t.start_date);
  const overdue = isOverdue(t, today);

  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = t.id || "";
  if (t.pillar) card.dataset.pillar = t.pillar;

  const box = document.createElement("button");
  box.className = "checkbox" + (t.__status === "completed" ? " is-done" : "");
  box.setAttribute("aria-label", t.__status === "completed" ? "Mark as not completed" : "Mark as completed");
  box.innerHTML = `<span aria-hidden="true">${t.__status === "completed" ? "✓" : ""}</span>`;
  box.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleComplete(t.id);
  });

  const main = document.createElement("div");
  main.className = "card__main";

  const title = document.createElement("h3");
  title.className = "card__title" + (t.__status === "completed" ? " done" : "");
  title.textContent = safeText(t.title || "(untitled)");

  const meta = document.createElement("div");
  meta.className = "card__meta";

  const pill = document.createElement("span");
  pill.className = "badge accent";
  pill.textContent = pillarLabel(t.pillar);

  const own = document.createElement("span");
  own.className = "badge";
  own.textContent = ownerName(t.owner_id);

  const d = document.createElement("span");
  d.className = "badge" + (overdue ? " danger" : "");
  d.textContent = due ? `due ${isoFromDate(due)}` : (start ? `start ${isoFromDate(start)}` : "no date");

  const pr = document.createElement("span");
  pr.className = "badge ok";
  pr.textContent = `P${t.priority ?? 2}`;

  const tp = document.createElement("span");
  tp.className = "badge";
  tp.textContent = normalizeType(t.type) || "task";

  meta.append(pill, own, d, pr, tp);

  main.append(title, meta);

  if (t.notes) {
    const notes = document.createElement("div");
    notes.className = "notes";
    notes.textContent = safeText(t.notes);
    main.appendChild(notes);
  }

  // Tap = edit
  card.addEventListener("click", () => openEdit(t.id));

  // Long-press = actions
  attachLongPress(card, () => openActions(t.id, t.title));

  card.append(box, main);
  return card;
}

function render() {
  document.getElementById("viewTitle").textContent = viewTitleText(state.view);
  renderSummary();
  renderRecurring();
  renderList();
}

/* ---------- View switching ---------- */
function setView(view) {
  state.view = view;
  document.querySelectorAll(".tab").forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("is-active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  render();
}

/* ---------- Long press ---------- */
function attachLongPress(el, onLongPress) {
  let timer = null;
  let moved = false;

  const start = () => {
    moved = false;
    timer = setTimeout(() => {
      if (!moved) onLongPress();
    }, 420);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchmove", () => { moved = true; cancel(); }, { passive: true });

  el.addEventListener("mousedown", start);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  el.addEventListener("mousemove", () => { moved = true; cancel(); });
}

/* ---------- Overlay mutations ---------- */
function ensurePatch(id) {
  if (!state.overlays.task_overrides[id]) state.overlays.task_overrides[id] = {};
  return state.overlays.task_overrides[id];
}

function toggleComplete(id) {
  const merged = state.merged || {};
  const all = (merged.tasks || []).concat(merged.events || []);
  const item = all.find(x => x.id === id);
  if (!item) return;

  const patch = ensurePatch(id);
  const nowDone = !(getStatus(item) === "completed");
  patch.status = nowDone ? "completed" : "open";
  patch.completed_at = nowDone ? new Date().toISOString() : null;

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast(nowDone ? "Completed" : "Undone");
  render();
}

function deleteItem(id) {
  if (!id) return;
  if (!state.overlays.deletions.includes(id)) state.overlays.deletions.push(id);
  delete state.overlays.task_overrides[id];
  state.overlays.new_tasks = state.overlays.new_tasks.filter(t => t.id !== id);

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Deleted (overlay)");
  render();
}

function moveToToday(id) {
  const patch = ensurePatch(id);
  const today = todayLocalISO();
  patch.start_date = today;
  patch.due_date = today;
  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Moved to Today");
  render();
}

/* ---------- Sheets ---------- */
function openSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = false;
}
function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = true;
}
function openQuickAdd() {
  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const owners = ownersList(base);

  document.getElementById("qaTitle").value = "";
  document.getElementById("qaNotes").value = "";
  document.getElementById("qaStart").value = "";
  document.getElementById("qaDue").value = "";
  document.getElementById("qaType").value = "task";
  document.getElementById("qaPriority").value = "2";

  document.getElementById("qaPillar").innerHTML =
    `<option value="">—</option>` + pillars.map(p => `<option value="${p.code || p.id || p.pillar}">${safeText(p.name || p.label || p.code)}</option>`).join("");
  document.getElementById("qaOwner").innerHTML =
    `<option value="">—</option>` + owners.map(o => `<option value="${o.owner_id || o.id}">${safeText(o.name || o.owner_id || o.id)}</option>`).join("");

  openSheet("quickAddSheet");
  setTimeout(() => document.getElementById("qaTitle").focus(), 60);
}
function saveQuickAdd() {
  const title = safeText(document.getElementById("qaTitle").value).trim();
  if (!title) return toast("Title required");

  const newId = `temp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const task = {
    id: newId,
    title,
    notes: safeText(document.getElementById("qaNotes").value || ""),
    start_date: document.getElementById("qaStart").value || null,
    due_date: document.getElementById("qaDue").value || null,
    type: document.getElementById("qaType").value || "task",
    priority: Number(document.getElementById("qaPriority").value || 2),
    pillar: document.getElementById("qaPillar").value || null,
    owner_id: document.getElementById("qaOwner").value || null
  };

  state.overlays.new_tasks.push(task);
  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);

  closeSheet("quickAddSheet");
  toast("Added");
  render();
}

function openEdit(id) {
  const merged = state.merged || {};
  const all = (merged.tasks || []).concat(merged.events || []);
  const item = all.find(x => x.id === id);
  if (!item) return;

  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const owners = ownersList(base);

  document.getElementById("editId").value = id;
  document.getElementById("editTitle").value = item.title || "";
  document.getElementById("editNotes").value = item.notes || "";
  document.getElementById("editStart").value = item.start_date || "";
  document.getElementById("editDue").value = item.due_date || "";
  document.getElementById("editType").value = normalizeType(item.type) || "";
  document.getElementById("editPriority").value = (item.priority ?? "").toString();

  document.getElementById("editPillar").innerHTML =
    `<option value="">—</option>` + pillars.map(p => {
      const code = p.code || p.id || p.pillar;
      const label = safeText(p.name || p.label || code);
      return `<option value="${code}" ${code === item.pillar ? "selected":""}>${label}</option>`;
    }).join("");

  document.getElementById("editOwner").innerHTML =
    `<option value="">—</option>` + owners.map(o => {
      const oid = o.owner_id || o.id;
      const label = safeText(o.name || oid);
      return `<option value="${oid}" ${oid === item.owner_id ? "selected":""}>${label}</option>`;
    }).join("");

  openSheet("editSheet");
}
function saveEdit() {
  const id = document.getElementById("editId").value;
  if (!id) return;

  const patch = {
    title: safeText(document.getElementById("editTitle").value).trim(),
    notes: safeText(document.getElementById("editNotes").value || ""),
    start_date: document.getElementById("editStart").value || null,
    due_date: document.getElementById("editDue").value || null,
    type: document.getElementById("editType").value || null,
    priority: document.getElementById("editPriority").value ? Number(document.getElementById("editPriority").value) : null,
    pillar: document.getElementById("editPillar").value || null,
    owner_id: document.getElementById("editOwner").value || null
  };

  // If temp task exists in new_tasks, edit it there to keep stable temp ID
  const idx = state.overlays.new_tasks.findIndex(t => t.id === id);
  if (idx !== -1) {
    state.overlays.new_tasks[idx] = { ...state.overlays.new_tasks[idx], ...patch };
  } else {
    const p = ensurePatch(id);
    Object.assign(p, patch);
  }

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  closeSheet("editSheet");
  toast("Saved");
  render();
}

function openActions(id, title) {
  state.actionId = id;
  document.getElementById("actionTitle").textContent = safeText(title || id);
  openSheet("actionSheet");
}

/* ---------- Export / Import ---------- */
function exportOverlays() {
  dlFile("overrides.json", JSON.stringify(state.overlays, null, 2));
}
function importOverlays() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const txt = await f.text();
    try {
      const obj = JSON.parse(txt);
      // soft-merge into defaults to avoid missing keys
      state.overlays = { ...defaultOverlays(), ...obj };
      saveOverlays(state.overlays);
      state.merged = mergeData(state.base, state.overlays);
      toast("Imported overlays");
      render();
    } catch {
      toast("Invalid JSON");
    }
  };
  input.click();
}
function backupMerged() {
  dlFile("merged.json", JSON.stringify(state.merged, null, 2));
}
function resetOverlays() {
  if (!confirm("Reset local overlays? This deletes completions, edits, and new tasks.")) return;
  state.overlays = defaultOverlays();
  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  toast("Reset");
  render();
}

/* ===========================
   AI INTEGRATION (Provider-agnostic)
   =========================== */

/* AI settings */
function defaultAiSettings() {
  return {
    provider: "openai",
    model: "",
    endpoint: "",
    headersJson: "",
    rememberKey: false,
    apiKey: ""
  };
}
function loadAiSettings() {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (!raw) return defaultAiSettings();
    const obj = JSON.parse(raw);
    return { ...defaultAiSettings(), ...obj };
  } catch {
    return defaultAiSettings();
  }
}
function saveAiSettings(s) {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(s));
}
function fillAiSettingsUI() {
  const s = loadAiSettings();
  document.getElementById("aiProvider").value = s.provider || "openai";
  document.getElementById("aiModel").value = s.model || "";
  document.getElementById("aiEndpoint").value = s.endpoint || "";
  document.getElementById("aiHeaders").value = s.headersJson || "";
  document.getElementById("aiRememberKey").checked = !!s.rememberKey;
  document.getElementById("aiKey").value = s.rememberKey ? (s.apiKey || "") : "";
}
function readAiSettingsFromUI() {
  const provider = document.getElementById("aiProvider").value;
  const model = document.getElementById("aiModel").value.trim();
  const endpoint = document.getElementById("aiEndpoint").value.trim();
  const headersJson = document.getElementById("aiHeaders").value.trim();
  const rememberKey = document.getElementById("aiRememberKey").checked;
  const apiKey = document.getElementById("aiKey").value;

  return { provider, model, endpoint, headersJson, rememberKey, apiKey };
}
function setAiStatus(text, kind = "info") {
  const el = document.getElementById("aiStatus");
  el.hidden = !text;
  if (!text) return;
  el.textContent = text;
  el.style.borderColor = kind === "error" ? "rgba(251,113,133,.35)" : "rgba(94,234,212,.25)";
  el.style.background = kind === "error" ? "rgba(251,113,133,.08)" : "rgba(94,234,212,.06)";
}

/* Create a compact context for the model (fast + privacy-aware) */
function buildAiContext() {
  const merged = state.merged || {};
  const tasks = Array.isArray(merged.tasks) ? merged.tasks : [];
  const events = Array.isArray(merged.events) ? merged.events : [];
  const today = todayLocalISO();

  // Keep only essential fields and limit length
  const pick = (x) => ({
    id: x.id,
    title: x.title || "",
    pillar: x.pillar || "",
    owner_id: x.owner_id || "",
    start_date: x.start_date || null,
    due_date: x.due_date || null,
    priority: x.priority ?? null,
    type: normalizeType(x.type) || "task",
    status: isDone(x) ? "completed" : "open",
    notes: (x.notes || "").slice(0, 240)
  });

  // Provide: open items first, small window (avoid huge token loads)
  const open = tasks.filter(t => !isDone(t)).slice(0, 220).map(pick);
  const doneRecent = tasks.filter(t => isDone(t)).slice(0, 40).map(pick);
  const evOpen = events.filter(e => !isDone(e)).slice(0, 60).map(pick);

  return {
    today,
    filters: { ...state.filters, sort: state.sort, view: state.view },
    open_tasks: open,
    recent_completed: doneRecent,
    open_events: evOpen
  };
}

/* Operation schema (safe) */
function aiSystemInstruction() {
  return `
You are an assistant helping manage tasks in a phone-first dashboard.
Base truth tasks.json is read-only. Changes must be expressed as "operations" to be applied as overlays.

Return ONLY valid JSON with this exact shape:
{
  "summary": "one short sentence",
  "ops": [
    {
      "op": "add" | "update" | "complete" | "undo_complete" | "delete",
      "id": "existing-id-or-temp-id-if-needed",
      "fields": { ... } ,       // for add/update only
      "reason": "short reason"
    }
  ]
}

Rules:
- Never rewrite everything; prefer small targeted ops.
- For "add": fields must include at least { "title": "...", "type": "task|meeting|event" }.
- For "update": include only changed fields in "fields".
- For "complete"/"undo_complete": no "fields" needed.
- For "delete": no "fields" needed.
- Dates must be YYYY-MM-DD or null.
- Priority should be 1-4 if provided.
- If unsure, ask for fewer changes (smaller ops list).
`;
}

/* Helpers to safely parse AI output */
function tryParseJsonFromText(txt) {
  // Many models return pure JSON; some wrap in text. Extract first {...} block.
  const direct = txt.trim();
  if (direct.startsWith("{") && direct.endsWith("}")) {
    try { return JSON.parse(direct); } catch {}
  }
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}
function validateOps(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, error: "Not an object" };
  if (!Array.isArray(payload.ops)) return { ok: false, error: "Missing ops[]" };
  const allowed = new Set(["add","update","complete","undo_complete","delete"]);
  for (const op of payload.ops) {
    if (!op || typeof op !== "object") return { ok: false, error: "Bad op object" };
    if (!allowed.has(op.op)) return { ok: false, error: `Unsupported op: ${op.op}` };
    if (!op.id || typeof op.id !== "string") return { ok: false, error: "Op missing id" };
    if ((op.op === "add" || op.op === "update") && (!op.fields || typeof op.fields !== "object")) {
      return { ok: false, error: "add/update must include fields{}" };
    }
  }
  return { ok: true };
}

/* Provider adapters */
async function aiCall(settings, system, user, contextObj) {
  const provider = settings.provider;
  const model = settings.model || "";
  const endpointOverride = settings.endpoint || "";
  const key = settings.apiKey || "";

  // headers: user may supply extra headers JSON with {{KEY}}
  let extraHeaders = {};
  if (settings.headersJson) {
    try {
      extraHeaders = JSON.parse(settings.headersJson.replaceAll("{{KEY}}", key));
    } catch {
      // ignore invalid headers json
    }
  }

  const ctxStr = JSON.stringify(contextObj);

  // OpenAI default
  if (provider === "openai") {
    const url = endpointOverride || "https://api.openai.com/v1/chat/completions";
    const body = {
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `CONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }
      ],
      temperature: 0.2
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `OpenAI error (${res.status})`);
    return json?.choices?.[0]?.message?.content ?? "";
  }

  // Anthropic Messages API
  if (provider === "anthropic") {
    const url = endpointOverride || "https://api.anthropic.com/v1/messages";
    const body = {
      model: model || "claude-3-5-sonnet-20240620",
      max_tokens: 1200,
      temperature: 0.2,
      system,
      messages: [
        { role: "user", content: `CONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }
      ]
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Anthropic error (${res.status})`);
    // Anthropic returns content array
    return (json?.content || []).map(x => x?.text || "").join("\n");
  }

  // Gemini
  if (provider === "gemini") {
    const m = model || "gemini-1.5-flash";
    const url = endpointOverride
      || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [
        { role: "user", parts: [{ text: `${system}\n\nCONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }] }
      ],
      generationConfig: { temperature: 0.2 }
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Gemini error (${res.status})`);
    const txt = json?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") || "";
    return txt;
  }

  // OpenAI-compatible custom
  if (provider === "openai_compat") {
    const url = endpointOverride || "http://localhost:11434/v1/chat/completions";
    const body = {
      model: model || "llama3.1",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `CONTEXT:\n${ctxStr}\n\nREQUEST:\n${user}` }
      ],
      temperature: 0.2
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { "Authorization": `Bearer ${key}` } : {}), ...extraHeaders },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `OpenAI-compatible error (${res.status})`);
    return json?.choices?.[0]?.message?.content ?? "";
  }

  // Fully custom endpoint
  // Expected: endpoint returns either {text:"..."} or raw text
  if (provider === "custom") {
    const url = endpointOverride;
    if (!url) throw new Error("Custom provider needs an endpoint URL");
    const body = {
      system,
      user,
      context: contextObj,
      model
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body)
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`Custom error (${res.status})`);
    try {
      const j = JSON.parse(txt);
      return j.text || j.output || txt;
    } catch {
      return txt;
    }
  }

  throw new Error("Unsupported provider");
}

function renderAiOps(payload) {
  state.ai.ops = payload;
  const wrap = document.getElementById("aiOps");
  const list = document.getElementById("aiOpsList");
  const count = document.getElementById("aiOpsCount");

  const ops = payload?.ops || [];
  count.textContent = `${ops.length} ops`;
  list.innerHTML = ops.map((o, idx) => {
    const fields = o.fields ? `<pre class="muted small" style="margin:8px 0 0;white-space:pre-wrap">${safeText(JSON.stringify(o.fields, null, 2))}</pre>` : "";
    return `
      <div class="ai-op">
        <div class="ai-op__top">
          <span class="ai-op__kind">${safeText(o.op)}</span>
          <span class="muted small">${safeText(o.id)}</span>
        </div>
        <div class="muted small" style="margin-top:6px">${safeText(o.reason || "")}</div>
        ${fields}
      </div>
    `;
  }).join("") || `<div class="muted small">No operations returned.</div>`;

  wrap.hidden = false;
  toast(payload?.summary ? `AI: ${payload.summary}` : "AI suggestions ready");
}

function applyAiOpsToOverlays(payload) {
  const ops = payload?.ops || [];
  if (!ops.length) return toast("No ops to apply");

  for (const o of ops) {
    if (o.op === "add") {
      // Keep stable temp id if AI provides one; else generate one.
      const id = o.id.startsWith("temp_") ? o.id : `temp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      const fields = o.fields || {};
      const task = {
        id,
        title: safeText(fields.title || "Untitled"),
        type: normalizeType(fields.type) || "task",
        pillar: fields.pillar ?? null,
        owner_id: fields.owner_id ?? null,
        start_date: fields.start_date ?? null,
        due_date: fields.due_date ?? null,
        priority: fields.priority ?? 2,
        notes: safeText(fields.notes || "")
      };
      state.overlays.new_tasks.push(task);
    }

    if (o.op === "update") {
      const patch = ensurePatch(o.id);
      Object.assign(patch, o.fields || {});
    }

    if (o.op === "complete") {
      const patch = ensurePatch(o.id);
      patch.status = "completed";
      patch.completed_at = new Date().toISOString();
    }

    if (o.op === "undo_complete") {
      const patch = ensurePatch(o.id);
      patch.status = "open";
      patch.completed_at = null;
    }

    if (o.op === "delete") {
      if (!state.overlays.deletions.includes(o.id)) state.overlays.deletions.push(o.id);
      delete state.overlays.task_overrides[o.id];
      state.overlays.new_tasks = state.overlays.new_tasks.filter(t => t.id !== o.id);
    }
  }

  saveOverlays(state.overlays);
  state.merged = mergeData(state.base, state.overlays);
  state.ai.ops = null;
  document.getElementById("aiOps").hidden = true;
  toast("Applied AI ops to overlays");
  render();
}

async function runAiSuggestion(userText) {
  const s = readAiSettingsFromUI();
  const stored = loadAiSettings();
  const keyToUse = s.rememberKey ? (stored.apiKey || s.apiKey) : s.apiKey;

  const settings = { ...s, apiKey: keyToUse };

  if (!settings.apiKey && settings.provider !== "openai_compat") {
    setAiStatus("Add an API key (or use OpenAI-compatible local endpoint).", "error");
    return;
  }

  // Save settings if user opted-in
  if (s.rememberKey) {
    saveAiSettings({ ...s, apiKey: s.apiKey });
  } else {
    saveAiSettings({ ...s, apiKey: "" });
  }

  setAiStatus("Thinking…");
  const ctx = buildAiContext();
  const system = aiSystemInstruction();
  const user = userText;

  try {
    const txt = await aiCall(settings, system, user, ctx);
    const payload = tryParseJsonFromText(txt);
    if (!payload) {
      setAiStatus("AI returned text that was not valid JSON. Try again with a shorter request.", "error");
      return;
    }
    const v = validateOps(payload);
    if (!v.ok) {
      setAiStatus(`AI JSON invalid: ${v.error}`, "error");
      return;
    }
    setAiStatus("");
    renderAiOps(payload);
  } catch (e) {
    setAiStatus(String(e?.message || e), "error");
  }
}

/* ---------- Wire UI ---------- */
function initFilterOptions() {
  const base = state.merged || state.base || {};
  const pillars = pillarsList(base);
  const owners = ownersList(base);

  const pillarSel = document.getElementById("filterPillar");
  pillarSel.innerHTML = `<option value="any">All Pillars</option>` +
    pillars.map(p => {
      const code = p.code || p.id || p.pillar;
      const label = safeText(p.name || p.label || code);
      return `<option value="${code}">${label}</option>`;
    }).join("");

  const ownerSel = document.getElementById("filterOwner");
  ownerSel.innerHTML = `<option value="any">All Owners</option>` +
    owners.map(o => {
      const id = o.owner_id || o.id;
      const label = safeText(o.name || id);
      return `<option value="${id}">${label}</option>`;
    }).join("");

  // months from due_date
  const tasks = Array.isArray(base.tasks) ? base.tasks : [];
  const months = uniq(tasks.map(t => (t?.due_date || "").slice(0,7)).filter(Boolean)).sort().reverse();
  const monthSel = document.getElementById("filterMonth");
  monthSel.innerHTML = `<option value="any">All Months</option>` +
    months.map(m => `<option value="${m}">${m}</option>`).join("");
}

function wireUI() {
  // tabs
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  // filters
  document.getElementById("filterPillar").addEventListener("change", (e) => { state.filters.pillar = e.target.value; render(); });
  document.getElementById("filterOwner").addEventListener("change", (e) => { state.filters.owner_id = e.target.value; render(); });
  document.getElementById("filterMonth").addEventListener("change", (e) => { state.filters.month = e.target.value; render(); });
  document.getElementById("filterStatus").addEventListener("change", (e) => { state.filters.status = e.target.value; render(); });
  document.getElementById("searchInput").addEventListener("input", (e) => { state.filters.q = e.target.value; render(); });
  document.getElementById("sortBy").addEventListener("change", (e) => { state.sort = e.target.value; render(); });

  // filter toggle
  const filterbar = document.getElementById("filterbar");
  document.getElementById("btnToggleFilters").addEventListener("click", () => {
    filterbar.hidden = !filterbar.hidden;
  });

  // more
  document.getElementById("btnMore").addEventListener("click", () => openSheet("moreSheet"));
  document.getElementById("btnExportOverlays").addEventListener("click", exportOverlays);
  document.getElementById("btnImportOverlays").addEventListener("click", importOverlays);
  document.getElementById("btnBackupMerged").addEventListener("click", backupMerged);
  document.getElementById("btnResetOverlays").addEventListener("click", resetOverlays);

  // close sheets via backdrop
  document.querySelectorAll("[data-close]").forEach(el => {
    el.addEventListener("click", () => closeSheet(el.dataset.close));
  });

  // FAB / Quick add
  document.getElementById("fab").addEventListener("click", openQuickAdd);
  document.getElementById("btnQuickAdd").addEventListener("click", openQuickAdd);
  document.getElementById("btnQaSave").addEventListener("click", saveQuickAdd);

  // Edit save / delete
  document.getElementById("btnEditSave").addEventListener("click", saveEdit);
  document.getElementById("btnDelete").addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    if (!id) return;
    if (!confirm("Delete this item? (Stored as deletion overlay.)")) return;
    closeSheet("editSheet");
    deleteItem(id);
  });

  // Action sheet
  document.getElementById("btnActionComplete").addEventListener("click", () => { if (!state.actionId) return; toggleComplete(state.actionId); closeSheet("actionSheet"); });
  document.getElementById("btnActionEdit").addEventListener("click", () => { if (!state.actionId) return; closeSheet("actionSheet"); openEdit(state.actionId); });
  document.getElementById("btnActionToday").addEventListener("click", () => { if (!state.actionId) return; moveToToday(state.actionId); closeSheet("actionSheet"); });

  // Inbox capture
  const inboxInput = document.getElementById("inboxInput");
  document.getElementById("btnInboxAdd").addEventListener("click", () => {
    const v = inboxInput.value.trim();
    if (!v) return;
    // create a task with no dates by default; user can later refine
    const newId = `temp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    state.overlays.new_tasks.push({ id: newId, title: v, type: "task", priority: 2, notes: "", start_date: null, due_date: null, pillar: null, owner_id: null });
    inboxInput.value = "";
    saveOverlays(state.overlays);
    state.merged = mergeData(state.base, state.overlays);
    toast("Inbox captured");
    render();
  });
  inboxInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btnInboxAdd").click();
  });

  // AI UI
  fillAiSettingsUI();

  document.getElementById("btnAiSave").addEventListener("click", () => {
    const s = readAiSettingsFromUI();
    saveAiSettings({ ...s, apiKey: s.rememberKey ? s.apiKey : "" });
    toast("AI settings saved");
  });
  document.getElementById("btnAiClear").addEventListener("click", () => {
    saveAiSettings(defaultAiSettings());
    fillAiSettingsUI();
    toast("AI settings cleared");
  });

  document.getElementById("btnAiSuggest").addEventListener("click", async () => {
    const prompt = document.getElementById("aiPrompt").value.trim();
    if (!prompt) return setAiStatus("Type what you want help with.", "error");
    await runAiSuggestion(prompt);
  });
  document.getElementById("btnAiPlanWeek").addEventListener("click", async () => {
    document.getElementById("aiPrompt").value = "Plan my week: propose what to do on each day, and reschedule tasks if needed (small changes).";
    await runAiSuggestion(document.getElementById("aiPrompt").value);
  });
  document.getElementById("btnAiTidy").addEventListener("click", async () => {
    document.getElementById("aiPrompt").value = "Tidy my tasks: find unclear titles, duplicates, missing owners/pillars, and suggest small fixes.";
    await runAiSuggestion(document.getElementById("aiPrompt").value);
  });

  document.getElementById("btnAiDiscard").addEventListener("click", () => {
    state.ai.ops = null;
    document.getElementById("aiOps").hidden = true;
    toast("Discarded AI ops");
  });
  document.getElementById("btnAiApply").addEventListener("click", () => {
    if (!state.ai.ops) return;
    if (!confirm("Apply these operations to overlays?")) return;
    applyAiOpsToOverlays(state.ai.ops);
  });

  // Escape closes all sheets
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    ["editSheet","quickAddSheet","moreSheet","actionSheet"].forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.hidden) el.hidden = true;
    });
  });
}

/* ---------- Boot ---------- */
async function boot() {
  wireUI();
  updateStorageInfo(state.overlays);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  try {
    state.base = await loadBase();
    updateMetaLine();
    state.merged = mergeData(state.base, state.overlays);
    initFilterOptions();
    render();
  } catch (e) {
    console.error(e);
    toast("Could not load tasks.json");
    document.getElementById("list").innerHTML =
      `<div class="muted" style="padding:18px 6px">
        <strong>Could not load tasks.json</strong><br>
        Host via http:// (not file://). tasks.json must be in the same folder.
      </div>`;
  }
}
boot();

const BASE = "https://fantasy.premierleague.com/api";
const DEBUG = false;
const FALLBACK_SCAN_MIN_INTERVAL_MS = 2500;
const SCHEDULE_DELAY_MS = 200;
const MAX_FALLBACK_TARGETS = 120;
const CAPTAIN_FETCH_CONCURRENCY = 6;
const NAME_SELECTORS = '[data-testid="player-name"], [data-testid="pitch-element-player-name"], .PitchElementData__Name, .PitchElement__Name, [class*="PitchElementData__Name"], [class*="PitchElement__Name"]';
const LEAGUE_GRID_TEMPLATE = "56px minmax(180px, 1fr) 64px 72px 96px";

let playerMap = {}; // web_name -> { id, element_type }
let playerById = {}; // id -> { web_name, element_type }
let cache = {};     // id -> { xgi90, mpg5, starts5, games, cs5, dc10Matches5, hasDC }
let currentEventId = null;
const pendingByContainer = new WeakMap(); // container -> Set(playerId)
const lastFallbackSuccessByView = new Map(); // viewId -> timestamp
const captainCache = new Map(); // `${entryId}:${eventId}` -> captain text
const captainPending = new Map(); // `${entryId}:${eventId}` -> Promise<string>
let scanInProgress = false;
let scanQueued = false;
let scheduledTimer = null;

const VIEWS = [
  {
    id: "my-team",
    matchRoute: (path) => /^\/my-team(?:\/|$)/.test(path),
    scan: scanPitchNameBadges
  },
  {
    id: "transfers",
    matchRoute: (path) => /^\/transfers(?:\/|$)/.test(path),
    scan: scanPitchNameBadges
  },
  {
    id: "entry",
    matchRoute: (path) => /^\/entry\/\d+(?:\/|$)/.test(path),
    scan: scanPitchNameBadges
  },
  {
    id: "leagues-standings",
    matchRoute: (path) => /^\/leagues\/\d+\/standings\/[^/]+(?:\/|$)/.test(path),
    scan: scanLeagueStandingsCaptains
  }
];

function debugLog(...args) {
  if (!DEBUG) return;
  console.log(...args);
}

function shouldAttemptScan() {
  if (!document.body) return false;
  const path = window.location.pathname || "/";
  return VIEWS.some((view) => view.matchRoute(path));
}

function shouldScheduleFromMutations(mutations) {
  for (const m of mutations) {
    if (m.type !== "childList") continue;
    if (m.addedNodes && m.addedNodes.length > 0) return true;
  }
  return false;
}

function scheduleScan() {
  if (scheduledTimer) return;
  scheduledTimer = setTimeout(async () => {
    scheduledTimer = null;
    await scan();
  }, SCHEDULE_DELAY_MS);
}

async function loadBootstrap() {
  try {
    const res = await fetch(`${BASE}/bootstrap-static/`);
    debugLog("bootstrap-static status:", res.status);
    if (!res.ok) {
      throw new Error(`bootstrap-static failed: HTTP ${res.status}`);
    }

    const data = await res.json();

    playerMap = {};
    playerById = {};
    data.elements.forEach((p) => {
      playerMap[p.web_name] = {
        id: p.id,
        element_type: p.element_type
      };
      playerById[p.id] = {
        web_name: p.web_name,
        element_type: p.element_type
      };
    });
    currentEventId = getCurrentEventId(data);

    debugLog("bootstrap loaded, players:", Object.keys(playerMap).length);
  } catch (e) {
    console.error("loadBootstrap failed", e);
  }
}

function getCurrentEventId(bootstrapData) {
  const events = Array.isArray(bootstrapData?.events) ? bootstrapData.events : [];
  const current = events.find((e) => e && (e.is_current || e.is_next));
  if (current && Number.isFinite(Number(current.id))) return Number(current.id);
  return null;
}

async function loadPlayerData(id) {
  if (cache[id]) return cache[id];

  try {
    const res = await fetch(`${BASE}/element-summary/${id}/`);
    // console.log("element-summary status", id, res.status);
    if (!res.ok) {
      throw new Error(`element-summary failed for ${id}: HTTP ${res.status}`);
    }
    const data = await res.json();

    const hist = Array.isArray(data.history) ? data.history : [];

    // Sort by round ascending just in case (API is usually ordered, but be explicit)
    const sorted = [...hist].sort((a, b) => Number(a.round ?? 0) - Number(b.round ?? 0));

    // Only count matches where the player actually played (minutes > 0)
    const played = sorted.filter(m => Number(m.minutes ?? 0) > 0);

    // Take last 5 played matches
    const last5 = played.slice(-5);

    // Debug: inspect available fields (uncomment temporarily)
    // if (last5[0]) console.log("history keys sample:", Object.keys(last5[0]));

    // FPL API field names may vary; handle both common variants.
    const pickXG = (row) => Number(row.xG ?? row.expected_goals ?? 0);
    const pickXA = (row) => Number(row.xA ?? row.expected_assists ?? 0);

    const games = last5.length || 1;

    const min5 = last5.reduce((sum, m) => sum + Number(m.minutes ?? 0), 0);
    const mpg5 = min5 / games;

    // starts: prefer explicit fields if present; otherwise fallback heuristic.
    const isStart = (m) => {
      if (m.starts != null) return Number(m.starts) > 0;
      if (m.started != null) return Number(m.started) > 0;
      // conservative fallback: treat 60+ minutes as a start
      return Number(m.minutes ?? 0) >= 60;
    };
    const starts5 = last5.reduce((sum, m) => sum + (isStart(m) ? 1 : 0), 0);

    // Clean Sheets over last 5 played matches
    const cs5 = last5.reduce((sum, m) => sum + (Number(m.clean_sheets ?? 0) > 0 ? 1 : 0), 0);

    // Defensive contributions: count matches where DC >= 10 (point-awarding threshold).
    // Field name may vary; if missing, we mark hasDC=false and show n/a in UI.
    const pickDC = (m) => {
      const v = m.defensive_contribution ?? m.defensive_contributions ?? m.def_contribution;
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    let hasDC = false;
    let dc10Matches5 = 0;
    for (const m of last5) {
      const v = pickDC(m);
      if (v == null) continue;
      hasDC = true;
      if (v >= 10) dc10Matches5 += 1;
    }

    const xg5 = last5.reduce((sum, m) => sum + pickXG(m), 0);
    const xa5 = last5.reduce((sum, m) => sum + pickXA(m), 0);

    const xgi5 = xg5 + xa5;
    const xgi90 = min5 > 0 ? (xgi5 / (min5 / 90)) : 0;

    cache[id] = {
      xgi90: xgi90.toFixed(2),
      mpg5: mpg5.toFixed(1),
      starts5,
      games,
      cs5,
      hasDC,
      dc10Matches5
    };

    return cache[id];
  } catch (e) {
    console.error("loadPlayerData failed", id, e);
    return null;
  }
}

function colorForXGI90(value) {
  const v = Number(value);
  if (v >= 0.8) return "#1db954";
  if (v >= 0.45) return "#e6b800";
  return "#d11a2a";
}

function getPlayerCardContainer(el) {
  return (
    el.closest('[data-testid="pitch-element"], [data-testid*="pitch-element"], [class*="PitchElement"], [class*="pitchElement"]') ||
    el.parentElement
  );
}

function beginInject(container, playerId) {
  let set = pendingByContainer.get(container);
  if (!set) {
    set = new Set();
    pendingByContainer.set(container, set);
  }
  if (set.has(playerId)) return false;
  set.add(playerId);
  return true;
}

function endInject(container, playerId) {
  const set = pendingByContainer.get(container);
  if (!set) return;
  set.delete(playerId);
  if (set.size === 0) pendingByContainer.delete(container);
}

async function injectUnderName(el) {
  const name = (el.textContent || "").trim();
  const player = playerMap[name];
  if (!player) return;
  const { id, element_type } = player;

  const container = getPlayerCardContainer(el);
  if (!container) return;

  // If we already have a badge for this player in this container, do nothing.
  const existingInContainer = container.querySelector(`.fpl-xg-badge[data-player-id="${id}"]`);
  if (existingInContainer) return;

  // Prevent async re-entrancy for this specific player in this specific container.
  if (!beginInject(container, id)) {
    return;
  }

  try {
    const stats = await loadPlayerData(id);
    if (!stats) return;

    // If another scan already inserted the badge while we awaited, just exit.
    const nowExists = container.querySelector(`.fpl-xg-badge[data-player-id="${id}"]`);
    if (nowExists) return;

    // Clean up only stale/duplicate badges for this same player.
    container.querySelectorAll(`.fpl-xg-badge[data-player-id="${id}"]`).forEach((n) => n.remove());

    const div = document.createElement("div");
    div.className = "fpl-xg-badge";
    div.dataset.playerId = String(id);
    div.style.fontSize = "11px";
    div.style.marginTop = "2px";
    div.style.fontWeight = "600";

    const isDef = element_type === 2; // 2 = Defender in FPL API

    div.innerHTML = `
      ${isDef
        ? `<span style="color:#cbd5e1">CS5: ${stats.cs5}/${stats.games} | DC10+: ${stats.hasDC ? `${stats.dc10Matches5}/${stats.games}` : "n/a"}</span><br />`
        : `<span style="color:${colorForXGI90(stats.xgi90)}">xGI/90: ${stats.xgi90}</span><br />`}
      <span style="color:#cbd5e1">mpg5: ${stats.mpg5}</span>
      | <span style="color:#cbd5e1">starts5: ${stats.starts5}/${stats.games}</span>
    `;

    container.appendChild(div);
  } finally {
    endInject(container, id);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function parseEntryIdFromHref(href) {
  const m = String(href || "").match(/\/entry\/(\d+)(?:\/|$)/);
  if (!m) return null;
  return Number(m[1]);
}

function getStandingsTable() {
  return (
    document.querySelector('table[aria-label*="Standings"]') ||
    document.querySelector('.react-aria-Table[role="grid"]') ||
    document.querySelector('table[role="grid"]')
  );
}

function getStandingsRows() {
  const table = getStandingsTable();
  if (!table) return [];
  return Array.from(table.querySelectorAll("tbody tr[role='row'], tbody tr"))
    .filter((row) => row.querySelector('a[href*="/entry/"]'));
}

function ensureCaptainHeader() {
  const table = getStandingsTable();
  if (!table) return;
  const headerRow = table.querySelector("thead tr");
  if (!headerRow) return;
  const existing = headerRow.querySelector(".fpl-captain-header");
  if (existing && existing.tagName !== "TH") existing.remove();
  if (headerRow.querySelector(".fpl-captain-header")) return;

  const h = document.createElement("th");
  h.className = "fpl-captain-header";
  h.setAttribute("role", "columnheader");
  h.textContent = "Captain";
  h.style.setProperty("min-width", "96px", "important");
  h.style.setProperty("font-weight", "600", "important");
  h.style.setProperty("color", "#cbd5e1", "important");
  h.style.setProperty("text-align", "left", "important");
  h.style.setProperty("padding-left", "8px", "important");
  h.style.setProperty("white-space", "nowrap", "important");
  headerRow.appendChild(h);
}

function applyLeagueGridLayout() {
  const table = getStandingsTable();
  if (!table) return;
  table.style.setProperty("width", "100%", "important");
  table.style.setProperty("table-layout", "fixed", "important");

  const rows = table.querySelectorAll("thead tr, tbody tr");
  rows.forEach((row) => {
    row.style.setProperty("display", "grid", "important");
    row.style.setProperty("grid-template-columns", LEAGUE_GRID_TEMPLATE, "important");
    row.style.setProperty("align-items", "center", "important");
  });

  const cells = table.querySelectorAll("th, td, [role='columnheader'], [role='gridcell'], [role='rowheader']");
  cells.forEach((cell) => {
    cell.style.setProperty("overflow", "hidden", "important");
    cell.style.setProperty("text-overflow", "ellipsis", "important");
  });
}

function injectCaptainIntoRow(row, captainText, eventId) {
  const hasTabularCells = Boolean(row.querySelector("td, [role='gridcell'], [role='rowheader']"));
  if (!hasTabularCells) return false;

  let cell = row.querySelector(".fpl-captain-cell");
  if (cell && cell.tagName !== "TD") {
    cell.remove();
    cell = null;
  }
  if (!cell) {
    cell = document.createElement("td");
    cell.className = "fpl-captain-cell";
    cell.setAttribute("role", "gridcell");
    cell.style.setProperty("min-width", "96px", "important");
    cell.style.setProperty("padding-left", "8px", "important");
    cell.style.setProperty("font-size", "12px", "important");
    cell.style.setProperty("color", "#e2e8f0", "important");
    cell.style.setProperty("white-space", "nowrap", "important");
    cell.style.setProperty("vertical-align", "middle", "important");
    row.appendChild(cell);
  }
  cell.textContent = captainText;
  cell.dataset.eventId = String(eventId);
  return true;
}

function cleanupStrayCaptainInline() {
  document.querySelectorAll(".fpl-captain-inline").forEach((n) => n.remove());
}

async function loadEntryCaptain(entryId, eventId) {
  const key = `${entryId}:${eventId}`;
  if (captainCache.has(key)) return captainCache.get(key);
  if (captainPending.has(key)) return captainPending.get(key);

  const p = (async () => {
    try {
      const res = await fetch(`${BASE}/entry/${entryId}/event/${eventId}/picks/`);
      if (!res.ok) throw new Error(`entry picks failed ${entryId}/${eventId}: HTTP ${res.status}`);
      const data = await res.json();
      const picks = Array.isArray(data?.picks) ? data.picks : [];
      const cap = picks.find((x) => x && x.is_captain);
      const elementId = Number(cap?.element);
      const name = playerById[elementId]?.web_name || (Number.isFinite(elementId) ? `#${elementId}` : "n/a");
      captainCache.set(key, name);
      return name;
    } catch (e) {
      debugLog("loadEntryCaptain failed", entryId, eventId, e);
      captainCache.set(key, "n/a");
      return "n/a";
    } finally {
      captainPending.delete(key);
    }
  })();

  captainPending.set(key, p);
  return p;
}

function getActiveViews(pathname) {
  return VIEWS.filter((view) => view.matchRoute(pathname));
}

async function scanPitchNameBadges(viewId) {
  // First try: known selectors (may change as FPL deploys new UI)
  const nameNodes = document.querySelectorAll(NAME_SELECTORS);

  if (Object.keys(playerMap).length === 0) {
    debugLog("scan skipped: playerMap empty");
    return;
  }

  if (nameNodes.length > 0) {
    debugLog(`[${viewId}] name nodes found (selector):`, nameNodes.length);
    const targets = [];
    for (const el of nameNodes) {
      const name = (el.textContent || "").trim();
      if (!name) continue;
      if (!playerMap[name]) continue;
      targets.push(el);
    }
    await mapWithConcurrency(targets, 6, injectUnderName);
    return;
  }

  const now = Date.now();
  const lastSuccess = lastFallbackSuccessByView.get(viewId) || 0;
  if (lastSuccess > 0 && now - lastSuccess < FALLBACK_SCAN_MIN_INTERVAL_MS) {
    return;
  }

  // Fallback: walk text nodes and match exact player web_name.
  // This is more robust across UI changes.
  debugLog(`[${viewId}] name nodes found (selector): 0 - using text-node fallback`);

  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const t = (node.nodeValue || "").trim();
      if (!t) return NodeFilter.FILTER_REJECT;
      // Only short single-token-ish names (FPL web_name is usually like "Haaland")
      if (t.length > 25) return NodeFilter.FILTER_REJECT;

      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = (p.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "textarea") return NodeFilter.FILTER_REJECT;
      // Avoid huge containers; prefer leaf-ish nodes
      if (p.children && p.children.length > 0) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let matched = 0;
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    const name = (node.nodeValue || "").trim();
    const player = playerMap[name];
    if (!player) continue;

    const el = node.parentElement;
    if (!el) continue;

    // Prevent re-injecting same element many times
    const key = `${name}::${el.getAttribute("class") || ""}::${el.textContent}`;
    if (seen.has(key)) continue;
    seen.add(key);

    matched++;
    targets.push(el);
    if (targets.length >= MAX_FALLBACK_TARGETS) break;
  }
  await mapWithConcurrency(targets, 6, injectUnderName);
  if (matched > 0) {
    lastFallbackSuccessByView.set(viewId, Date.now());
  }
  debugLog(`[${viewId}] fallback matched name nodes:`, matched);
}

async function scanLeagueStandingsCaptains(viewId) {
  if (!currentEventId) return;

  const rows = getStandingsRows();
  if (rows.length === 0) return;
  cleanupStrayCaptainInline();
  ensureCaptainHeader();
  applyLeagueGridLayout();

  const jobs = [];
  for (const row of rows) {
    const anchor = row.querySelector('a[href*="/entry/"]');
    if (!anchor) continue;
    const entryId = parseEntryIdFromHref(anchor.getAttribute("href"));
    if (!entryId) continue;
    jobs.push({ row, anchor, entryId });
  }
  if (jobs.length === 0) return;

  await mapWithConcurrency(jobs, CAPTAIN_FETCH_CONCURRENCY, async (job) => {
    const captain = await loadEntryCaptain(job.entryId, currentEventId);
    injectCaptainIntoRow(job.row, captain, currentEventId);
  });

  debugLog(`[${viewId}] captain cells updated:`, jobs.length);
}

async function scan() {
  if (!shouldAttemptScan()) return;
  if (scanInProgress) {
    scanQueued = true;
    return;
  }

  scanInProgress = true;

  try {
    const path = window.location.pathname || "/";
    const activeViews = getActiveViews(path);
    if (activeViews.length === 0) return;

    for (const view of activeViews) {
      await view.scan(view.id);
    }
  } finally {
    scanInProgress = false;
    if (scanQueued) {
      scanQueued = false;
      scheduleScan();
    }
  }
}

async function init() {
  debugLog("FPL XG running", new Date().toISOString());
  await loadBootstrap();
  await scan();
}

init();

// re-run on DOM updates (SPA)
const observer = new MutationObserver((mutations) => {
  if (!shouldScheduleFromMutations(mutations)) return;
  scheduleScan();
});

observer.observe(document.body, { childList: true, subtree: true });

// extra rescans in case the pitch renders after initial load
setTimeout(scheduleScan, 500);
setTimeout(scheduleScan, 1500);


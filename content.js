const BASE = "https://fantasy.premierleague.com/api";
const DEBUG = false;
const FALLBACK_SCAN_MIN_INTERVAL_MS = 2500;
const SCHEDULE_DELAY_MS = 200;
const MAX_FALLBACK_TARGETS = 120;
const NAME_SELECTORS = '[data-testid="player-name"], [data-testid="pitch-element-player-name"], .PitchElementData__Name, .PitchElement__Name, [class*="PitchElementData__Name"], [class*="PitchElement__Name"]';

let playerMap = {}; // web_name -> { id, element_type }
let cache = {};     // id -> { xgi90, mpg5, starts5, games, cs5, dc10Matches5, hasDC }
const pendingByContainer = new WeakMap(); // container -> Set(playerId)
const lastFallbackSuccessByView = new Map(); // viewId -> timestamp
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
    data.elements.forEach((p) => {
      playerMap[p.web_name] = {
        id: p.id,
        element_type: p.element_type
      };
    });

    debugLog("bootstrap loaded, players:", Object.keys(playerMap).length);
  } catch (e) {
    console.error("loadBootstrap failed", e);
  }
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


const BASE = "https://fantasy.premierleague.com/api";
const DEBUG = true;
const FALLBACK_SCAN_MIN_INTERVAL_MS = 2500;
const SCHEDULE_DELAY_MS = 200;
const MAX_FALLBACK_TARGETS = 120;
const CAPTAIN_FETCH_CONCURRENCY = 6;
const LEAGUE_EO_ID = 244800;
const LEAGUE_EO_RIVALS_LIMIT = Number.POSITIVE_INFINITY;
const NAME_SELECTORS = '[data-testid="player-name"], [data-testid="pitch-element-player-name"], .PitchElementData__Name, .PitchElement__Name, [class*="PitchElementData__Name"], [class*="PitchElement__Name"]';
const MY_FT_CACHE_KEY = "fplxg_my_free_transfers_v1";
// Temporary pragmatic escape hatch for your own row when upstream FT sources are unreliable.
// Set to a number (0-5) to force Remaining FT for your own entry, or keep null.
const MANUAL_MY_REMAINING_FT = 2;
const LEAGUE_DATAPOINTS = [
  { key: "captain", label: "C" },
  { key: "viceCaptain", label: "VC" },
  { key: "chip", label: "Chip" },
  { key: "transferCost", label: "Transfer Cost" },
  { key: "transfersMade", label: "Transfers" },
  { key: "remainingTransfers", label: "Remaining FT (calc)" }
];
const SHOW_FT_DEBUG = true;

let playerMap = {}; // web_name -> { id, element_type }
let playerById = {}; // id -> { web_name, element_type, team, ep_next, ep_this, form, now_cost }
let teamById = {}; // id -> { short_name, name }
let cache = {};     // `${id}:${eventId|na}` -> { games, cs5, hasDC, dc10Matches5, savePoints5, xgcPerMatch5, hasXGC, xgi90, currentGwXgi, hasCurrentGwXgi, currentGwDc, hasCurrentGwDc, currentGwSaves, currentGwXgc }
let currentEventId = null;
let nextEventId = null;
let fixturesByTeam = new Map(); // teamId -> [{ oppShort, isHome, difficulty, event, kickoff }]
let fixturesLoaded = false;
const pendingByContainer = new WeakMap(); // container -> Set(playerId)
const lastFallbackSuccessByView = new Map(); // viewId -> timestamp
const leagueDataCache = new Map(); // `${entryId}:${eventId}` -> entry league data
const leagueDataPending = new Map(); // `${entryId}:${eventId}` -> Promise<object>
const entryHistoryCache = new Map(); // entryId -> entry history payload
const entryHistoryPending = new Map(); // entryId -> Promise<object|null>
const entryTransfersCache = new Map(); // entryId -> transfers array
const entryTransfersPending = new Map(); // entryId -> Promise<array>
const leagueEoCache = new Map(); // eventId -> { eoByPlayerId: Map<number, number>, rivalsCount: number }
const leagueEoPending = new Map(); // eventId -> Promise<{ eoByPlayerId, rivalsCount }>
let myEntryId = null;
let myEntryIdPending = null; // Promise<number|null>
let myTeamTransfersCache = null; // { limit, made } | null
let myTeamTransfersPending = null; // Promise<{ limit, made } | null>
let myFreeTransfersMemory = null; // number | null
let myTransfersPageFtCache = null; // number | null
let myTransfersPageFtPending = null; // Promise<number|null>
let scanInProgress = false;
let scanQueued = false;
let scheduledTimer = null;

// Differential Analysis State
let miniLeagueOwnershipCache = new Map(); // eventId -> OwnershipData
let miniLeagueOwnershipPending = new Map(); // eventId -> Promise<OwnershipData>
let myCurrentTeamCache = new Map(); // eventId -> Set<playerId>
let myCurrentTeamPending = new Map(); // eventId -> Promise<Set<playerId>>

// Ownership Thresholds for Differential Analysis
const OWNERSHIP_THRESHOLDS = {
  template: 60,      // >60% = template player
  differential: 30,  // <30% = differential
  threat: 60         // Don't own but >60% of rivals do
};

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
  },
  {
    id: "my-team-insights",
    matchRoute: (path) => /^\/my-team(?:\/|$)/.test(path),
    scan: scanMyTeamInsights
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
    teamById = {};
    fixturesByTeam = new Map();
    fixturesLoaded = false;

    const teams = Array.isArray(data.teams) ? data.teams : [];
    teams.forEach((t) => {
      if (!t || !Number.isFinite(Number(t.id))) return;
      teamById[Number(t.id)] = {
        short_name: String(t.short_name || "").trim() || `T${t.id}`,
        name: String(t.name || "").trim() || `Team ${t.id}`
      };
    });

    data.elements.forEach((p) => {
      playerMap[p.web_name] = {
        id: p.id,
        element_type: p.element_type
      };
      playerById[p.id] = {
        web_name: p.web_name,
        element_type: p.element_type,
        team: Number(p.team),
        ep_next: Number(p.ep_next) || 0,
        ep_this: Number(p.ep_this) || 0,
        form: Number(p.form) || 0,
        now_cost: Number(p.now_cost) || 0
      };
    });
    currentEventId = getCurrentEventId(data);
    nextEventId = getNextEventId(data);

    await loadFixtures();

    debugLog("bootstrap loaded, players:", Object.keys(playerMap).length);
  } catch (e) {
    console.error("loadBootstrap failed", e);
  }
}

async function loadFixtures() {
  try {
    const res = await fetch(`${BASE}/fixtures/`);
    if (!res.ok) throw new Error(`fixtures failed: HTTP ${res.status}`);
    const fixtures = await res.json();
    const list = Array.isArray(fixtures) ? fixtures : [];

    const grouped = new Map();
    for (const fx of list) {
      if (!fx) continue;
      if (fx.finished || fx.started) continue;

      const event = Number(fx.event);
      const kickoff = Date.parse(String(fx.kickoff_time || "")) || 0;
      const teamH = Number(fx.team_h);
      const teamA = Number(fx.team_a);
      if (!Number.isFinite(teamH) || !Number.isFinite(teamA)) continue;

      const oppForH = teamById[teamA]?.short_name || `T${teamA}`;
      const oppForA = teamById[teamH]?.short_name || `T${teamH}`;
      const hDiff = Number(fx.team_h_difficulty);
      const aDiff = Number(fx.team_a_difficulty);

      if (!grouped.has(teamH)) grouped.set(teamH, []);
      if (!grouped.has(teamA)) grouped.set(teamA, []);

      grouped.get(teamH).push({
        oppShort: oppForH,
        isHome: true,
        difficulty: Number.isFinite(hDiff) ? hDiff : null,
        event,
        kickoff
      });
      grouped.get(teamA).push({
        oppShort: oppForA,
        isHome: false,
        difficulty: Number.isFinite(aDiff) ? aDiff : null,
        event,
        kickoff
      });
    }

    grouped.forEach((arr, teamId) => {
      arr.sort((a, b) => {
        const ea = Number.isFinite(a.event) ? a.event : 999;
        const eb = Number.isFinite(b.event) ? b.event : 999;
        if (ea !== eb) return ea - eb;
        return a.kickoff - b.kickoff;
      });
      grouped.set(teamId, arr);
    });

    fixturesByTeam = grouped;
    fixturesLoaded = true;
  } catch (e) {
    debugLog("loadFixtures failed", e);
    fixturesByTeam = new Map();
    fixturesLoaded = false;
  }
}

function fixtureBgByDifficulty(difficulty) {
  const d = Number(difficulty);
  if (!Number.isFinite(d)) return "#9ca3af";
  if (d <= 2) return "#22c55e";
  if (d === 3) return "#84cc16";
  if (d === 4) return "#f97316";
  return "#ef4444";
}

function getNextFixturesForPlayer(playerId, count = 5) {
  const teamId = Number(playerById[playerId]?.team);
  if (!Number.isFinite(teamId)) return [];
  const arr = fixturesByTeam.get(teamId) || [];
  return arr.slice(0, count);
}

function getCurrentEventId(bootstrapData) {
  const events = Array.isArray(bootstrapData?.events) ? bootstrapData.events : [];
  const current = events.find((e) => e && (e.is_current || e.is_next));
  if (current && Number.isFinite(Number(current.id))) return Number(current.id);
  return null;
}

function getNextEventId(bootstrapData) {
  const events = Array.isArray(bootstrapData?.events) ? bootstrapData.events : [];
  const next = events.find((e) => e && e.is_next);
  if (next && Number.isFinite(Number(next.id))) return Number(next.id);
  return null;
}

async function loadPlayerData(id, eventIdForGw = currentEventId) {
  const ev = Number(eventIdForGw);
  const evKey = Number.isFinite(ev) && ev > 0 ? String(ev) : "na";
  const cacheKey = `${Number(id)}:${evKey}`;
  if (cache[cacheKey]) return cache[cacheKey];

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

    const games = last5.length || 1;
    const min5 = last5.reduce((sum, m) => sum + Number(m.minutes ?? 0), 0);
    const pickXG = (row) => Number(row.xG ?? row.expected_goals ?? 0);
    const pickXA = (row) => Number(row.xA ?? row.expected_assists ?? 0);

    // Clean Sheets over last 5 played matches
    const cs5 = last5.reduce((sum, m) => sum + (Number(m.clean_sheets ?? 0) > 0 ? 1 : 0), 0);
    // Save points over last 5 (1 point per 3 saves, rounded down per match).
    const savePoints5 = last5.reduce((sum, m) => {
      const saves = Number(m.saves ?? 0);
      if (!Number.isFinite(saves) || saves <= 0) return sum;
      return sum + Math.floor(saves / 3);
    }, 0);

    // Defensive contributions; field name may vary across API payloads.
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
    const pickXGC = (row) => {
      const v = row.xGC ?? row.expected_goals_conceded;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    let hasXGC = false;
    let xgc5 = 0;
    for (const m of last5) {
      const v = pickXGC(m);
      if (v == null) continue;
      hasXGC = true;
      xgc5 += v;
    }
    const xgcPerMatch5 = games > 0 ? (xgc5 / games) : 0;
    const gw = ev;
    const hasCurrentGwXgi = Number.isFinite(gw) && gw > 0;
    const currentGwRows = hasCurrentGwXgi
      ? sorted.filter((m) => Number(m.round) === gw)
      : [];
    const currentGwXgi = currentGwRows.reduce((sum, m) => sum + pickXG(m) + pickXA(m), 0);
    const xgi5 = last5.reduce((sum, m) => sum + pickXG(m) + pickXA(m), 0);
    const xgi90 = min5 > 0 ? (xgi5 / (min5 / 90)) : 0;
    const currentGwDcRows = currentGwRows.map(pickDC).filter((v) => v != null);
    const hasCurrentGwDc = currentGwDcRows.length > 0;
    const currentGwDc = hasCurrentGwDc
      ? currentGwDcRows.reduce((sum, v) => sum + Number(v), 0)
      : 0;
    const currentGwSaves = currentGwRows.reduce((sum, m) => {
      const saves = Number(m.saves ?? 0);
      return Number.isFinite(saves) ? sum + saves : sum;
    }, 0);
    const currentGwXgc = currentGwRows.reduce((sum, m) => {
      const v = pickXGC(m);
      return v == null ? sum : sum + v;
    }, 0);

    cache[cacheKey] = {
      games,
      cs5,
      hasDC,
      dc10Matches5,
      savePoints5,
      xgcPerMatch5: Number(xgcPerMatch5.toFixed(2)),
      hasXGC,
      xgi90: Number(xgi90.toFixed(2)),
      currentGwXgi: Number(currentGwXgi.toFixed(2)),
      hasCurrentGwXgi,
      currentGwDc: Math.round(currentGwDc),
      hasCurrentGwDc,
      currentGwSaves: Math.round(currentGwSaves),
      currentGwXgc: Number(currentGwXgc.toFixed(2))
    };

    return cache[cacheKey];
  } catch (e) {
    console.error("loadPlayerData failed", id, e);
    return null;
  }
}

function getPlayerCardContainer(el) {
  return (
    el.closest('[data-testid="pitch-element"], [data-testid*="pitch-element"], [class*="PitchElement"], [class*="pitchElement"]') ||
    el.parentElement
  );
}

function colorForXPts(value) {
  return "#cbd5e1";  // Neutral gray for all values
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

async function injectUnderName(el, viewId) {
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
    const isPointsView = viewId === "entry";
    const viewedEventId = parseEventIdFromPath(window.location.pathname || "/");
    const eventIdForView = Number.isFinite(Number(viewedEventId))
      ? Number(viewedEventId)
      : Number(currentEventId);

    const stats = await loadPlayerData(id, eventIdForView);
    if (!stats) return;
    let ownershipData = Number.isFinite(Number(eventIdForView))
      ? await loadMiniLeagueOwnership(eventIdForView)
      : { playerOwnership: new Map(), rivalTeams: new Map(), totalRivals: 0 };
    let myTeam = Number.isFinite(Number(eventIdForView))
      ? await loadMyCurrentTeam(eventIdForView)
      : new Set();

    // If viewed event has no rival picks data yet, fallback to current event for ML/EO.
    const canFallbackToCurrent = Number.isFinite(Number(currentEventId))
      && Number(currentEventId) > 0
      && Number(currentEventId) !== Number(eventIdForView);
    const viewedHasOwnershipData = Number(ownershipData?.totalRivals || 0) > 0
      && ownershipData?.playerOwnership instanceof Map
      && ownershipData.playerOwnership.size > 0;
    if (canFallbackToCurrent && !viewedHasOwnershipData) {
      const [fallbackOwnership, fallbackMyTeam] = await Promise.all([
        loadMiniLeagueOwnership(currentEventId),
        loadMyCurrentTeam(currentEventId)
      ]);
      if (Number(fallbackOwnership?.totalRivals || 0) > 0) {
        ownershipData = fallbackOwnership;
        myTeam = fallbackMyTeam;
      }
    }

    // Get ownership data - if player not in map, they have 0% ownership
    const playerOwn = ownershipData?.playerOwnership?.get(id);
    const mlOwnership = Number.isFinite(playerOwn?.ownershipPct) ? playerOwn.ownershipPct : 0;
    const totalRivals = Number(ownershipData?.totalRivals || 0);
    let capCount = 0;
    let tripleCapCount = 0;
    const captainEntries = []; // Track which entries have this player as captain
    if (totalRivals > 0 && ownershipData?.rivalTeams instanceof Map) {
      for (const [entryId, team] of ownershipData.rivalTeams.entries()) {
        const capId = Number(team?.captain);
        if (!Number.isFinite(capId) || capId !== Number(id)) continue;
        capCount += 1;
        captainEntries.push(entryId);
        if (String(team?.chip || "").toLowerCase() === "3xc") {
          tripleCapCount += 1;
        }
      }
    }
    // Debug log to show who has this player as captain
    if (capCount > 0) {
      debugLog(`${name} is captain in ${capCount} team(s): Entry IDs = ${captainEntries.join(', ')}`);
    }
    const eoPct = totalRivals > 0
      ? mlOwnership + ((capCount + tripleCapCount) / totalRivals) * 100
      : null;
    const eoText = Number.isFinite(eoPct) ? `${Math.round(eoPct)}%` : "n/a";
    const mlOwnText = Number.isFinite(mlOwnership) ? `${Math.round(mlOwnership)}%` : "n/a";
    const iOwnPlayer = myTeam && myTeam.size > 0 ? myTeam.has(id) : false;

    // Determine differential/template/threat status
    // Note: Players not in the ownership map have 0% ownership (no rivals own them)
    let diffBadge = "";

    // Only show badges if we have ownership data loaded (totalRivals > 0)
    if (ownershipData?.totalRivals > 0) {
      if (iOwnPlayer) {
        // I own this player - always show a badge with ML%
        if (mlOwnership < OWNERSHIP_THRESHOLDS.differential) {
          // DIFF: Low ownership (<30%)
          diffBadge = `<span style="background:#22c55e;color:#0b1020;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">DIFF - ${Math.round(mlOwnership)}%</span><br />`;
        } else if (mlOwnership > OWNERSHIP_THRESHOLDS.template) {
          // TEMPLATE: High ownership (>60%)
          diffBadge = `<span style="background:#fbbf24;color:#0b1020;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">TEMPLATE - ${Math.round(mlOwnership)}%</span><br />`;
        } else {
          // MID: Medium ownership (30-60%)
          diffBadge = `<span style="background:#3b82f6;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">MID - ${Math.round(mlOwnership)}%</span><br />`;
        }
      } else {
        // I DON'T own this player - always show a badge with ML%
        if (mlOwnership > OWNERSHIP_THRESHOLDS.threat) {
          // THREAT: High ownership (>60%) but I don't own
          diffBadge = `<span style="background:#ef4444;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">THREAT - ${Math.round(mlOwnership)}%</span><br />`;
        } else if (mlOwnership >= OWNERSHIP_THRESHOLDS.differential) {
          // MID: Medium ownership (30-60%) but I don't own
          diffBadge = `<span style="background:#3b82f6;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">MID - ${Math.round(mlOwnership)}%</span><br />`;
        } else {
          // LOW: Low ownership (<30%) and I don't own
          diffBadge = `<span style="background:#64748b;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">LOW - ${Math.round(mlOwnership)}%</span><br />`;
        }
      }
    }

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

    const isGk = element_type === 1; // 1 = GK
    const isDef = element_type === 2; // 2 = DEF
    const isMid = element_type === 3; // 3 = MID
    const isFwd = element_type === 4; // 4 = FWD
    let fixtureHtml = "";
    if (!isPointsView) {
      if (!fixturesLoaded) await loadFixtures();
      const nextFixtures = getNextFixturesForPlayer(id, 5);
      fixtureHtml = nextFixtures.length > 0
        ? `
          <div style="margin-top:2px; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:2px; max-width:100%;">
            ${nextFixtures.map((f) => {
              const label = String(f.oppShort || "?").toLowerCase();
              return `<span style="
                display:block;
                min-width:0;
                text-align:center;
                padding:1px 0;
                border-radius:3px;
                font-size:8px;
                line-height:1.15;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
                color:#0b1020;
                background:${fixtureBgByDifficulty(f.difficulty)};
              ">${label}</span>`;
            }).join("")}
          </div>
        `
        : "";
    }

    // Calculate predicted points for next GW
    const xPtsValue = Number(playerById[id]?.ep_next || 0);
    const xPtsText = xPtsValue > 0 ? xPtsValue.toFixed(1) : "n/a";
    const xPtsColor = colorForXPts(xPtsValue);

    div.innerHTML = `
      ${isPointsView && isGk
        ? `<span style="color:#cbd5e1">Saves: ${stats.hasCurrentGwXgi ? stats.currentGwSaves : "n/a"}</span><br />
           <span style="color:#cbd5e1">xGC: ${stats.hasCurrentGwXgi ? stats.currentGwXgc.toFixed(2) : "n/a"}</span><br />`
        : ``}
      ${isPointsView && (isMid || isFwd)
        ? `<span style="color:#cbd5e1">xGI: ${stats.hasCurrentGwXgi ? stats.currentGwXgi.toFixed(2) : "n/a"}</span><br />`
        : ``}
      ${isPointsView && (isMid || isDef)
        ? `<span style="color:#cbd5e1">DC: ${stats.hasCurrentGwDc ? stats.currentGwDc : "n/a"}</span><br />`
        : ``}
      ${!isPointsView
        ? (isDef
          ? `<span style="color:#cbd5e1">CS: ${stats.cs5}/5</span><br />
             <span style="color:#cbd5e1">DC: ${stats.hasDC ? `${stats.dc10Matches5}/5` : "n/a"}</span><br />`
          : isGk
            ? `<span style="color:#cbd5e1">CS: ${stats.cs5}/5</span><br />
               <span style="color:#cbd5e1">SP: ${stats.savePoints5}</span><br />
               <span style="color:#cbd5e1">xGC/match: ${stats.hasXGC ? Number(stats.xgcPerMatch5).toFixed(2) : "n/a"}</span><br />`
            : `<span style="color:#cbd5e1">xGI/90: ${stats.xgi90.toFixed(2)}</span><br />`)
        : ``}
      <span style="color:${xPtsColor}">xPts: ${xPtsText}</span><br />
      ${diffBadge}
      ${fixtureHtml}
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

function parseEventIdFromPath(pathname) {
  const m = String(pathname || "").match(/\/event\/(\d+)(?:\/|$)/);
  if (!m) return null;
  const ev = Number(m[1]);
  return Number.isFinite(ev) && ev > 0 ? ev : null;
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

async function loadLeagueStandingsEntries(leagueId, limit) {
  const out = [];
  let page = 1;

  while (out.length < limit) {
    const url = `${BASE}/leagues-classic/${leagueId}/standings/?page_new_entries=1&page_standings=${page}`;
    const res = await fetch(url);
    if (!res.ok) break;

    const data = await res.json();
    const rows = Array.isArray(data?.standings?.results) ? data.standings.results : [];
    if (rows.length === 0) break;

    for (const row of rows) {
      out.push(row);
      if (out.length >= limit) break;
    }

    if (!data?.standings?.has_next) break;
    page += 1;
  }

  return out;
}

async function loadLeagueEOForEvent(eventId) {
  const ev = Number(eventId);
  if (!Number.isFinite(ev) || ev < 1) return { eoByPlayerId: new Map(), rivalsCount: 0 };
  if (leagueEoCache.has(ev)) return leagueEoCache.get(ev);
  if (leagueEoPending.has(ev)) return leagueEoPending.get(ev);

  const p = (async () => {
    try {
      const myIdFromApi = await loadMyEntryId();
      const myIdFromPath = getMyEntryIdFromPath();
      const myIdFromNav = getMyEntryIdFromNav();
      const myIdFromCache = Number(getCachedMyFreeTransfers()?.entryId);
      const myId = [myIdFromApi, myIdFromPath, myIdFromNav, myIdFromCache]
        .map((v) => Number(v))
        .find((v) => Number.isFinite(v) && v > 0);
      const standings = await loadLeagueStandingsEntries(LEAGUE_EO_ID, LEAGUE_EO_RIVALS_LIMIT);
      const rivals = standings
        .map((row) => Number(row?.entry))
        .filter((id) => Number.isFinite(id) && id > 0 && (!Number.isFinite(myId) || Number(id) !== Number(myId)))
        .slice(0, LEAGUE_EO_RIVALS_LIMIT);

      if (rivals.length === 0) {
        const empty = { eoByPlayerId: new Map(), rivalsCount: 0 };
        leagueEoCache.set(ev, empty);
        return empty;
      }

      const eoUnitsByPlayer = new Map();
      let successfulRivals = 0;
      await mapWithConcurrency(rivals, CAPTAIN_FETCH_CONCURRENCY, async (entryId) => {
        try {
          const res = await fetch(`${BASE}/entry/${entryId}/event/${ev}/picks/`);
          if (!res.ok) return;

          const data = await res.json();
          const picks = Array.isArray(data?.picks) ? data.picks : [];
          const isTripleCaptain = String(data?.active_chip || "").trim().toLowerCase() === "3xc";
          successfulRivals += 1;

          for (const pick of picks) {
            const playerId = Number(pick?.element);
            if (!Number.isFinite(playerId)) continue;

            // Owned = +1
            eoUnitsByPlayer.set(playerId, (eoUnitsByPlayer.get(playerId) || 0) + 1);

            // Captain = +1 extra, Triple Captain = +1 extra again
            if (pick?.is_captain) {
              eoUnitsByPlayer.set(playerId, (eoUnitsByPlayer.get(playerId) || 0) + 1);
              if (isTripleCaptain) {
                eoUnitsByPlayer.set(playerId, (eoUnitsByPlayer.get(playerId) || 0) + 1);
              }
            }
          }
        } catch (_) {
          // Ignore one rival failure; EO still works with remaining rivals.
        }
      });

      if (successfulRivals === 0) {
        const empty = { eoByPlayerId: new Map(), rivalsCount: 0 };
        leagueEoCache.set(ev, empty);
        return empty;
      }

      const eoByPlayerId = new Map();
      for (const [playerId, eoUnits] of eoUnitsByPlayer.entries()) {
        eoByPlayerId.set(playerId, (Number(eoUnits) / successfulRivals) * 100);
      }

      const out = { eoByPlayerId, rivalsCount: successfulRivals };
      leagueEoCache.set(ev, out);
      return out;
    } catch (e) {
      debugLog("loadLeagueEOForEvent failed", ev, e);
      const out = { eoByPlayerId: new Map(), rivalsCount: 0 };
      leagueEoCache.set(ev, out);
      return out;
    } finally {
      leagueEoPending.delete(ev);
    }
  })();

  leagueEoPending.set(ev, p);
  return p;
}

async function loadMiniLeagueOwnership(eventId) {
  const ev = Number(eventId);
  if (!Number.isFinite(ev) || ev < 1) {
    return { playerOwnership: new Map(), rivalTeams: new Map(), totalRivals: 0 };
  }

  if (miniLeagueOwnershipCache.has(ev)) return miniLeagueOwnershipCache.get(ev);
  if (miniLeagueOwnershipPending.has(ev)) return miniLeagueOwnershipPending.get(ev);

  const p = (async () => {
    try {
      // Get user's entry ID to exclude from rivals
      const myIdFromApi = await loadMyEntryId();
      const myIdFromPath = getMyEntryIdFromPath();
      const myIdFromNav = getMyEntryIdFromNav();
      const myIdFromCache = Number(getCachedMyFreeTransfers()?.entryId);
      const myId = [myIdFromApi, myIdFromPath, myIdFromNav, myIdFromCache]
        .map((v) => Number(v))
        .find((v) => Number.isFinite(v) && v > 0);

      // Fetch all league standings
      const standings = await loadLeagueStandingsEntries(LEAGUE_EO_ID, LEAGUE_EO_RIVALS_LIMIT);
      const rivals = standings
        .map((row) => Number(row?.entry))
        .filter((id) => Number.isFinite(id) && id > 0 && (!Number.isFinite(myId) || Number(id) !== Number(myId)))
        .slice(0, LEAGUE_EO_RIVALS_LIMIT);

      if (rivals.length === 0) {
        const empty = { playerOwnership: new Map(), rivalTeams: new Map(), totalRivals: 0 };
        miniLeagueOwnershipCache.set(ev, empty);
        return empty;
      }

      // Build ownership maps
      const playerOwnershipMap = new Map(); // playerId -> { ownedBy: Set, captainedBy: Set, tripleCaptainedBy: Set }
      const rivalTeamsMap = new Map(); // entryId -> { name, picks: Set, captain, viceCaptain, chip }
      let successfulRivals = 0;

      await mapWithConcurrency(rivals, CAPTAIN_FETCH_CONCURRENCY, async (entryId) => {
        try {
          const res = await fetch(`${BASE}/entry/${entryId}/event/${ev}/picks/`);
          if (!res.ok) return;

          const data = await res.json();
          const picks = Array.isArray(data?.picks) ? data.picks : [];
          successfulRivals += 1;

          // Store rival team info
          const pickIds = new Set();
          let captainId = null;
          let viceCaptainId = null;

          for (const pick of picks) {
            const playerId = Number(pick?.element);
            if (!Number.isFinite(playerId)) continue;

            pickIds.add(playerId);

            // Initialize ownership tracking for this player
            if (!playerOwnershipMap.has(playerId)) {
              playerOwnershipMap.set(playerId, {
                ownedBy: new Set(),
                captainedBy: new Set(),
                tripleCaptainedBy: new Set()
              });
            }

            // Track ownership
            playerOwnershipMap.get(playerId).ownedBy.add(entryId);

            // Track captaincy
            if (pick?.is_captain) {
              captainId = playerId;
              playerOwnershipMap.get(playerId).captainedBy.add(entryId);
            }
            if (pick?.is_vice_captain) {
              viceCaptainId = playerId;
            }
          }

          rivalTeamsMap.set(entryId, {
            name: String(data?.entry_history?.entry_name || ""),
            picks: pickIds,
            captain: captainId,
            viceCaptain: viceCaptainId,
            chip: String(data?.active_chip || "").toLowerCase()
          });

          // Triple captain contributes one extra EO unit on top of captaincy.
          if (Number.isFinite(Number(captainId)) && String(data?.active_chip || "").toLowerCase() === "3xc") {
            const capData = playerOwnershipMap.get(Number(captainId));
            if (capData) capData.tripleCaptainedBy.add(entryId);
          }
        } catch (_) {
          // Ignore individual rival failures
        }
      });

      if (successfulRivals === 0) {
        const empty = { playerOwnership: new Map(), rivalTeams: new Map(), totalRivals: 0 };
        miniLeagueOwnershipCache.set(ev, empty);
        return empty;
      }

      // Calculate ownership percentages
      const playerOwnership = new Map();
      for (const [playerId, data] of playerOwnershipMap.entries()) {
        const ownershipPct = (data.ownedBy.size / successfulRivals) * 100;
        const captainPct = (data.captainedBy.size / successfulRivals) * 100;
        const tripleCaptainPct = (data.tripleCaptainedBy.size / successfulRivals) * 100;
        const eoPct = ownershipPct + captainPct + tripleCaptainPct;
        playerOwnership.set(playerId, {
          ownedBy: data.ownedBy,
          ownershipPct,
          captainedBy: data.captainedBy,
          captainPct,
          tripleCaptainedBy: data.tripleCaptainedBy,
          tripleCaptainPct,
          eoPct
        });
      }

      const result = {
        eventId: ev,
        totalRivals: successfulRivals,
        playerOwnership,
        rivalTeams: rivalTeamsMap
      };
      miniLeagueOwnershipCache.set(ev, result);
      return result;
    } catch (e) {
      debugLog("loadMiniLeagueOwnership failed", ev, e);
      const out = { playerOwnership: new Map(), rivalTeams: new Map(), totalRivals: 0 };
      miniLeagueOwnershipCache.set(ev, out);
      return out;
    } finally {
      miniLeagueOwnershipPending.delete(ev);
    }
  })();

  miniLeagueOwnershipPending.set(ev, p);
  return p;
}

async function loadMyCurrentTeam(eventId) {
  const ev = Number(eventId);
  if (!Number.isFinite(ev) || ev < 1) return new Set();

  if (myCurrentTeamCache.has(ev)) return myCurrentTeamCache.get(ev);
  if (myCurrentTeamPending.has(ev)) return myCurrentTeamPending.get(ev);

  const p = (async () => {
    try {
      const myId = await loadMyEntryId();
      if (!Number.isFinite(myId)) {
        myCurrentTeamCache.set(ev, new Set());
        return new Set();
      }

      const res = await fetch(`${BASE}/entry/${myId}/event/${ev}/picks/`);
      if (!res.ok) {
        debugLog(`loadMyCurrentTeam failed for event ${ev}: HTTP ${res.status}`);
        myCurrentTeamCache.set(ev, new Set());
        return new Set();
      }

      const data = await res.json();
      const picks = Array.isArray(data?.picks) ? data.picks : [];
      const pickIds = new Set();

      for (const pick of picks) {
        const playerId = Number(pick?.element);
        if (Number.isFinite(playerId)) {
          pickIds.add(playerId);
        }
      }

      myCurrentTeamCache.set(ev, pickIds);
      return pickIds;
    } catch (e) {
      debugLog("loadMyCurrentTeam failed", ev, e);
      myCurrentTeamCache.set(ev, new Set());
      return new Set();
    } finally {
      myCurrentTeamPending.delete(ev);
    }
  })();

  myCurrentTeamPending.set(ev, p);
  return p;
}

async function calculateDifferentialInsights(eventId) {
  const ev = Number(eventId);
  if (!Number.isFinite(ev) || ev < 1) {
    return {
      myDifferentials: [],
      templatesMissing: [],
      myTemplates: [],
      uniquePicks: 0,
      differentialCount: 0,
      templateCount: 0,
      myTeam: new Set()
    };
  }

  try {
    const [ownershipData, myTeam] = await Promise.all([
      loadMiniLeagueOwnership(ev),
      loadMyCurrentTeam(ev)
    ]);

    const myDifferentials = [];
    const myTemplates = [];
    let uniquePicks = 0;
    const templatesMissing = [];

    // Analyze my team
    for (const playerId of myTeam) {
      const ownData = ownershipData.playerOwnership.get(playerId);
      const ownershipPct = ownData?.ownershipPct || 0;
      const ownedByCount = ownData?.ownedBy?.size || 0;

      if (ownershipPct < OWNERSHIP_THRESHOLDS.differential) {
        myDifferentials.push({
          playerId,
          name: playerById[playerId]?.web_name || `#${playerId}`,
          ownershipPct,
          ownedBy: ownedByCount
        });

        if (ownedByCount === 0) {
          uniquePicks += 1;
        }
      }

      if (ownershipPct > OWNERSHIP_THRESHOLDS.template) {
        myTemplates.push({
          playerId,
          name: playerById[playerId]?.web_name || `#${playerId}`,
          ownershipPct
        });
      }
    }

    // Find templates I'm missing
    for (const [playerId, ownData] of ownershipData.playerOwnership.entries()) {
      if (myTeam.has(playerId)) continue; // I already own this player

      if (ownData.ownershipPct > OWNERSHIP_THRESHOLDS.threat) {
        // Check if top 3 rivals own this player
        let ownedByTopRivals = false;
        // This is a simplified check - in a real scenario we'd track top rivals
        // For now, we'll mark as high priority if ownership is very high
        if (ownData.ownershipPct >= 75) {
          ownedByTopRivals = true;
        }

        templatesMissing.push({
          playerId,
          name: playerById[playerId]?.web_name || `#${playerId}`,
          ownershipPct: ownData.ownershipPct,
          ownedBy: ownData.ownedBy.size,
          ownedByTopRivals
        });
      }
    }

    // Sort lists
    myDifferentials.sort((a, b) => a.ownershipPct - b.ownershipPct);
    myTemplates.sort((a, b) => b.ownershipPct - a.ownershipPct);
    templatesMissing.sort((a, b) => b.ownershipPct - a.ownershipPct);

    return {
      myDifferentials,
      templatesMissing,
      myTemplates,
      uniquePicks,
      differentialCount: myDifferentials.length,
      templateCount: myTemplates.length,
      myTeam
    };
  } catch (e) {
    debugLog("calculateDifferentialInsights failed", ev, e);
    return {
      myDifferentials: [],
      templatesMissing: [],
      myTemplates: [],
      uniquePicks: 0,
      differentialCount: 0,
      templateCount: 0,
      myTeam: new Set()
    };
  }
}

function getCachedMyFreeTransfers() {
  try {
    const raw = localStorage.getItem(MY_FT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const value = Number(parsed?.value);
    const entryId = Number(parsed?.entryId);
    if (!Number.isFinite(value)) return null;
    return {
      value,
      entryId: Number.isFinite(entryId) ? entryId : null,
      eventId: Number(parsed?.eventId),
      updatedAt: Number(parsed?.updatedAt || 0)
    };
  } catch (_) {
    return null;
  }
}

function setCachedMyFreeTransfers(value) {
  if (!Number.isFinite(Number(value))) return;
  myFreeTransfersMemory = Number(value);
  try {
    const myId = getMyEntryIdFromNav();
    localStorage.setItem(MY_FT_CACHE_KEY, JSON.stringify({
      value: Number(value),
      entryId: Number.isFinite(Number(myId)) ? Number(myId) : null,
      eventId: Number.isFinite(Number(currentEventId)) ? Number(currentEventId) : null,
      updatedAt: Date.now()
    }));
  } catch (_) {
    // ignore storage failures
  }
}

function scrapeFreeTransfersFromTransfersPage() {
  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");
  const candidates = [];
  const re = /(\d{1,2})\D{0,20}Free Transfers|Free Transfers\D{0,20}(\d{1,2})/gi;
  let mm;
  while ((mm = re.exec(bodyText)) !== null) {
    const a = Number(mm[1]);
    const b = Number(mm[2]);
    if (Number.isFinite(a) && a >= 0 && a <= 5) candidates.push(a);
    if (Number.isFinite(b) && b >= 0 && b <= 5) candidates.push(b);
  }
  if (candidates.length > 0) {
    const positives = candidates.filter((v) => v > 0);
    return positives.length > 0 ? Math.max(...positives) : Math.max(...candidates);
  }

  // Fallback: find any element that mentions "Free Transfers" (even if split/extra spaces)
  // and read nearby numeric nodes.
  const labels = Array.from(document.querySelectorAll("span, div, p, h2, h3, h4, strong, label"));
  const labelNodes = labels.filter((n) => /free\s*transfers/i.test((n.textContent || "").replace(/\s+/g, " ").trim()));
  const nearNums = [];

  function collectNums(txt) {
    if (!txt) return;
    const found = Array.from(String(txt).matchAll(/\b(\d{1,2})\b/g))
      .map((m) => Number(m[1]))
      .filter((v) => Number.isFinite(v) && v >= 0 && v <= 5);
    nearNums.push(...found);
  }

  for (const n of labelNodes) {
    collectNums(n.previousElementSibling?.textContent);
    collectNums(n.nextElementSibling?.textContent);
    collectNums(n.parentElement?.textContent);
    collectNums(n.closest("section, article, form, main, div")?.textContent);
  }

  if (nearNums.length === 0) return null;
  const positiveNear = nearNums.filter((v) => v > 0);
  return positiveNear.length > 0 ? Math.max(...positiveNear) : Math.max(...nearNums);
}

async function loadMyFreeTransfersFromTransfersHtml() {
  if (Number.isFinite(Number(myTransfersPageFtCache))) return Number(myTransfersPageFtCache);
  if (myTransfersPageFtPending) return myTransfersPageFtPending;

  const p = (async () => {
    try {
      const res = await fetch(`${window.location.origin}/transfers`, { credentials: "include" });
      if (!res.ok) return null;
      const html = await res.text();

      // Best source if present in embedded JSON/state.
      const mState = html.match(/"transfers"\s*:\s*\{\s*"limit"\s*:\s*(\d+)\s*,\s*"made"\s*:\s*(\d+)/i);
      if (mState) {
        const limit = Number(mState[1]);
        const made = Number(mState[2]);
        if (Number.isFinite(limit) && Number.isFinite(made)) {
          const remaining = Math.max(0, limit - made);
          myTransfersPageFtCache = remaining;
          return remaining;
        }
      }

      // Text fallback.
      let mTxt = html.match(/\b(\d+)\s*Free Transfers\b/i);
      if (!mTxt) mTxt = html.match(/\bFree Transfers\s*(\d+)\b/i);
      if (mTxt) {
        const v = Number(mTxt[1]);
        if (Number.isFinite(v)) {
          myTransfersPageFtCache = v;
          return v;
        }
      }

      return null;
    } catch (_) {
      return null;
    } finally {
      myTransfersPageFtPending = null;
    }
  })();

  myTransfersPageFtPending = p;
  return p;
}

function getMyEntryIdFromNav() {
  if (Number.isFinite(myEntryId)) return myEntryId;
  const link = document.querySelector('a[href^="/entry/"][href*="/event/"]');
  if (!link) return null;
  const id = parseEntryIdFromHref(link.getAttribute("href"));
  if (Number.isFinite(id)) myEntryId = id;
  return Number.isFinite(id) ? id : null;
}

function getMyEntryIdFromPath() {
  if (Number.isFinite(myEntryId)) return myEntryId;
  const id = parseEntryIdFromHref(window.location.pathname || "");
  if (Number.isFinite(id)) myEntryId = id;
  return Number.isFinite(id) ? id : null;
}

async function loadMyEntryId() {
  if (Number.isFinite(myEntryId)) return myEntryId;
  if (myEntryIdPending) return myEntryIdPending;

  const p = (async () => {
    try {
      const pathId = getMyEntryIdFromPath();
      if (Number.isFinite(pathId)) {
        return pathId;
      }

      const navId = getMyEntryIdFromNav();
      if (Number.isFinite(navId)) {
        return navId;
      }

      const cachedFt = getCachedMyFreeTransfers();
      const cachedEntryId = Number(cachedFt?.entryId);
      if (Number.isFinite(cachedEntryId)) {
        myEntryId = cachedEntryId;
        return myEntryId;
      }

      const res = await fetch(`${BASE}/me/`, { credentials: "include" });
      if (!res.ok) throw new Error(`me failed: HTTP ${res.status}`);
      const data = await res.json();
      const fromPlayer = Number(data?.player?.entry);
      const fromEntry = Number(data?.entry);
      const resolved = Number.isFinite(fromPlayer)
        ? fromPlayer
        : (Number.isFinite(fromEntry) ? fromEntry : null);

      if (Number.isFinite(resolved)) {
        myEntryId = resolved;
      }
      return Number.isFinite(myEntryId) ? myEntryId : null;
    } catch (e) {
      debugLog("loadMyEntryId failed", e);
      return null;
    } finally {
      myEntryIdPending = null;
    }
  })();

  myEntryIdPending = p;
  return p;
}

async function loadMyTeamTransfers(entryId, eventIdHint) {
  if (!Number.isFinite(Number(entryId))) return null;
  const cacheKey = Number.isFinite(Number(eventIdHint)) ? String(eventIdHint) : "default";
  if (myTeamTransfersCache && myTeamTransfersCache[cacheKey]) return myTeamTransfersCache[cacheKey];
  if (myTeamTransfersPending) return myTeamTransfersPending;

  const p = (async () => {
    try {
      const urls = [];
      if (Number.isFinite(Number(eventIdHint))) {
        urls.push(`${BASE}/my-team/${entryId}/?event=${Number(eventIdHint)}`);
      }
      urls.push(`${BASE}/my-team/${entryId}/`);

      let best = null;
      for (const url of urls) {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) continue;
        const data = await res.json();
        const limitRaw = Number(data?.transfers?.limit);
        const madeRaw = Number(data?.transfers?.made);
        if (!Number.isFinite(limitRaw) || !Number.isFinite(madeRaw)) continue;
        const remaining = Math.max(0, limitRaw - madeRaw);
        if (!best || remaining > best.remaining) {
          best = { limit: limitRaw, made: madeRaw, remaining };
        }
      }

      if (!best) {
        if (!myTeamTransfersCache) myTeamTransfersCache = {};
        myTeamTransfersCache[cacheKey] = null;
        return null;
      }

      if (!myTeamTransfersCache) myTeamTransfersCache = {};
      myTeamTransfersCache[cacheKey] = best;
      return best;
    } catch (e) {
      debugLog("loadMyTeamTransfers failed", entryId, e);
      if (!myTeamTransfersCache) myTeamTransfersCache = {};
      myTeamTransfersCache[cacheKey] = null;
      return null;
    } finally {
      myTeamTransfersPending = null;
    }
  })();

  myTeamTransfersPending = p;
  return p;
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

function cleanupCaptainInjections() {
  document.querySelectorAll(".fpl-captain-header, .fpl-captain-cell, .fpl-captain-inline, .fpl-captain-inline-row, .fpl-league-meta, .fpl-league-transfers, .fpl-league-debug").forEach((n) => n.remove());
}

function injectLeagueMetaIntoTeamCell(row, data, eventId, diffData) {
  const teamCell = row.querySelector("[role='rowheader'], td:nth-child(2)");
  if (!teamCell) return;

  let wrap = teamCell.querySelector(".fpl-league-meta");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "fpl-league-meta";
    wrap.style.display = "flex";
    wrap.style.flexWrap = "wrap";
    wrap.style.gap = "4px";
    wrap.style.marginTop = "4px";
    teamCell.appendChild(wrap);
  }

  wrap.innerHTML = "";
  for (const item of LEAGUE_DATAPOINTS) {
    const value = data?.[item.key];
    if (value == null || value === "") continue;

    const chip = document.createElement("span");
    chip.className = "fpl-league-chip";
    chip.style.fontSize = "10px";
    chip.style.lineHeight = "1.2";
    chip.style.padding = "1px 5px";
    chip.style.border = "1px solid rgba(148,163,184,0.45)";
    chip.style.borderRadius = "10px";
    chip.style.color = "#cbd5e1";
    chip.style.whiteSpace = "nowrap";
    chip.textContent = `${item.label}: ${value}`;
    wrap.appendChild(chip);
  }

  const existingTransfers = teamCell.querySelector(".fpl-league-transfers");
  if (existingTransfers) existingTransfers.remove();
  const lines = Array.isArray(data?.transferLines) ? data.transferLines : [];
  if (lines.length > 0) {
    const tWrap = document.createElement("div");
    tWrap.className = "fpl-league-transfers";
    tWrap.style.marginTop = "4px";
    tWrap.style.fontSize = "11px";
    tWrap.style.lineHeight = "1.25";
    tWrap.style.color = "#9fb3c8";

    const maxLines = 3;
    for (const line of lines.slice(0, maxLines)) {
      const rowLine = document.createElement("div");
      rowLine.textContent = line;
      tWrap.appendChild(rowLine);
    }
    if (lines.length > maxLines) {
      const more = document.createElement("div");
      more.textContent = `+${lines.length - maxLines} more`;
      more.style.opacity = "0.8";
      tWrap.appendChild(more);
    }
    teamCell.appendChild(tWrap);
  }

  // Add differential stats
  const existingDiff = teamCell.querySelector(".fpl-league-diff");
  if (existingDiff) existingDiff.remove();
  if (diffData) {
    const diffWrap = document.createElement("div");
    diffWrap.className = "fpl-league-diff";
    diffWrap.style.marginTop = "4px";
    diffWrap.style.fontSize = "10px";
    diffWrap.style.color = "#cbd5e1";

    const diffStats = document.createElement("div");
    diffStats.innerHTML = `
      <span style="color:#22c55e">Diffs: ${diffData.differentialCount}</span> |
      <span style="color:#fbbf24">Templates: ${diffData.templateCount}</span>
    `;
    diffWrap.appendChild(diffStats);

    if (diffData.threatsToYou?.length > 0) {
      const threatDiv = document.createElement("div");
      threatDiv.style.color = "#ef4444";
      threatDiv.style.marginTop = "2px";
      const names = diffData.threatsToYou.slice(0, 3)
        .map(p => playerById[p]?.web_name || `#${p}`)
        .join(", ");
      threatDiv.textContent = `⚠ Has: ${names}${diffData.threatsToYou.length > 3 ? ` +${diffData.threatsToYou.length - 3} more` : ""}`;
      diffWrap.appendChild(threatDiv);
    }

    teamCell.appendChild(diffWrap);
  }

  const existingDebug = teamCell.querySelector(".fpl-league-debug");
  if (existingDebug) existingDebug.remove();
  if (SHOW_FT_DEBUG && data?.ftDebug) {
    const dbg = document.createElement("div");
    dbg.className = "fpl-league-debug";
    dbg.style.marginTop = "4px";
    dbg.style.fontSize = "10px";
    dbg.style.lineHeight = "1.2";
    dbg.style.color = "#fbbf24";
    dbg.textContent = data.ftDebug;
    teamCell.appendChild(dbg);
  }

  wrap.dataset.eventId = String(eventId);
}

async function loadEntryHistory(entryId) {
  if (entryHistoryCache.has(entryId)) return entryHistoryCache.get(entryId);
  if (entryHistoryPending.has(entryId)) return entryHistoryPending.get(entryId);

  const p = (async () => {
    try {
      const res = await fetch(`${BASE}/entry/${entryId}/history/`);
      if (!res.ok) throw new Error(`entry history failed ${entryId}: HTTP ${res.status}`);
      const data = await res.json();
      entryHistoryCache.set(entryId, data);
      return data;
    } catch (e) {
      debugLog("loadEntryHistory failed", entryId, e);
      entryHistoryCache.set(entryId, null);
      return null;
    } finally {
      entryHistoryPending.delete(entryId);
    }
  })();

  entryHistoryPending.set(entryId, p);
  return p;
}

async function loadEntryTransfers(entryId) {
  if (entryTransfersCache.has(entryId)) return entryTransfersCache.get(entryId);
  if (entryTransfersPending.has(entryId)) return entryTransfersPending.get(entryId);

  const p = (async () => {
    try {
      const res = await fetch(`${BASE}/entry/${entryId}/transfers/`);
      if (!res.ok) throw new Error(`entry transfers failed ${entryId}: HTTP ${res.status}`);
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [];
      entryTransfersCache.set(entryId, arr);
      return arr;
    } catch (e) {
      debugLog("loadEntryTransfers failed", entryId, e);
      entryTransfersCache.set(entryId, []);
      return [];
    } finally {
      entryTransfersPending.delete(entryId);
    }
  })();

  entryTransfersPending.set(entryId, p);
  return p;
}

function computeRemainingTransfers(historyData, eventId, currentEventData) {
  const targetEvent = Number(eventId);
  if (!Number.isFinite(targetEvent) || targetEvent < 1) return null;

  const currentRows = Array.isArray(historyData?.current) ? historyData.current : [];
  const chips = Array.isArray(historyData?.chips) ? historyData.chips : [];
  const isWildcardChip = (name) => {
    const s = String(name || "").toLowerCase();
    return s === "wc" || s.includes("wildcard");
  };
  const isFreeHitChip = (name) => {
    const s = String(name || "").toLowerCase();
    return s === "fh" || s.includes("freehit") || s.includes("free_hit");
  };

  const rowByEvent = new Map();
  for (const r of currentRows) {
    const ev = Number(r?.event);
    if (!Number.isFinite(ev)) continue;
    rowByEvent.set(ev, r);
  }

  const chipByEvent = new Map();
  for (const c of chips) {
    const ev = Number(c?.event);
    if (!Number.isFinite(ev)) continue;
    chipByEvent.set(ev, String(c?.name || "").toLowerCase());
  }

  // Simulate GW by GW so missing rows don't break FT accrual.
  let ftEndPrev = 1; // after GW0 / before GW1
  for (let ev = 1; ev <= targetEvent; ev += 1) {
    const ftStart = ev === 1 ? 1 : Math.min(5, ftEndPrev + 1);

    const row = rowByEvent.get(ev);
    const isCurrent = ev === targetEvent;
    const chipRaw = isCurrent
      ? String(currentEventData?.activeChipRaw || chipByEvent.get(ev) || "")
      : String(chipByEvent.get(ev) || "");
    const chip = chipRaw.toLowerCase();

    const transfersRaw = isCurrent
      ? Number(currentEventData?.eventTransfers ?? row?.event_transfers ?? 0)
      : Number(row?.event_transfers ?? 0);
    const costRaw = isCurrent
      ? Number(currentEventData?.eventTransfersCost ?? row?.event_transfers_cost ?? 0)
      : Number(row?.event_transfers_cost ?? 0);

    const transfers = Number.isFinite(transfersRaw) ? transfersRaw : 0;
    const transferCost = Number.isFinite(costRaw) ? costRaw : 0;
    // transfer cost is always 4 points per paid transfer.
    const paidTransfers = Math.max(0, Math.floor(transferCost / 4));
    const freeTransfersUsed = Math.max(0, transfers - paidTransfers);

    if (isWildcardChip(chip)) {
      // With modern FT rules, wildcard should not consume banked free transfers.
      ftEndPrev = ftStart;
      continue;
    }
    if (isFreeHitChip(chip)) {
      ftEndPrev = ftStart;
      continue;
    }

    ftEndPrev = Math.max(0, ftStart - freeTransfersUsed);
  }

  // Fallback guard: if current GW exists in history but is stale/missing cost fields,
  // avoid reporting 0 when it should likely be at least 1 after subtracted paid moves.
  if (
    targetEvent > 1 &&
    Number(currentEventData?.eventTransfers ?? 0) > 0 &&
    Number(currentEventData?.eventTransfersCost ?? 0) >= 0 &&
    ftEndPrev === 0
  ) {
    const currentTransfers = Math.max(0, Number(currentEventData?.eventTransfers ?? 0));
    const currentPaid = Math.max(0, Math.floor(Number(currentEventData?.eventTransfersCost ?? 0) / 4));
    const currentFreeUsed = Math.max(0, currentTransfers - currentPaid);
    // If we used fewer than 2 free transfers this GW, 0 remaining is typically a stale-history artifact.
    if (currentFreeUsed <= 1) {
      return 1;
    }
  }

  return ftEndPrev;
}

async function loadEntryLeagueData(entryId, eventId) {
  const key = `${entryId}:${eventId}`;
  if (leagueDataCache.has(key)) return leagueDataCache.get(key);
  if (leagueDataPending.has(key)) return leagueDataPending.get(key);

  const p = (async () => {
    try {
      const localMyEntryId = await loadMyEntryId();
      const shouldLoadMyTeam = Number(entryId) === Number(localMyEntryId);
      const [picksRes, historyData, transfersData, myTeamCurrent, myTeamNext, htmlFt] = await Promise.all([
        fetch(`${BASE}/entry/${entryId}/event/${eventId}/picks/`),
        loadEntryHistory(entryId),
        loadEntryTransfers(entryId),
        shouldLoadMyTeam ? loadMyTeamTransfers(entryId, eventId) : Promise.resolve(null),
        shouldLoadMyTeam && Number.isFinite(Number(nextEventId))
          ? loadMyTeamTransfers(entryId, nextEventId)
          : Promise.resolve(null),
        shouldLoadMyTeam ? loadMyFreeTransfersFromTransfersHtml() : Promise.resolve(null)
      ]);
      const res = picksRes;
      if (!res.ok) throw new Error(`entry picks failed ${entryId}/${eventId}: HTTP ${res.status}`);
      const data = await res.json();
      const picks = Array.isArray(data?.picks) ? data.picks : [];
      const cap = picks.find((x) => x && x.is_captain);
      const vc = picks.find((x) => x && x.is_vice_captain);
      const capId = Number(cap?.element);
      const vcId = Number(vc?.element);
      const captain = playerById[capId]?.web_name || (Number.isFinite(capId) ? `#${capId}` : "n/a");
      const viceCaptain = playerById[vcId]?.web_name || (Number.isFinite(vcId) ? `#${vcId}` : "n/a");

      const rawChip = String(data?.active_chip || "").trim();
      const chip = formatChip(rawChip);
      const transferCost = Number(data?.entry_history?.event_transfers_cost ?? 0);
      const transfersMadeRaw = Number(data?.entry_history?.event_transfers ?? 0);
      const transfersMade = Number.isFinite(transfersMadeRaw) ? transfersMadeRaw : 0;
      const remainingTransfers = computeRemainingTransfers(historyData, eventId, {
        activeChipRaw: rawChip,
        eventTransfers: transfersMade,
        eventTransfersCost: transferCost
      });
      const exactRemainingCurrent =
        myTeamCurrent && Number.isFinite(myTeamCurrent.remaining)
          ? Number(myTeamCurrent.remaining)
          : null;
      const exactRemainingNext =
        myTeamNext && Number.isFinite(myTeamNext.remaining)
          ? Number(myTeamNext.remaining)
          : null;
      const exactRemainingProjected =
        Number.isFinite(exactRemainingCurrent)
          ? Math.min(5, Math.max(0, exactRemainingCurrent + 1))
          : null;
      const calcRemaining = remainingTransfers == null ? null : Number(remainingTransfers);
      const cachedFt = shouldLoadMyTeam ? getCachedMyFreeTransfers() : null;
      const memoryRemaining =
        shouldLoadMyTeam && Number.isFinite(Number(myFreeTransfersMemory))
          ? Number(myFreeTransfersMemory)
          : null;
      const cachedRemaining =
        cachedFt &&
        Number.isFinite(cachedFt.value) &&
        (cachedFt.entryId == null || Number(cachedFt.entryId) === Number(entryId))
          ? Number(cachedFt.value)
          : null;
      const htmlRemaining = Number.isFinite(Number(htmlFt)) ? Number(htmlFt) : null;
      const manualRemaining = shouldLoadMyTeam && Number.isFinite(Number(MANUAL_MY_REMAINING_FT))
        ? Number(MANUAL_MY_REMAINING_FT)
        : null;
      // Some unauthenticated/partial sources return 0; treat those as unreliable
      // when we know transfers were made this GW.
      const ignoreZeroFromFallbacks = transfersMade > 0;
      const safeCur = ignoreZeroFromFallbacks && exactRemainingCurrent === 0 ? null : exactRemainingCurrent;
      const safeNext = ignoreZeroFromFallbacks && exactRemainingNext === 0 ? null : exactRemainingNext;
      const safeProj = ignoreZeroFromFallbacks && exactRemainingProjected === 0 ? null : exactRemainingProjected;
      const safeMem = ignoreZeroFromFallbacks && memoryRemaining === 0 ? null : memoryRemaining;
      const safeCache = ignoreZeroFromFallbacks && cachedRemaining === 0 ? null : cachedRemaining;
      const safeHtml = ignoreZeroFromFallbacks && htmlRemaining === 0 ? null : htmlRemaining;
      const mergedRemaining =
        shouldLoadMyTeam
          ? [manualRemaining, safeCur, safeNext, safeProj, safeMem, safeCache, safeHtml, calcRemaining]
              .filter((v) => Number.isFinite(v))
              .reduce((max, v) => Math.max(max, v), -1)
          : (Number.isFinite(calcRemaining) ? calcRemaining : -1);
      const ftDebug = shouldLoadMyTeam
        ? `FTdbg my=${entryId} ev=${eventId} next=${nextEventId} calc=${calcRemaining} cur=${exactRemainingCurrent} nextVal=${exactRemainingNext} proj=${exactRemainingProjected} mem=${memoryRemaining} cache=${cachedRemaining} html=${htmlRemaining} manual=${manualRemaining} merged=${mergedRemaining} t=${transfersMade} cost=${transferCost} chip=${chip}`
        : null;

      const eventTransfers = Array.isArray(transfersData)
        ? transfersData.filter((t) => Number(t?.event) === Number(eventId))
        : [];
      eventTransfers.sort((a, b) => {
        const at = Date.parse(String(a?.time || "")) || 0;
        const bt = Date.parse(String(b?.time || "")) || 0;
        return at - bt;
      });
      const transferLines = eventTransfers.map((t) => {
        const outId = Number(t?.element_out);
        const inId = Number(t?.element_in);
        const outName = playerById[outId]?.web_name || (Number.isFinite(outId) ? `#${outId}` : "?");
        const inName = playerById[inId]?.web_name || (Number.isFinite(inId) ? `#${inId}` : "?");
        return `${outName} -> ${inName}`;
      });

      const out = {
        captain,
        viceCaptain,
        chip,
        transferCost,
        transfersMade,
        remainingTransfers: mergedRemaining < 0 ? (remainingTransfers == null ? "n/a" : remainingTransfers) : mergedRemaining,
        transferLines,
        ftDebug
      };
      leagueDataCache.set(key, out);
      return out;
    } catch (e) {
      debugLog("loadEntryLeagueData failed", entryId, eventId, e);
      const out = {
        captain: "n/a",
        viceCaptain: "n/a",
        chip: "none",
        transferCost: 0,
        transfersMade: 0,
        remainingTransfers: "n/a",
        transferLines: [],
        ftDebug: null
      };
      leagueDataCache.set(key, out);
      return out;
    } finally {
      leagueDataPending.delete(key);
    }
  })();

  leagueDataPending.set(key, p);
  return p;
}

function formatChip(rawChip) {
  if (!rawChip) return "none";
  const map = {
    "3xc": "TC",
    "bboost": "BB",
    "freehit": "FH",
    "wildcard": "WC",
    "manager": "AM"
  };
  return map[rawChip] || rawChip.toUpperCase();
}

function getActiveViews(pathname) {
  return VIEWS.filter((view) => view.matchRoute(pathname));
}

async function scanPitchNameBadges(viewId) {
  if (viewId === "transfers") {
    const ft = scrapeFreeTransfersFromTransfersPage();
    if (Number.isFinite(ft)) {
      setCachedMyFreeTransfers(ft);
    }
  }

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
    await mapWithConcurrency(targets, 6, (el) => injectUnderName(el, viewId));
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
  await mapWithConcurrency(targets, 6, (el) => injectUnderName(el, viewId));
  if (matched > 0) {
    lastFallbackSuccessByView.set(viewId, Date.now());
  }
  debugLog(`[${viewId}] fallback matched name nodes:`, matched);
}

function calculateRivalDiffData(rivalTeam, myTeam, ownershipData) {
  if (!rivalTeam || !myTeam || !ownershipData) return null;

  let differentialCount = 0;
  let templateCount = 0;
  const threatsToYou = [];

  for (const playerId of rivalTeam.picks) {
    const own = ownershipData.playerOwnership.get(playerId);
    if (own) {
      if (own.ownershipPct < OWNERSHIP_THRESHOLDS.differential) {
        differentialCount++;
      }
      if (own.ownershipPct > OWNERSHIP_THRESHOLDS.template) {
        templateCount++;
      }
    }

    // Threat: they have it, you don't, and it's high ownership
    if (!myTeam.has(playerId) && own?.ownershipPct > OWNERSHIP_THRESHOLDS.threat) {
      threatsToYou.push(playerId);
    }
  }

  return {
    differentialCount,
    templateCount,
    threatsToYou
  };
}

async function scanLeagueStandingsCaptains(viewId) {
  if (!currentEventId) return;

  const rows = getStandingsRows();
  if (rows.length === 0) return;
  cleanupCaptainInjections();

  const jobs = [];
  for (const row of rows) {
    const anchor = row.querySelector('a[href*="/entry/"]');
    if (!anchor) continue;
    const entryId = parseEntryIdFromHref(anchor.getAttribute("href"));
    if (!entryId) continue;
    jobs.push({ row, anchor, entryId });
  }
  if (jobs.length === 0) return;

  // Load ownership data once for all rivals
  const ownershipData = await loadMiniLeagueOwnership(currentEventId);
  const myTeam = await loadMyCurrentTeam(currentEventId);

  await mapWithConcurrency(jobs, CAPTAIN_FETCH_CONCURRENCY, async (job) => {
    const leagueData = await loadEntryLeagueData(job.entryId, currentEventId);
    const rivalTeam = ownershipData?.rivalTeams?.get(job.entryId);
    const diffData = calculateRivalDiffData(rivalTeam, myTeam, ownershipData);
    injectLeagueMetaIntoTeamCell(job.row, leagueData, currentEventId, diffData);
  });

  debugLog(`[${viewId}] captain cells updated:`, jobs.length);
}

function getRecommendations(insights) {
  const recommendations = [];

  if (insights.templatesMissing.length > 0) {
    const topThreat = insights.templatesMissing[0];
    recommendations.push(
      `Consider: ${topThreat.name} is owned by ${formatPercent(topThreat.ownershipPct)} of rivals.`
    );
  }

  if (insights.differentialCount === 0) {
    recommendations.push(
      "You have no differentials. Consider adding unique picks to gain an edge."
    );
  } else if (insights.differentialCount > 5) {
    recommendations.push(
      `You have ${insights.differentialCount} differentials - high risk/reward strategy.`
    );
  }

  if (insights.uniquePicks > 3) {
    recommendations.push(
      `You have ${insights.uniquePicks} unique picks that no rivals own - bold moves!`
    );
  }

  return recommendations.length > 0
    ? recommendations.join('<br />')
    : 'Your team looks well-balanced against rivals.';
}

function createInsightsPanel(insights) {
  const panel = document.createElement("div");
  panel.className = "fpl-diff-insights-panel";
  panel.style.cssText = `
    background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    color: #e2e8f0;
  `;

  panel.innerHTML = `
    <h3 style="margin: 0 0 12px 0; font-size: 16px; color: #fff;">
      Differential Analysis (League ${LEAGUE_EO_ID})
    </h3>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px;">
      <!-- Summary Stats -->
      <div style="background: #1e293b; padding: 12px; border-radius: 6px;">
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">Your Differentials</div>
        <div style="font-size: 24px; font-weight: 700; color: #22c55e;">
          ${insights.differentialCount}
        </div>
        <div style="font-size: 10px; color: #64748b; margin-top: 4px;">
          ${insights.uniquePicks} unique picks
        </div>
      </div>

      <div style="background: #1e293b; padding: 12px; border-radius: 6px;">
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">Templates Missing</div>
        <div style="font-size: 24px; font-weight: 700; color: ${insights.templatesMissing.length > 0 ? '#ef4444' : '#22c55e'};">
          ${insights.templatesMissing.length}
        </div>
      </div>

      <div style="background: #1e293b; padding: 12px; border-radius: 6px;">
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">Your Templates</div>
        <div style="font-size: 24px; font-weight: 700; color: #fbbf24;">
          ${insights.templateCount}
        </div>
      </div>
    </div>

    ${insights.myDifferentials.length > 0 ? `
      <div style="margin-top: 16px;">
        <h4 style="font-size: 13px; color: #94a3b8; margin: 0 0 8px 0;">
          Your Differentials (&lt;${OWNERSHIP_THRESHOLDS.differential}% owned)
        </h4>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${insights.myDifferentials.map(p => `
            <span style="
              background: #22c55e;
              color: #0b1020;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
            ">
              ${p.name} (${formatPercent(p.ownershipPct)})
            </span>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${insights.templatesMissing.length > 0 ? `
      <div style="margin-top: 16px;">
        <h4 style="font-size: 13px; color: #94a3b8; margin: 0 0 8px 0;">
          ⚠ Templates You're Missing (&gt;${OWNERSHIP_THRESHOLDS.threat}% owned)
        </h4>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${insights.templatesMissing.map(p => `
            <span style="
              background: ${p.ownedByTopRivals ? '#ef4444' : '#f97316'};
              color: #fff;
              padding: 4px 8px;
              border-radius: 4px;
              font-size: 11px;
              font-weight: 600;
            ">
              ${p.name} (${formatPercent(p.ownershipPct)})
              ${p.ownedByTopRivals ? ' 🔥' : ''}
            </span>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${insights.myTeam && insights.myTeam.size > 0 ? `
      <div style="margin-top: 16px;">
        <h4 style="font-size: 13px; color: #94a3b8; margin: 0 0 8px 0;">
          🎯 Top Expected Points Next GW
        </h4>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">
          ${Array.from(insights.myTeam)
            .map(pid => ({
              playerId: pid,
              name: playerById[pid]?.web_name || `#${pid}`,
              xPts: Number(playerById[pid]?.ep_next || 0)
            }))
            .sort((a, b) => b.xPts - a.xPts)
            .slice(0, 5)
            .map(p => `
              <span style="
                background: ${colorForXPts(p.xPts)};
                color: #0b1020;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 600;
              ">
                ${p.name} (${p.xPts > 0 ? p.xPts.toFixed(1) : 'n/a'})
              </span>
            `).join('')}
        </div>
      </div>
    ` : ''}

    <div style="margin-top: 16px; padding: 12px; background: #0f172a; border-radius: 6px; border-left: 3px solid #3b82f6;">
      <div style="font-size: 12px; font-weight: 600; color: #60a5fa; margin-bottom: 6px;">
        💡 Recommendations
      </div>
      <div style="font-size: 11px; color: #cbd5e1; line-height: 1.5;">
        ${getRecommendations(insights)}
      </div>
    </div>
  `;

  return panel;
}

async function scanMyTeamInsights(viewId) {
  if (!currentEventId) return;

  // Find insertion point (before pitch)
  const pitchContainer = document.querySelector('[data-testid="pitch"]') ||
                         document.querySelector('.Pitch') ||
                         document.querySelector('[class*="Pitch"]') ||
                         document.querySelector('[class*="pitch"]');

  if (!pitchContainer) {
    debugLog(`[${viewId}] pitch container not found`);
    return;
  }

  // Remove old insights panel if exists
  const existing = document.querySelector('.fpl-diff-insights-panel');
  if (existing) existing.remove();

  // Calculate insights
  const insights = await calculateDifferentialInsights(currentEventId);

  // Create insights panel
  const panel = createInsightsPanel(insights);

  // Insert before pitch
  pitchContainer.parentElement.insertBefore(panel, pitchContainer);
  debugLog(`[${viewId}] insights panel injected`);
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

function invalidateOwnershipCaches() {
  miniLeagueOwnershipCache.clear();
  myCurrentTeamCache.clear();
  debugLog("Ownership caches invalidated");
}

async function init() {
  debugLog("FPL XG running", new Date().toISOString());
  await loadBootstrap();

  // Preload ownership data for current event in background
  if (Number.isFinite(Number(currentEventId))) {
    debugLog("Preloading ownership data for event", currentEventId);
    loadMiniLeagueOwnership(currentEventId).catch(e =>
      debugLog("Preload ownership failed", e)
    );
    loadMyCurrentTeam(currentEventId).catch(e =>
      debugLog("Preload my team failed", e)
    );
  }

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

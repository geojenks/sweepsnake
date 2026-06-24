// highlights.js — no-spoiler daily highlights hub. Loads match data from
// Supabase and video IDs from data/highlights.json (populated by GitHub Actions).
import { onTableChange } from "./supabase.js";
import { $, el, playerColour, playerSubname, loadLiveData, showError } from "./app.js";

const root = $("#content");
const state = { data: null, teamsFile: null, videos: {} };

start();

async function start() {
  try {
    const [data, teamsFile, hlFile] = await Promise.all([
      loadLiveData(),
      fetch("data/wc2026_teams.json").then((r) => r.json()),
      fetch("data/highlights.json").then((r) => r.json()).catch(() => ({ videos: {} })),
    ]);
    state.data = data;
    state.teamsFile = teamsFile;
    state.videos = hlFile.videos || {};
  } catch (e) { showError(root, e); return; }
  render();
  const refresh = async () => { state.data = await loadLiveData(); render(); };
  onTableChange("matches", refresh);
}

// ---- helpers ----

const fmtDate = (utc) => new Date(utc).toLocaleString("en-GB", {
  weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
}) + " BST";

const bstDateKey = (utc) => new Date(utc).toLocaleDateString("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
  timeZone: "Europe/London",
});

// ---- render ----

function render() {
  const { players, teams, matches } = state.data;

  const playerById = new Map(players.map((p) => [p.id, p]));

  // Merge static team metadata with live DB data (owner, tier).
  const teamMeta = new Map(state.teamsFile.teams.map((t) => [t.id, { ...t }]));
  for (const t of teams) {
    const m = teamMeta.get(t.id);
    if (m) { m.player_id = t.player_id; m.tier = t.tier; }
  }

  const finished = matches
    .filter((m) => m.status === "FINISHED" && m.home_team_id && m.away_team_id && m.utc_date)
    .sort((a, b) => b.utc_date.localeCompare(a.utc_date)); // newest first

  root.innerHTML = "";

  if (!finished.length) {
    root.append(el("div", { class: "panel" },
      el("h2", {}, "Highlights"),
      el("p", { class: "muted small" }, "No matches played yet — check back after kick-off.")));
    return;
  }

  root.append(el("div", { class: "panel" },
    el("h2", {}, "Highlights"),
    el("p", { class: "muted small", style: { margin: 0 } },
      "Scores are hidden by default so you can watch without spoilers. ",
      "Videos sync automatically each morning via YouTube.")));

  // Group by BST date
  const byDate = new Map();
  for (const m of finished) {
    const key = bstDateKey(m.utc_date);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(m);
  }

  for (const [dateLabel, dayMatches] of byDate) {
    root.append(daySection(dateLabel, dayMatches, teamMeta, playerById));
  }
}

function daySection(dateLabel, matches, teamMeta, playerById) {
  const cards = el("div", { class: "cards", style: { gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" } },
    matches.map((m) => matchCard(m, teamMeta, playerById)));
  return el("div", {},
    el("h3", { style: { margin: "8px 2px 10px", fontSize: "0.9rem", color: "var(--text-dim)", fontWeight: "600" } }, dateLabel),
    cards);
}

function matchCard(m, teamMeta, playerById) {
  const home = teamMeta.get(m.home_team_id) || {};
  const away = teamMeta.get(m.away_team_id) || {};
  const homeOwner = playerById.get(home.player_id);
  const awayOwner = playerById.get(away.player_id);
  const videoId = state.videos[String(m.id)];

  const card = el("div", { class: "panel", style: { margin: 0, display: "flex", flexDirection: "column", gap: "6px" } });

  // Player names — big, coloured
  card.append(el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } },
    playerLabel(homeOwner, "left"),
    el("span", { class: "muted", style: { fontSize: "0.7rem", flexShrink: "0" } }, "vs"),
    playerLabel(awayOwner, "right")));

  // Team names + kick-off time — small
  card.append(el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" } },
    el("span", { class: "muted small" }, `${home.flag || ""} ${home.name || "?"}`),
    el("span", { class: "muted", style: { fontSize: "0.68rem", textAlign: "center", flexShrink: "0" } }, fmtDate(m.utc_date)),
    el("span", { class: "muted small", style: { textAlign: "right" } }, `${away.flag || ""} ${away.name || "?"}`)));

  // Score reveal + watch button
  const scoreEl = el("span", { style: { fontWeight: "700", display: "none", fontSize: "1rem" } },
    `${m.home_score} – ${m.away_score}`);
  const revealBtn = el("button", { class: "btn", style: { fontSize: "0.78rem" } }, "Reveal score");
  revealBtn.onclick = () => { revealBtn.style.display = "none"; scoreEl.style.display = ""; };

  const videoArea = el("div", {});

  if (videoId) {
    const watchBtn = el("button", { class: "btn", style: { fontSize: "0.78rem" } }, "▶ Watch highlights");
    watchBtn.onclick = () => {
      watchBtn.remove();
      videoArea.append(embedFrame(videoId));
    };
    card.append(el("div", { class: "btn-row", style: { marginTop: "2px" } },
      el("span", { style: { display: "flex", alignItems: "center", gap: "8px" } }, revealBtn, scoreEl),
      watchBtn));
  } else {
    card.append(el("div", { class: "btn-row", style: { marginTop: "2px" } },
      el("span", { style: { display: "flex", alignItems: "center", gap: "8px" } }, revealBtn, scoreEl),
      el("span", { class: "muted", style: { fontSize: "0.72rem" } }, "Highlights not yet available")));
  }

  card.append(videoArea);
  return card;
}

function playerLabel(player, align) {
  if (!player) return el("span", { class: "muted small" }, "—");
  const sub = playerSubname(player);
  return el("span", { style: { display: "flex", flexDirection: "column", alignItems: align === "right" ? "flex-end" : "flex-start" } },
    el("span", { style: { fontWeight: "700", color: playerColour(player), fontSize: "0.95rem" } }, player.name),
    sub ? el("span", { class: "muted", style: { fontSize: "0.68rem" } }, sub) : null);
}

function embedFrame(videoId) {
  return el("div", { style: { position: "relative", paddingTop: "56.25%", marginTop: "8px" } },
    el("iframe", {
      src: `https://www.youtube.com/embed/${videoId}?autoplay=1`,
      style: { position: "absolute", top: "0", left: "0", width: "100%", height: "100%", border: "none", borderRadius: "8px" },
      allow: "autoplay; fullscreen",
      allowfullscreen: true,
    }));
}

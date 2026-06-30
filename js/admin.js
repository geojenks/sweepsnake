// admin.js — commissioner controls: config, draft status, players, team seeding,
// manual pick override, draft reset, and per-match result overrides.
import { PLAYER_COLOURS } from "./engine.js";
import {
  sb, setConfig, getPlayers, addPlayer, updatePlayer, deletePlayer,
  upsertTeams, assignTeam, overrideMatch,
} from "./supabase.js";
import { $, el, playerColour, loadLiveData, showError } from "./app.js";

const root = $("#content");
const state = { data: null };

start();

async function start() {
  try { state.data = await loadLiveData(); }
  catch (e) { showError(root, e); return; }
  render();
}
async function reload() { state.data = await loadLiveData(); render(); }

function render() {
  const { config, players, teams, matches } = state.data;
  root.innerHTML = "";
  root.append(
    configPanel(config),
    draftStatusPanel(config),
    teamsPanel(teams),
    playersPanel(players, config, teams),
    overridePanel(players, teams),
    resetPanel(),
    matchesPanel(matches, teams),
  );
}

const num = (v, d) => (v == null || v === "" ? d : Number(v));

function field(label, input) {
  return el("label", { class: "small", style: { display: "flex", flexDirection: "column", gap: "4px" } },
    el("span", { class: "muted" }, label), input);
}
function textInput(value, props = {}) {
  return el("input", {
    value: value ?? "", ...props,
    style: {
      background: "var(--bg-row)", color: "var(--text)", border: "1px solid var(--line)",
      borderRadius: "8px", padding: "8px 12px", fontFamily: "var(--ui-font)", fontSize: "0.9rem",
      ...(props.style || {}),
    },
  });
}

// ---- Config ----
function configPanel(config) {
  const nPlayers = textInput(num(config.n_players, 6), { type: "number", min: "2", max: "6" });
  const nTeams = textInput(num(config.n_teams, 48), { type: "number", min: "6", max: "48" });
  const stake = textInput(num(config.stake, 50), { type: "number", min: "0" });
  const out = el("p", { class: "small muted" });

  const recalc = () => {
    const p = Number(nPlayers.value), t = Number(nTeams.value);
    if (p > 0 && t % p === 0) out.textContent = `→ ${t / p} rounds / leagues, ${t / p} teams per player. Pot £${stake.value * p}.`;
    else out.textContent = `⚠ ${t} teams must divide evenly by ${p} players.`;
  };
  [nPlayers, nTeams, stake].forEach((i) => i.addEventListener("input", recalc));
  recalc();

  const save = async () => {
    const p = Number(nPlayers.value), t = Number(nTeams.value);
    if (t % p !== 0) { alert("Teams must divide evenly by players."); return; }
    await Promise.all([
      setConfig("n_players", p), setConfig("n_teams", t),
      setConfig("n_rounds", t / p), setConfig("stake", Number(stake.value)),
    ]);
    await reload();
  };

  return el("div", { class: "panel" },
    el("h2", {}, "Configuration"),
    el("div", { class: "btn-row", style: { alignItems: "flex-end" } },
      field("Players", nPlayers), field("Teams", nTeams), field("Stake (£)", stake),
      el("button", { class: "btn", onclick: save }, "Save config")),
    out);
}

// ---- Draft status ----
function draftStatusPanel(config) {
  const status = (config.draft_status || "setup").replace(/"/g, "");
  const set = async (s) => { await setConfig("draft_status", s); await reload(); };
  const btn = (label, s) => el("button", {
    class: "btn" + (status === s ? " active" : ""), onclick: () => set(s),
  }, label);
  return el("div", { class: "panel" },
    el("h2", {}, "Draft status: ", el("span", { style: { color: "var(--gold)" } }, status)),
    el("div", { class: "btn-row" },
      btn("Open draft", "open"), btn("Pause", "paused"),
      btn("Close", "closed"), btn("Back to setup", "setup")));
}

// ---- Teams (seed + in/out) ----
function teamsPanel(teams) {
  const seed = async () => {
    const res = await fetch("data/wc2026_teams.json");
    const data = await res.json();
    const rows = data.teams.map((t) => ({
      id: t.id, name: t.name, tla: t.tla, flag: t.flag, crest: t.crest,
      fifa_ranking: t.fifaRank, in_play: true,
    }));
    await upsertTeams(rows);
    await reload();
  };
  const inPlay = teams.filter((t) => t.in_play !== false).length;
  return el("div", { class: "panel" },
    el("h2", {}, `Teams (${teams.length} loaded, ${inPlay} in play)`),
    el("p", { class: "muted small" }, "Seed the full 48-team list from the data file (idempotent)."),
    el("div", { class: "btn-row" },
      el("button", { class: "btn", onclick: seed }, "Seed / refresh teams")));
}

// ---- Players (and draft order) ----
function playersPanel(players, config, teams) {
  const nPlayers = num(config.n_players, 6);
  const sorted = [...players].sort((a, b) => a.slot - b.slot);
  const draftStarted = teams.some((t) => t.tier != null);

  const name = textInput("", { placeholder: "new player name" });
  const add = async () => {
    const n = name.value.trim(); if (!n) return;
    const taken = new Set(players.map((p) => p.slot));
    let slot = 1; while (taken.has(slot)) slot++;
    await addPlayer(n, PLAYER_COLOURS[(slot - 1) % PLAYER_COLOURS.length], slot);
    await reload();
  };

  // Swap a player's seat with the neighbour above/below to set the round-1 order.
  const move = async (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[idx], b = sorted[j];
    await Promise.all([updatePlayer(a.id, { slot: b.slot }), updatePlayer(b.id, { slot: a.slot })]);
    await reload();
  };

  const rows = sorted.map((p, i) =>
    el("div", { class: "btn-row", style: { alignItems: "center" } },
      el("span", { class: "tier-badge", style: { background: playerColour(p), color: "#10141a" } }, String(p.slot)),
      el("span", { style: { color: playerColour(p), fontWeight: "700", minWidth: "120px" } }, p.name),
      el("button", { class: "btn", title: "move up (earlier pick)", disabled: i === 0 ? "" : null, onclick: () => move(i, -1) }, "↑"),
      el("button", { class: "btn", title: "move down (later pick)", disabled: i === sorted.length - 1 ? "" : null, onclick: () => move(i, 1) }, "↓"),
      el("button", {
        class: "btn", onclick: async () => { if (confirm(`Remove ${p.name}?`)) { await deletePlayer(p.id); await reload(); } },
      }, "Remove")));

  return el("div", { class: "panel" },
    el("h2", {}, `Players & draft order (${players.length} / ${nPlayers})`),
    el("p", { class: "muted small" },
      "Seat order = round-1 pick order (seat 1 picks first); later rounds rotate one seat each round. ",
      "Arrange these to match your FPL finishing order ",
      draftStarted ? el("strong", { style: { color: "var(--gold)" } }, "— the draft has started, so reordering now will scramble it.") : "before opening the draft."),
    el("div", { style: { display: "flex", flexDirection: "column", gap: "8px", margin: "12px 0" } }, rows),
    el("div", { class: "btn-row" }, name, el("button", { class: "btn", onclick: add }, "Add player")));
}

// ---- Manual pick override ----
function overridePanel(players, teams) {
  const teamSel = el("select", { class: "btn" },
    teams.filter((t) => t.in_play !== false).sort((a, b) => (a.fifa_ranking || 999) - (b.fifa_ranking || 999))
      .map((t) => el("option", { value: t.id }, `${t.flag || ""} ${t.name}${t.player_id ? " (drafted)" : ""}`)));
  const playerSel = el("select", { class: "btn" },
    [el("option", { value: "" }, "— unassign —"),
     ...players.sort((a, b) => a.slot - b.slot).map((p) => el("option", { value: p.id }, p.name))]);
  const tier = textInput(1, { type: "number", min: "1", style: { width: "70px" } });

  const apply = async () => {
    const teamId = teamSel.value, playerId = playerSel.value || null;
    await assignTeam(teamId, playerId, playerId ? Number(tier.value) : null);
    await reload();
  };
  return el("div", { class: "panel" },
    el("h2", {}, "Manual pick override"),
    el("p", { class: "muted small" }, "Assign any team to any player at any tier, or unassign it."),
    el("div", { class: "btn-row", style: { alignItems: "flex-end" } },
      field("Team", teamSel), field("Player", playerSel), field("Tier", tier),
      el("button", { class: "btn", onclick: apply }, "Apply")));
}

// ---- Reset draft ----
function resetPanel() {
  const reset = async () => {
    if (!confirm("Clear ALL draft picks and team assignments? This cannot be undone.")) return;
    const ids = state.data.teams.map((t) => t.id);
    await sb.from("teams").update({ tier: null, player_id: null }).in("id", ids);
    await sb.from("draft_picks").delete().gte("id", 1);
    await setConfig("draft_status", "setup");
    await reload();
  };
  return el("div", { class: "panel", style: { borderColor: "#5c2b2b" } },
    el("h2", {}, "Danger zone"),
    el("div", { class: "btn-row" },
      el("button", { class: "btn", onclick: reset }, "Reset draft (clear all picks)")));
}

// ---- Matches: sync note + per-match override ----
function matchesPanel(matches, teams) {
  const nameOf = new Map(teams.map((t) => [t.id, t]));
  const finished = matches.filter((m) => m.status === "FINISHED");

  const note = el("p", { class: "muted small" },
    "Results sync automatically via GitHub Actions (every 2h during the tournament), and you can trigger it manually from your repo's ",
    el("strong", {}, "Actions → Sync results → Run workflow"),
    ". Use the overrides below only to correct a result the API got wrong.");

  if (matches.length === 0) {
    return el("div", { class: "panel" }, el("h2", {}, "Results & overrides"), note,
      el("p", { class: "small muted" }, "No matches synced yet."));
  }

  const rows = finished.map((m) => matchRow(m, nameOf));
  return el("div", { class: "panel" },
    el("h2", {}, `Results & overrides (${finished.length} finished)`), note,
    el("div", { style: { display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" } }, rows));
}

function matchRow(m, nameOf) {
  const h = nameOf.get(m.home_team_id), a = nameOf.get(m.away_team_id);
  const hs  = textInput(m.home_score, { type: "number", style: { width: "56px" } });
  const as  = textInput(m.away_score, { type: "number", style: { width: "56px" } });
  const phs = textInput(m.pen_home,   { type: "number", style: { width: "48px" }, placeholder: "ph" });
  const pas = textInput(m.pen_away,   { type: "number", style: { width: "48px" }, placeholder: "pa" });
  const type = el("select", { class: "btn" },
    ["REGULAR", "EXTRA_TIME", "PENALTIES"].map((t) =>
      el("option", { value: t, ...(m.match_type === t ? { selected: "" } : {}) }, t)));
  const save = async () => {
    const home = Number(hs.value), away = Number(as.value);
    const isPen = type.value === "PENALTIES";
    const ph = phs.value !== "" ? Number(phs.value) : null;
    const pa = pas.value !== "" ? Number(pas.value) : null;
    // For pens derive winner from pen scores (match score is level); otherwise from match score.
    let winner;
    if (isPen && ph != null && pa != null && ph !== pa) winner = ph > pa ? "HOME" : "AWAY";
    else winner = home > away ? "HOME" : away > home ? "AWAY" : "DRAW";
    await overrideMatch(m.id, {
      home_score: home, away_score: away,
      pen_home: isPen ? ph : null, pen_away: isPen ? pa : null,
      match_type: type.value, winner, status: "FINISHED",
    });
    await reload();
  };
  return el("div", { class: "btn-row", style: { alignItems: "center", flexWrap: "wrap", gap: "6px" } },
    m.is_overridden ? el("span", { title: "overridden" }, "✏️") : el("span", {}, ""),
    el("span", { class: "small", style: { minWidth: "140px", textAlign: "right" } }, `${h?.flag || ""} ${h?.name || m.home_team_id}`),
    hs, el("span", { class: "muted" }, "–"), as,
    el("span", { class: "small muted", style: { fontSize: "0.72rem" } }, "(pens:"),
    phs, el("span", { class: "muted" }, "–"), pas,
    el("span", { class: "small muted", style: { fontSize: "0.72rem" } }, ")"),
    el("span", { class: "small", style: { minWidth: "140px" } }, `${a?.name || m.away_team_id} ${a?.flag || ""}`),
    type, el("button", { class: "btn", onclick: save }, "Save"));
}

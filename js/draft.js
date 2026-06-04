// draft.js — async cyclic-rotation draft room. Players pick for themselves;
// the team's tier = the round it's picked in.
import { draftOrder, tierColour } from "./engine.js";
import { assignTeam, recordPick, onTableChange } from "./supabase.js";
import {
  $, el, playerColour, loadLiveData, showError, getIdentity,
} from "./app.js";

const root = $("#content");
const state = { data: null, busy: false, groupByTeam: new Map() };

// Where each group's top two go in the Round of 32 (official 2026 bracket).
const GROUP_NOTE = {
  A: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group B runner-up",
  B: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group A runner-up",
  C: "Winner → R32 vs Group F runner-up · Runner-up → R32 vs Group F winner",
  D: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group G runner-up",
  E: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group I runner-up",
  F: "Winner → R32 vs Group C runner-up · Runner-up → R32 vs Group C winner",
  G: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group D runner-up",
  H: "Winner → R32 vs Group J runner-up · Runner-up → R32 vs Group J winner",
  I: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group E runner-up",
  J: "Winner → R32 vs Group H runner-up · Runner-up → R32 vs Group H winner",
  K: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group L runner-up",
  L: "Winner → R32 vs a best third-placed team · Runner-up → R32 vs Group K runner-up",
};

start();

async function start() {
  try {
    const [data, teamsFile] = await Promise.all([
      loadLiveData(),
      fetch("data/wc2026_teams.json").then((r) => r.json()).catch(() => ({ teams: [] })),
    ]);
    state.data = data;
    state.groupByTeam = new Map(teamsFile.teams.map((t) => [t.id, t.group]));
  } catch (e) { showError(root, e); return; }
  render();
  const refresh = async () => { state.data = await loadLiveData(); render(); };
  onTableChange("teams", refresh);
  onTableChange("draft_picks", refresh);
}

// Derive the full pick schedule and where we are in it.
function schedule() {
  const { config, players } = state.data;
  const nPlayers = Number(config.n_players) || 6;
  const nRounds = Number(config.n_rounds) || 8;
  const bySlot = new Map(players.map((p) => [p.slot, p]));
  // order[i] is a 0-based player index; slot = index + 1.
  const order = draftOrder(nPlayers, nRounds).map((idx) => bySlot.get(idx + 1) || null);
  return { nPlayers, nRounds, order };
}

function render() {
  const { config, players, teams } = state.data;
  const status = (config.draft_status || "setup").replace(/"/g, "");
  const me = players.find((p) => p.id === getIdentity());
  const { nPlayers, nRounds, order } = schedule();

  const picksMade = teams.filter((t) => t.tier != null && t.player_id != null).length;
  const totalPicks = order.length;
  const complete = picksMade >= totalPicks;
  const current = complete ? null : order[picksMade];
  const round = Math.floor(picksMade / nPlayers) + 1;

  root.innerHTML = "";

  // ---- status / turn banner ----
  const myTurn = !complete && status === "open" && current && me && current.id === me.id;
  if (complete) {
    root.append(banner("Draft complete 🎉", "All teams are assigned. ",
      el("a", { href: "table.html" }, "View the league tables →"), "var(--gold)"));
  } else if (status !== "open") {
    root.append(banner(
      status === "paused" ? "Draft paused" : "Draft not open yet",
      "The commissioner controls the draft on the ",
      el("a", { href: "admin.html" }, "admin page"), ".", "var(--text-dim)"));
  } else if (myTurn) {
    root.append(banner("It's your turn!",
      `Round ${round} → your Tier ${round} pick. Choose a team below.`, null, playerColour(me)));
  } else if (current) {
    root.append(banner(`Waiting on ${current.name}`,
      `Round ${round} of ${nRounds}. You'll be notified in the group chat when it's your turn.`,
      null, playerColour(current)));
  }

  // ---- pick queue (next 3) ----
  if (!complete) {
    const upcoming = order.slice(picksMade, picksMade + 3);
    root.append(el("div", { class: "panel" },
      el("h2", {}, "Up next"),
      el("div", { class: "btn-row" },
        upcoming.map((p, i) => el("div", {
          class: "winner-card",
          style: { borderLeftColor: playerColour(p), padding: "8px 12px" },
        },
          el("div", { class: "lg" }, i === 0 ? "on the clock" : `+${i}`),
          el("div", { style: { color: playerColour(p), fontWeight: "700" } }, p?.name || "—"),
          el("div", { class: "small muted" }, `Tier ${Math.floor((picksMade + i) / nPlayers) + 1}`))))));
  }

  // ---- rosters ----
  root.append(rosters(players, teams, nRounds));

  // ---- available teams ----
  root.append(availableBoard(teams, myTurn, round, me));
}

function banner(title, ...rest) {
  const colour = rest.pop();
  return el("div", { class: "panel", style: { borderLeft: `4px solid ${colour}` } },
    el("h2", { style: { color: colour } }, title),
    el("p", { class: "muted small", style: { margin: 0 } }, ...rest));
}

function rosters(players, teams, nRounds) {
  const grid = el("div", { class: "cards" });
  for (const p of [...players].sort((a, b) => a.slot - b.slot)) {
    const mine = teams.filter((t) => t.player_id === p.id).sort((a, b) => a.tier - b.tier);
    const colour = playerColour(p);
    grid.append(el("div", { class: "winner-card", style: { borderLeftColor: colour } },
      el("div", { style: { color: colour, fontWeight: "700", marginBottom: "4px" } },
        `${p.name} (${mine.length})`),
      mine.length
        ? el("div", {},
            mine.map((t) => el("div", { class: "small" },
              el("span", { class: "tier-badge", style: { background: tierColour(t.tier), marginRight: "6px" } }, String(t.tier)),
              `${t.flag || ""} ${t.name}`)))
        : el("div", { class: "small muted" }, "no picks yet")));
  }
  return el("div", { class: "panel" }, el("h2", {}, "Rosters"), grid);
}

function availableBoard(teams, myTurn, round, me) {
  const avail = teams
    .filter((t) => t.in_play !== false && t.tier == null)
    .sort((a, b) => (a.fifa_ranking || 999) - (b.fifa_ranking || 999));

  const card = (t) => el("div", {
    class: "winner-card",
    style: { borderLeftColor: "var(--line)", cursor: myTurn ? "pointer" : "default", opacity: myTurn ? "1" : "0.85" },
    title: myTurn ? `Draft ${t.name} into your Tier ${round}` : "",
    onclick: myTurn ? () => pick(t, round, me) : null,
  },
    el("div", { class: "lg" }, `FIFA #${t.fifa_ranking ?? "—"}`),
    el("div", { class: "team" }, `${t.flag || ""} ${t.name}`));

  // Group the still-available teams by their World Cup group (A–L).
  const groups = new Map();
  for (const t of avail) {
    const g = state.groupByTeam.get(t.id) || "?";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }

  const sections = [...groups.keys()].sort().map((g) => {
    const grid = el("div", {
      class: "cards", style: { gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", marginTop: "8px" },
    });
    groups.get(g).forEach((t) => grid.append(card(t)));
    return el("div", { style: { marginTop: "14px" } },
      el("div", { class: "btn-row", style: { gap: "10px", alignItems: "baseline" } },
        el("span", { style: { fontWeight: "700", fontSize: "0.95rem" } }, `Group ${g}`),
        el("span", { class: "muted small" }, GROUP_NOTE[g] || "")),
      grid);
  });

  return el("div", { class: "panel" },
    el("h2", {}, `Available teams (${avail.length})`,
      myTurn ? null : el("span", { class: "muted small" }, " — wait for your turn to pick")),
    el("p", { class: "muted small", style: { margin: "0 0 4px" } },
      "Grouped by World Cup group; top two of each group reach the Round of 32. Ordered by FIFA seed within each group."),
    sections);
}

async function pick(team, round, me) {
  if (state.busy) return;
  if (!confirm(`Draft ${team.name} into your Tier ${round}?`)) return;
  state.busy = true;
  try {
    // Re-check it's still our turn (cheap guard against an async double-pick).
    const fresh = await loadLiveData();
    state.data = fresh;
    const { nPlayers, order } = schedule();
    const picksMade = fresh.teams.filter((t) => t.tier != null && t.player_id != null).length;
    const current = order[picksMade];
    if (!current || current.id !== me.id) {
      alert("That pick was just taken — it's no longer your turn.");
      render(); return;
    }
    if (fresh.teams.find((t) => t.id === team.id)?.tier != null) {
      alert(`${team.name} was just drafted by someone else.`);
      render(); return;
    }
    const r = Math.floor(picksMade / nPlayers) + 1;
    await assignTeam(team.id, me.id, r);
    await recordPick({
      round: r, pick_in_round: (picksMade % nPlayers) + 1,
      overall_pick: picksMade + 1, player_id: me.id, team_id: team.id,
    });
    state.data = await loadLiveData();
    render();
  } catch (e) {
    alert("Pick failed: " + e.message);
  } finally {
    state.busy = false;
  }
}

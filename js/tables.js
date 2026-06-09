// tables.js — live subsumptive league tables during the tournament.
import {
  computeStandings, computeLeagues, computePlayerLeague, tierColour,
  leaguePrize, playerLeaguePrize,
} from "./engine.js";
import { onTableChange, getDraftPicks } from "./supabase.js";
import { $, el, fmtSigned, playerColour, loadLiveData, showError } from "./app.js";

const root = $("#content");
const state = { selectedLeague: 1, data: null, orderOf: new Map() };

start();

async function start() {
  try {
    const [data, picks] = await Promise.all([loadLiveData(), getDraftPicks()]);
    state.data = data;
    // teamId -> overall draft pick. Used to break ties in choice order, so
    // before any match is played the leagues read down in the order teams were
    // drafted (league 1 = the full run of picks, league 2 = that minus tier 1…).
    state.orderOf = new Map(picks.map((p) => [p.team_id, p.overall_pick]));
  } catch (e) {
    showError(root, e);
    return;
  }
  render();
  // Auto-refresh when results or the draft change.
  const refresh = async () => { state.data = await loadLiveData(); render(); };
  onTableChange("matches", refresh);
  onTableChange("teams", refresh);
}

function render() {
  const { config, players, teams, matches } = state.data;
  const nRounds = Number(config.n_rounds) || 8;

  // Only drafted, in-play teams form the league tables.
  const drafted = teams.filter((t) => t.in_play !== false && t.tier != null && t.player_id != null);

  root.innerHTML = "";

  if (drafted.length === 0) {
    root.append(el("div", { class: "panel" },
      el("h2", {}, "Tables go live after the draft"),
      el("p", { class: "muted small" },
        "No teams have been drafted yet. Once the snake draft finishes, the league tables appear here. "),
      el("p", { class: "small" }, el("a", { href: "draft.html" }, "Go to the draft room →"))));
    return;
  }

  const playerById = new Map(players.map((p) => [p.id, p]));
  const teamMeta = new Map(teams.map((t) => [t.id, t]));
  const tierOf = new Map(drafted.map((t) => [t.id, t.tier]));
  const ownerOf = new Map(drafted.map((t) => [t.id, t.player_id]));
  const slotOf = (pid) => playerById.get(pid)?.slot ?? 99;
  // Tie-break key: teams level on points sort by draft choice order (zero-padded
  // so the string compare matches numeric order). Before any match this makes the
  // whole table read in pick order; afterwards it's just the final tiebreak.
  const orderKey = (id) => String(state.orderOf.get(id) ?? 999).padStart(3, "0");

  const nPlayers = Number(config.n_players) || players.length || 6;
  const prizes = { league: leaguePrize(nPlayers), player: playerLeaguePrize(nPlayers) };

  const engineTeams = drafted.map((t) => ({ teamId: t.id, tier: t.tier }));
  // Start every drafted team at zero so the tables are fully populated before
  // kick-off; finished matches then overlay real points.
  const standings = withAllDrafted(computeStandings(canonicalMatches(matches)), drafted);
  const leagues = computeLeagues(engineTeams, standings, nRounds, orderKey);
  const playerLeague = computePlayerLeague(ownerOf, standings)
    .sort((a, b) => b.total - a.total || b.gd - a.gd || b.gf - a.gf
      || slotOf(a.playerId) - slotOf(b.playerId));

  root.append(playerLeaguePanel(playerLeague, playerById, ownerOf, teamMeta, tierOf, prizes.player));
  root.append(filterBar(leagues, prizes.league));
  root.append(teamTable(leagues, teamMeta, tierOf, ownerOf, playerById));
  root.append(el("p", { class: "footnote" },
    `${standings.size} teams · ${matches.filter((m) => m.status === "FINISHED").length} matches played · live from Supabase.`));
}

// Ensure every drafted team has a standings row, even with no matches played yet,
// so the leagues are populated with zeros from the moment the draft closes.
function withAllDrafted(standings, drafted) {
  for (const t of drafted) {
    if (!standings.has(t.id)) {
      standings.set(t.id, {
        teamId: t.id, played: 0, w: 0, d: 0, l: 0,
        gf: 0, ga: 0, gd: 0, matchPoints: 0, bonusPoints: 0, total: 0,
      });
    }
  }
  return standings;
}

// Matches in the DB are already in the engine's canonical shape; just pass the
// finished ones (scheduled rows have null scores).
function canonicalMatches(matches) {
  return matches
    .filter((m) => m.status === "FINISHED" && m.home_score != null && m.away_score != null)
    .map((m) => ({
      id: m.id, stage: m.stage,
      home: m.home_team_id, away: m.away_team_id,
      homeScore: m.home_score, awayScore: m.away_score,
      type: m.match_type || "REGULAR",
      winner: m.winner || (m.home_score > m.away_score ? "HOME" : m.away_score > m.home_score ? "AWAY" : "DRAW"),
    }));
}

function filterBar(leagues, prize) {
  const bar = el("div", { class: "btn-row", style: { marginBottom: "14px" } });
  for (const lg of leagues) {
    const label = lg.league === 1 ? "League 1 · All" : `League ${lg.league}`;
    const b = el("button", {
      class: "btn" + (lg.league === state.selectedLeague ? " active" : ""),
      title: `Teams of tier ≥ ${lg.league} (${lg.members.length})`,
      onclick: () => { state.selectedLeague = lg.league; render(); },
    }, label);
    bar.append(b);
  }
  bar.append(el("span", { class: "muted small", style: { marginLeft: "4px" } }, `each league · £${prize}`));
  return bar;
}

function teamTable(leagues, teamMeta, tierOf, ownerOf, playerById) {
  const league = leagues[state.selectedLeague - 1];
  const head = ["Tr", "#", "Team", "Player", "P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Bns", "Total"];
  const thead = el("tr", {}, head.map((h, i) =>
    el("th", { class: i < 4 ? "l" : "" }, h)));
  const body = el("tbody");

  league.members.forEach((s, idx) => {
    const meta = teamMeta.get(s.teamId);
    const tier = tierOf.get(s.teamId);
    const player = playerById.get(ownerOf.get(s.teamId));
    const colour = playerColour(player);
    const tr = el("tr", { style: { borderLeft: `4px solid ${colour}` } },
      el("td", { class: "l" }, el("span", { class: "tier-badge", style: { background: tierColour(tier) } }, String(tier))),
      el("td", { class: "l pos num" }, idx + 1),
      el("td", { class: "l" }, el("span", { class: "team-cell" },
        el("span", { class: "flag" }, meta?.flag || ""), meta?.name || s.teamId)),
      el("td", { class: "l owner", style: { color: colour } }, player?.name || "—"),
      el("td", { class: "num" }, s.played),
      el("td", { class: "num" }, s.w),
      el("td", { class: "num" }, s.d),
      el("td", { class: "num" }, s.l),
      el("td", { class: "num" }, s.gf),
      el("td", { class: "num" }, s.ga),
      el("td", { class: "num" }, fmtSigned(s.gd)),
      el("td", { class: "num" }, s.matchPoints),
      el("td", { class: "bonus" }, "+" + s.bonusPoints),
      el("td", { class: "total" }, s.total));
    if (s.teamId === league.winnerId) tr.classList.add("is-winner");
    body.append(tr);
  });

  return el("div", { class: "table-scroll" },
    el("table", { class: "board" }, el("thead", {}, thead), body));
}

function playerLeaguePanel(playerLeague, playerById, ownerOf, teamMeta, tierOf, prize) {
  const teamsByPlayer = new Map();
  for (const [teamId, pid] of ownerOf) {
    if (!teamsByPlayer.has(pid)) teamsByPlayer.set(pid, []);
    teamsByPlayer.get(pid).push(teamId);
  }
  for (const list of teamsByPlayer.values()) list.sort((a, b) => tierOf.get(a) - tierOf.get(b));

  const body = el("tbody");
  playerLeague.forEach((r, idx) => {
    const player = playerById.get(r.playerId);
    const colour = playerColour(player);
    const flags = (teamsByPlayer.get(r.playerId) || []).map((id) =>
      el("span", {
        class: "mini-flag",
        title: `${teamMeta.get(id)?.name} · tier ${tierOf.get(id)}`,
        style: { borderBottom: `2px solid ${tierColour(tierOf.get(id))}` },
      }, teamMeta.get(id)?.flag || ""));
    const tr = el("tr", { style: { borderLeft: `4px solid ${colour}` } },
      el("td", { class: "l pos num" }, idx + 1),
      el("td", { class: "l owner", style: { color: colour } }, player?.name || "—"),
      el("td", { class: "l team-list" }, flags),
      el("td", { class: "num" }, r.w),
      el("td", { class: "num" }, r.d),
      el("td", { class: "num" }, r.l),
      el("td", { class: "num" }, fmtSigned(r.gd)),
      el("td", { class: "num" }, r.matchPoints),
      el("td", { class: "bonus" }, "+" + r.bonusPoints),
      el("td", { class: "total" }, r.total));
    if (idx === 0) tr.classList.add("is-winner");
    body.append(tr);
  });

  const head = ["#", "Player", "Teams (by tier)", "W", "D", "L", "GD", "Pts", "Bns", "Total"];
  return el("div", { class: "panel" },
    el("h2", {}, "Player league ",
      el("span", { class: "muted small" }, "— total across every team owned · winner takes ",
        el("span", { style: { color: "var(--gold)" } }, `£${prize}`))),
    el("div", { class: "table-scroll", style: { marginTop: "8px" } },
      el("table", { class: "board", style: { minWidth: "560px" } },
        el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i < 3 ? "l" : "" }, h)))),
        body)));
}

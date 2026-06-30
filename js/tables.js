// tables.js — live subsumptive league tables during the tournament.
import {
  computeStandings, computeLeagues, computePlayerLeague, tierColour,
  leaguePrize, playerLeaguePrize, ADVANCEMENT_STAGES, POINTS,
} from "./engine.js";
import { onTableChange, getDraftPicks } from "./supabase.js";
import { $, el, fmtSigned, playerColour, playerSubname, loadLiveData, showError } from "./app.js";

const root = $("#content");
const state = { selectedLeague: 1, data: null, teamsFile: null, orderOf: new Map() };

// Live context for popup closures — refreshed on every render().
let ctx = {};

start();

async function start() {
  try {
    const [data, picks, teamsFile] = await Promise.all([
      loadLiveData(), getDraftPicks(),
      fetch("data/wc2026_teams.json").then((r) => r.json()),
    ]);
    state.data = data;
    state.teamsFile = teamsFile;
    state.orderOf = new Map(picks.map((p) => [p.team_id, p.overall_pick]));
  } catch (e) {
    showError(root, e);
    return;
  }
  render();
  const refresh = async () => { state.data = await loadLiveData(); render(); };
  onTableChange("matches", refresh);
  onTableChange("teams", refresh);
}

// ---- helpers ----

const fmtDate = (utc) => new Date(utc).toLocaleString("en-GB", {
  weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
}) + " BST";

// Determine which teams are definitively eliminated.
//
// Group stage: only the 4th-place team in a fully-played group (all 4 teams
// have 3 games) is out. 3rd-place teams are NOT marked out here because 8 of
// the 12 third-place finishers qualify — that's only decided once all groups
// have finished. Checking "no upcoming fixture" is intentionally avoided: the
// round-of-32 draw isn't in football-data.org until after the group stage ends,
// so a group winner would wrongly appear to have no future game.
//
// Knockout stage: the loser of every finished knockout match is out.
function eliminatedSet(matches, teamsFile) {
  // Build group membership from the static teams file.
  const groupMembers = new Map(); // group letter -> [teamId, ...]
  for (const t of (teamsFile?.teams || [])) {
    if (!groupMembers.has(t.group)) groupMembers.set(t.group, []);
    groupMembers.get(t.group).push(t.id);
  }

  // Accumulate group-stage stats and knockout losers.
  const gStats = new Map(); // teamId -> { played, pts, gd, gf }
  const eliminated = new Set();

  for (const m of matches) {
    if (m.status !== "FINISHED") continue;
    const h = m.home_team_id, a = m.away_team_id;
    if (!h || !a) continue;

    if (m.stage === "GROUP_STAGE") {
      if (!gStats.has(h)) gStats.set(h, { played: 0, pts: 0, gd: 0, gf: 0 });
      if (!gStats.has(a)) gStats.set(a, { played: 0, pts: 0, gd: 0, gf: 0 });
      const hs = gStats.get(h), as = gStats.get(a);
      const hg = m.home_score ?? 0, ag = m.away_score ?? 0;
      hs.played++; hs.gf += hg; hs.gd += hg - ag;
      as.played++; as.gf += ag; as.gd += ag - hg;
      if (hg > ag)      { hs.pts += 3; }
      else if (ag > hg) { as.pts += 3; }
      else              { hs.pts += 1; as.pts += 1; }
    } else {
      // Knockout match: loser is out. Mirror the pen-score fallback used in the
      // bonus calculation — football-data.org can store winner="DRAW" for a
      // penalty shootout while it is still processing, so check pen scores too.
      let loser = null;
      if (m.winner === "HOME") loser = a;
      else if (m.winner === "AWAY") loser = h;
      else if (m.match_type === "PENALTIES" && m.pen_home != null && m.pen_away != null && m.pen_home !== m.pen_away)
        loser = m.pen_home > m.pen_away ? a : h;
      if (loser) eliminated.add(loser);
    }
  }

  // For each fully-completed group, 4th place is out; collect 3rd-place finishers.
  const thirdPlacers = []; // { teamId, stats } — for cross-group comparison
  for (const [, members] of groupMembers) {
    if (!members.every((id) => (gStats.get(id)?.played || 0) >= 3)) continue;
    const sorted = [...members].sort((a, b) => {
      const sa = gStats.get(a) || { pts: 0, gd: 0, gf: 0 };
      const sb = gStats.get(b) || { pts: 0, gd: 0, gf: 0 };
      return (sb.pts - sa.pts) || (sb.gd - sa.gd) || (sb.gf - sa.gf);
    });
    eliminated.add(sorted[3]); // definite last place
    thirdPlacers.push({ teamId: sorted[2], stats: gStats.get(sorted[2]) || { pts: 0, gd: 0, gf: 0 } });
  }

  // Once ALL groups are complete the bottom 4 third-place teams are also out.
  // WC 2026: 12 groups, 8 best third-placers advance → bottom 4 eliminated.
  const totalGroups = groupMembers.size; // 12 for WC 2026
  if (thirdPlacers.length === totalGroups) {
    thirdPlacers.sort((a, b) =>
      (b.stats.pts - a.stats.pts) || (b.stats.gd - a.stats.gd) || (b.stats.gf - a.stats.gf));
    const eliminatedThird = totalGroups - 8; // = 4
    for (let i = totalGroups - eliminatedThird; i < totalGroups; i++) {
      eliminated.add(thirdPlacers[i].teamId);
    }
  }

  return eliminated;
}

// ---- floating info popup ----

let _popup = null;
function getPopup() {
  if (!_popup) {
    _popup = el("div", { style: {
      position: "fixed", zIndex: "1000",
      background: "var(--bg-raised)", border: "1px solid var(--line)",
      borderRadius: "10px", padding: "10px 14px",
      boxShadow: "0 6px 24px rgba(0,0,0,.5)",
      fontSize: "0.82rem", maxWidth: "290px", lineHeight: "1.5",
      display: "none",
    }});
    document.body.appendChild(_popup);
    document.addEventListener("click", () => { _popup.style.display = "none"; });
  }
  return _popup;
}

function showPopup(e, content) {
  const p = getPopup();
  p.innerHTML = ""; p.append(content);
  p.style.display = "block";
  const r = e.currentTarget.getBoundingClientRect();
  p.style.top = (r.bottom + 6) + "px";
  p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + "px";
  e.stopPropagation();
}

function teamPopupContent(teamId) {
  const { standings, matches, teamMeta, tierOf, ownerOf, playerById, eliminated } = ctx;
  const meta = teamMeta.get(teamId) || {};
  const s = standings.get(teamId) || { played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, matchPoints: 0, bonusPoints: 0, total: 0 };
  const tier = tierOf.get(teamId);
  const owner = playerById.get(ownerOf.get(teamId));

  const next = matches
    .filter((m) => m.status !== "FINISHED" && (m.home_team_id === teamId || m.away_team_id === teamId))
    .sort((a, b) => (a.utc_date || "").localeCompare(b.utc_date || ""))[0];

  const wrap = el("div", {});

  // Header
  wrap.append(el("div", { style: { fontWeight: "700", marginBottom: "5px" } },
    `${meta.flag || ""} ${meta.name || teamId}`,
    tier ? el("span", { class: "muted", style: { fontWeight: "400", fontSize: "0.72rem", marginLeft: "6px" } }, `T${tier}`) : null));

  // Stats
  if (s.played > 0) {
    wrap.append(el("div", { class: "muted", style: { fontSize: "0.75rem" } },
      `P${s.played}  W${s.w}  D${s.d}  L${s.l}  GD ${fmtSigned(s.gd)}`,
      el("br"),
      `${s.matchPoints}pts + ${s.bonusPoints} bonus = `,
      el("strong", {}, String(s.total))));
  }

  // Next fixture
  if (next) {
    const oppId = next.home_team_id === teamId ? next.away_team_id : next.home_team_id;
    const opp = teamMeta.get(oppId);
    wrap.append(el("div", { style: { marginTop: "6px", borderTop: "1px solid var(--line)", paddingTop: "6px" } },
      el("div", {},
        el("span", { class: "muted", style: { fontSize: "0.7rem" } }, "Next  ·  "),
        `${opp?.flag || ""} ${opp?.name || "TBD"}`),
      el("div", { class: "muted", style: { fontSize: "0.7rem" } }, next.utc_date ? fmtDate(next.utc_date) : "Date TBD")));
  } else if (eliminated.has(teamId)) {
    wrap.append(el("div", { class: "muted", style: { marginTop: "6px", fontSize: "0.75rem" } }, "Eliminated"));
  } else {
    wrap.append(el("div", { class: "muted", style: { marginTop: "6px", fontSize: "0.75rem" } },
      "Next fixture to be confirmed — check the bracket"));
  }

  // Owner
  if (owner) {
    const sub = playerSubname(owner);
    wrap.append(el("div", { class: "muted", style: { marginTop: "5px", borderTop: "1px solid var(--line)", paddingTop: "5px", fontSize: "0.7rem" } },
      `${owner.name}${sub ? ` (${sub})` : ""}`));
  }

  return wrap;
}

function playerPopupContent(playerId) {
  const { matches, teamMeta, teamsByPlayer } = ctx;
  const teamIds = teamsByPlayer.get(playerId) || [];

  const upcoming = matches
    .filter((m) => m.status !== "FINISHED" &&
      (teamIds.includes(m.home_team_id) || teamIds.includes(m.away_team_id)))
    .sort((a, b) => (a.utc_date || "").localeCompare(b.utc_date || ""))
    .slice(0, 3);

  const wrap = el("div", {});
  wrap.append(el("div", { style: { fontWeight: "700", marginBottom: "6px", fontSize: "0.78rem" } }, "Next fixtures"));

  if (!upcoming.length) {
    wrap.append(el("div", { class: "muted small" }, "No upcoming fixtures"));
    return wrap;
  }

  for (const m of upcoming) {
    const homeMeta = teamMeta.get(m.home_team_id) || {};
    const awayMeta = teamMeta.get(m.away_team_id) || {};
    const homeOwned = teamIds.includes(m.home_team_id);
    const awayOwned = teamIds.includes(m.away_team_id);
    wrap.append(el("div", { style: { marginBottom: "5px" } },
      el("div", {},
        el("span", { style: { fontWeight: homeOwned ? "700" : "400" } }, `${homeMeta.flag || ""} ${homeMeta.name || "TBD"}`),
        " vs ",
        el("span", { style: { fontWeight: awayOwned ? "700" : "400" } }, `${awayMeta.flag || ""} ${awayMeta.name || "TBD"}`)),
      el("div", { class: "muted", style: { fontSize: "0.7rem" } }, m.utc_date ? fmtDate(m.utc_date) : "")));
  }

  return wrap;
}

// ---- render ----

function render() {
  const { config, players, teams, matches } = state.data;
  const nRounds = Number(config.n_rounds) || 8;

  const drafted = teams.filter((t) => t.in_play !== false && t.tier != null && t.player_id != null);

  root.innerHTML = "";

  if (drafted.length === 0) {
    root.append(el("div", { class: "panel" },
      el("h2", {}, "Tables go live after the draft"),
      el("p", { class: "muted small" },
        "No teams have been drafted yet. Once the draft finishes, the league tables appear here. ")));
    return;
  }

  const playerById = new Map(players.map((p) => [p.id, p]));
  const teamMeta = new Map(teams.map((t) => [t.id, t]));
  const tierOf = new Map(drafted.map((t) => [t.id, t.tier]));
  const ownerOf = new Map(drafted.map((t) => [t.id, t.player_id]));
  const slotOf = (pid) => playerById.get(pid)?.slot ?? 99;
  const orderKey = (id) => String(state.orderOf.get(id) ?? 999).padStart(3, "0");

  const nPlayers = Number(config.n_players) || players.length || 6;
  const prizes = { league: leaguePrize(nPlayers), player: playerLeaguePrize(nPlayers) };

  const engineTeams = drafted.map((t) => ({ teamId: t.id, tier: t.tier }));
  const standings = withAllDrafted(computeStandings(canonicalMatches(matches)), drafted);

  // Advancement bonus — two signals, both needed because football-data.org
  // populates next-round fixture slots with a lag after each result:
  //
  //  1. Appear in any LAST_32 fixture (home or away, any status):
  //     the bracket is fully resolved once all groups finish, so every
  //     qualifying team is visible here immediately. +ADVANCE each.
  //
  //  2. Win any finished knockout match (LAST_32 through FINAL):
  //     credits the progression bonus the moment the result lands, without
  //     waiting for the winner's ID to appear in the next round's DB row.
  //
  // Together: group qualifier gets +2 as soon as their R32 slot resolves;
  // each subsequent win adds another +2 on the result — no next-fixture needed.
  for (const m of matches) {
    if (!ADVANCEMENT_STAGES.has(m.stage)) continue;

    if (m.stage === "LAST_32") {
      for (const id of [m.home_team_id, m.away_team_id]) {
        const s = id && standings.get(id);
        if (s) { s.bonusPoints += POINTS.ADVANCE; s.total = s.matchPoints + s.bonusPoints; }
      }
    }

    if (m.status === "FINISHED") {
      // Determine the knockout winner. football-data.org occasionally stores
      // winner="DRAW" for penalty shootouts while still processing the result;
      // fall back to pen_home vs pen_away in that case.
      let winnerId = null;
      if (m.winner === "HOME") winnerId = m.home_team_id;
      else if (m.winner === "AWAY") winnerId = m.away_team_id;
      else if (m.match_type === "PENALTIES" && m.pen_home != null && m.pen_away != null && m.pen_home !== m.pen_away)
        winnerId = m.pen_home > m.pen_away ? m.home_team_id : m.away_team_id;
      const s = winnerId && standings.get(winnerId);
      if (s) { s.bonusPoints += POINTS.ADVANCE; s.total = s.matchPoints + s.bonusPoints; }
    }
  }

  const leagues = computeLeagues(engineTeams, standings, nRounds, orderKey);
  const playerLeague = computePlayerLeague(ownerOf, standings)
    .sort((a, b) => b.total - a.total || b.gd - a.gd || b.gf - a.gf
      || slotOf(a.playerId) - slotOf(b.playerId));

  const teamsByPlayer = new Map();
  for (const [teamId, pid] of ownerOf) {
    if (!teamsByPlayer.has(pid)) teamsByPlayer.set(pid, []);
    teamsByPlayer.get(pid).push(teamId);
  }
  for (const list of teamsByPlayer.values()) list.sort((a, b) => tierOf.get(a) - tierOf.get(b));

  const eliminated = eliminatedSet(matches, state.teamsFile);

  // Refresh module-level context so popup closures always read latest data.
  ctx = { standings, matches, teamMeta, tierOf, ownerOf, playerById, teamsByPlayer, eliminated };

  root.append(playerLeaguePanel(playerLeague, playerById, teamMeta, tierOf, ownerOf, prizes.player, teamsByPlayer, eliminated));
  root.append(filterBar(leagues, prizes.league));
  root.append(teamTable(leagues, teamMeta, tierOf, ownerOf, playerById, eliminated));
  root.append(el("p", { class: "footnote" },
    `${standings.size} teams · ${matches.filter((m) => m.status === "FINISHED").length} matches played · live from Supabase.`));
}

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

function teamTable(leagues, teamMeta, tierOf, ownerOf, playerById, eliminated) {
  const league = leagues[state.selectedLeague - 1];
  const head = ["Tr", "#", "Team", "Player", "P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Bns", "Total"];
  const thead = el("tr", {}, head.map((h, i) =>
    el("th", { class: i < 4 ? "l" : "", style: i === 3 ? { width: "100%" } : {} }, h)));
  const body = el("tbody");

  league.members.forEach((s, idx) => {
    const meta = teamMeta.get(s.teamId);
    const tier = tierOf.get(s.teamId);
    const player = playerById.get(ownerOf.get(s.teamId));
    const colour = playerColour(player);
    const isElim = eliminated.has(s.teamId);

    const teamSpan = el("span", {
      class: "team-cell", style: { cursor: "pointer" },
      onclick: (e) => showPopup(e, teamPopupContent(s.teamId)),
    }, el("span", { class: "flag" }, meta?.flag || ""), meta?.name || s.teamId);

    const tr = el("tr", { style: { borderLeft: `4px solid ${colour}`, opacity: isElim ? "0.45" : "1" } },
      el("td", { class: "l" }, el("span", { class: "tier-badge", style: { background: tierColour(tier) } }, String(tier))),
      el("td", { class: "l pos num" }, idx + 1),
      el("td", { class: "l" }, teamSpan),
      el("td", { class: "l owner", style: { color: colour, width: "100%" } }, ownerLabel(player)),
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

function playerNameCell(player) {
  if (!player) return "—";
  const sub = playerSubname(player);
  if (!sub) return player.name;
  return el("span", { style: { display: "inline-flex", flexDirection: "column", lineHeight: "1.15" } },
    el("span", { style: { fontWeight: "700" } }, player.name),
    el("span", { class: "muted", style: { fontSize: "0.72rem", fontWeight: "400" } }, sub));
}

function ownerLabel(player) {
  if (!player) return "—";
  const sub = playerSubname(player);
  if (!sub) return player.name;
  return el("span", {},
    player.name,
    el("span", { class: "muted", style: { fontSize: "0.72rem", fontWeight: "400", marginLeft: "6px" } }, sub));
}

function playerLeaguePanel(playerLeague, playerById, teamMeta, tierOf, ownerOf, prize, teamsByPlayer, eliminated) {
  const body = el("tbody");
  playerLeague.forEach((r, idx) => {
    const player = playerById.get(r.playerId);
    const colour = playerColour(player);

    const flags = (teamsByPlayer.get(r.playerId) || []).map((id) => {
      const isElim = eliminated.has(id);
      return el("span", {
        class: "mini-flag",
        title: `${teamMeta.get(id)?.name} · tier ${tierOf.get(id)}`,
        style: {
          borderBottom: `2px solid ${tierColour(tierOf.get(id))}`,
          opacity: isElim ? "0.35" : "1",
          filter: isElim ? "grayscale(0.8)" : "none",
          cursor: "pointer",
        },
        onclick: (e) => showPopup(e, teamPopupContent(id)),
      }, teamMeta.get(id)?.flag || "");
    });

    const tr = el("tr", { style: { borderLeft: `4px solid ${colour}` } },
      el("td", { class: "l pos num" }, idx + 1),
      el("td", {
        class: "l owner", style: { color: colour, cursor: "pointer" },
        onclick: (e) => showPopup(e, playerPopupContent(r.playerId)),
      }, playerNameCell(player)),
      el("td", { class: "l team-list" }, flags),
      el("td", { class: "num" }, r.played),
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

  const head = ["#", "Player", "Teams (by tier)", "P", "W", "D", "L", "GD", "Pts", "Bns", "Total"];
  return el("div", { class: "panel" },
    el("h2", {}, "Player league ",
      el("span", { class: "muted small" }, "— total across every team owned · winner takes ",
        el("span", { style: { color: "var(--gold)" } }, `£${prize}`))),
    el("div", { class: "table-scroll", style: { marginTop: "8px" } },
      el("table", { class: "board", style: { minWidth: "560px" } },
        el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i < 3 ? "l" : "" }, h)))),
        body)));
}

// results.js — the fixture & bracket page. Structure comes from the static
// data/wc2026_fixtures.json skeleton; live scores and resolved knockout teams
// overlay from the Supabase `matches` table, joined by match id. Works at every
// stage: before any sync it shows group fixtures with dashes and the knockout
// bracket as slot labels ("Winner Group A", "3rd C/E/F/H/I", "Winner of M73").
import { computeStandings, rankComparator } from "./engine.js";
import { onTableChange } from "./supabase.js";
import { $, el, fmtSigned, playerColour, playerSubname, loadLiveData, showError } from "./app.js";

const root = $("#content");
const state = { data: null, fixtures: null, teamsFile: null, view: "group" };

const GROUPS = "ABCDEFGHIJKL".split("");
const KO_ROUNDS = [
  ["LAST_32", "Round of 32"],
  ["LAST_16", "Round of 16"],
  ["QUARTER_FINALS", "Quarter-finals"],
  ["SEMI_FINALS", "Semi-finals"],
  ["THIRD_PLACE", "Third-place play-off"],
  ["FINAL", "Final"],
];

start();

async function start() {
  try {
    const [data, fixtures, teamsFile] = await Promise.all([
      loadLiveData(),
      fetch("data/wc2026_fixtures.json").then((r) => r.json()),
      fetch("data/wc2026_teams.json").then((r) => r.json()),
    ]);
    state.data = data;
    state.fixtures = fixtures;
    state.teamsFile = teamsFile;
  } catch (e) { showError(root, e); return; }
  render();
  const refresh = async () => { state.data = await loadLiveData(); render(); };
  onTableChange("matches", refresh);
  onTableChange("teams", refresh);
}

// ---- helpers ----
// Always show UK kick-off time. The whole tournament (11 Jun–19 Jul 2026) sits
// in British Summer Time, so we render in Europe/London and label it BST.
const fmtDate = (utc) => new Date(utc).toLocaleString("en-GB", {
  weekday: "short", day: "numeric", month: "short",
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
}) + " BST";

function canonicalMatches(matches) {
  return matches
    .filter((m) => m.status === "FINISHED" && m.home_score != null && m.away_score != null)
    .map((m) => ({
      id: m.id, stage: m.stage, home: m.home_team_id, away: m.away_team_id,
      homeScore: m.home_score, awayScore: m.away_score,
      type: m.match_type || "REGULAR",
      winner: m.winner || (m.home_score > m.away_score ? "HOME" : m.away_score > m.home_score ? "AWAY" : "DRAW"),
    }));
}

function render() {
  const { config, players, teams, matches } = state.data;
  const { groupStage, knockout } = state.fixtures;

  // Team metadata: static file is the always-present base; overlay DB owner/tier.
  const meta = new Map(state.teamsFile.teams.map((t) =>
    [t.id, { id: t.id, name: t.name, flag: t.flag, group: t.group, player_id: null, tier: null }]));
  for (const t of teams) {
    const m = meta.get(t.id) || { id: t.id, name: t.name, flag: t.flag };
    m.player_id = t.player_id; m.tier = t.tier;
    meta.set(t.id, m);
  }
  const playerById = new Map(players.map((p) => [p.id, p]));
  const dbById = new Map(matches.map((m) => [m.id, m]));

  // Group-stage points (drive the mini group tables; identical to sweepstake
  // points during the groups, where there are no knockout/penalty differences).
  const groupIds = new Set(groupStage.map((f) => f.id));
  const groupStandings = computeStandings(
    canonicalMatches(matches.filter((m) => groupIds.has(m.id))));

  const playedCount = matches.filter((m) => m.status === "FINISHED").length;

  root.innerHTML = "";
  root.append(intro(playedCount));
  root.append(viewToggle());
  if (state.view === "chrono") {
    // Tables first, then every group fixture in one chronological list.
    root.append(groupSection(groupStage, meta, playerById, dbById, groupStandings, false));
    root.append(chronoFixturesSection(groupStage, meta, playerById, dbById));
  } else {
    // Each group card carries its own fixtures (default).
    root.append(groupSection(groupStage, meta, playerById, dbById, groupStandings, true));
  }
  root.append(thirdPlaceSection(groupStage, meta, playerById, groupStandings));
  root.append(knockoutSection(knockout, meta, playerById, dbById));
}

function viewToggle() {
  const bar = el("div", { class: "btn-row", style: { margin: "0 0 14px" } });
  const mk = (label, v) => el("button", {
    class: "btn" + (state.view === v ? " active" : ""),
    onclick: () => { if (state.view !== v) { state.view = v; render(); } },
  }, label);
  bar.append(mk("Group view", "group"), mk("Chronological view", "chrono"),
    el("span", { class: "muted small", style: { marginLeft: "4px" } },
      state.view === "chrono" ? "fixtures below the tables, by date" : "fixtures grouped with their table"));
  return bar;
}

function intro(played) {
  return el("div", { class: "panel" },
    el("h2", {}, "Fixtures & bracket"),
    el("p", { class: "muted small", style: { margin: "0 0 6px" } },
      "Every group game and the full knockout bracket. Scores fill in automatically as results sync; ",
      "knockout slots resolve to real teams once each round is set. ",
      el("a", { href: "index.html" }, "Points & prize tables →")),
    el("p", { class: "small muted", style: { margin: 0 } },
      played
        ? `${played} match${played === 1 ? "" : "es"} played so far.`
        : "Kick-off 11 June — nothing played yet, so every score shows a dash."));
}

// ---- Group stage ----
function teamCell(id, meta, playerById, extra = {}) {
  const m = meta.get(id) || {};
  const owner = playerById.get(m.player_id);
  const colour = owner ? playerColour(owner) : "var(--text)";
  return el("span", { class: "team-cell", title: owner ? `${owner.name}'s pick` : "", ...extra },
    el("span", { class: "flag" }, m.flag || ""),
    el("span", { style: { color: colour, fontWeight: owner ? "600" : "400" } }, m.name || id));
}

// Sorted mini-standings rows for one group (blank stats for teams yet to play).
function groupRows(g, groupStage, groupStandings, meta) {
  const teamIds = [...new Set(groupStage.filter((f) => f.group === g)
    .flatMap((f) => [f.homeId, f.awayId]))];
  const blank = (id) => ({ teamId: id, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, matchPoints: 0, bonusPoints: 0, total: 0 });
  return teamIds.map((id) => groupStandings.get(id) || blank(id))
    .sort(rankComparator((id) => meta.get(id)?.name || id));
}

function groupSection(groupStage, meta, playerById, dbById, groupStandings, withFixtures) {
  const grid = el("div", { class: "cards", style: { gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))" } });

  for (const g of GROUPS) {
    const rows = groupRows(g, groupStage, groupStandings, meta);
    const card = el("div", { class: "panel", style: { margin: 0 } },
      el("h2", {}, `Group ${g}`),
      standingsTable(rows, meta, playerById));
    if (withFixtures) {
      const fixtures = groupStage.filter((f) => f.group === g)
        .sort((a, b) => a.utcDate.localeCompare(b.utcDate));
      card.append(el("div", { style: { marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" } },
        fixtures.map((f) => fixtureRow(f, meta, playerById, dbById))));
    }
    grid.append(card);
  }

  return el("div", {},
    el("h2", { style: { margin: "4px 2px 12px", fontSize: "1.05rem" } },
      withFixtures ? "Group stage" : "Group tables"),
    grid);
}

// Chronological view: all 72 group fixtures in one date-ordered list (each tagged
// with its group), rendered below the tables.
function chronoFixturesSection(groupStage, meta, playerById, dbById) {
  const fixtures = [...groupStage].sort((a, b) => a.utcDate.localeCompare(b.utcDate));
  const list = el("div", { style: { display: "flex", flexDirection: "column", gap: "6px", marginTop: "10px" } },
    fixtures.map((f) => fixtureRow(f, meta, playerById, dbById, f.group)));
  return el("div", { class: "panel" },
    el("h2", {}, "Group fixtures ", el("span", { class: "muted small" }, "— in kick-off order")),
    list);
}

// Tiny owner line under a team: gamertag + real name.
function ownerMini(id, meta, playerById) {
  const m = meta.get(id) || {};
  const owner = playerById.get(m.player_id);
  if (!owner) return null;
  const sub = playerSubname(owner);
  const tierPart = m.tier != null ? `T${m.tier}  ·  ` : "";
  return el("div", { class: "muted", style: { fontSize: "0.6rem", lineHeight: "1.1", marginTop: "1px" } },
    tierPart + owner.name + (sub ? ` · ${sub}` : ""));
}

function fixtureTeamCol(id, meta, playerById, align) {
  const mini = ownerMini(id, meta, playerById);
  return el("div", { style: { display: "flex", flexDirection: "column", alignItems: align === "right" ? "flex-end" : "flex-start" } },
    teamCell(id, meta, playerById),
    mini);
}

function standingsTable(rows, meta, playerById) {
  const head = ["#", "Team", "P", "GD", "Pts"];
  const body = el("tbody");
  rows.forEach((s, i) => {
    const top2 = i < 2;
    const tr = el("tr", {},
      el("td", { class: "l pos num" }, i + 1),
      el("td", { class: "l" }, el("div", { style: { display: "flex", flexDirection: "column" } },
        teamCell(s.teamId, meta, playerById),
        ownerMini(s.teamId, meta, playerById))),
      el("td", { class: "num" }, s.played),
      el("td", { class: "num" }, fmtSigned(s.gd)),
      el("td", { class: "total" }, s.total));
    if (top2) tr.style.color = "var(--text)";
    else tr.style.opacity = "0.72";
    body.append(tr);
  });
  return el("div", { class: "table-scroll", style: { borderRadius: "8px" } },
    el("table", { class: "board", style: { minWidth: "0", fontSize: "0.82rem" } },
      el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
      body));
}

function fixtureRow(f, meta, playerById, dbById, groupTag) {
  const db = dbById.get(f.id);
  const finished = db && db.status === "FINISHED" && db.home_score != null;
  const score = finished
    ? el("span", { class: "num", style: { fontWeight: "700", minWidth: "44px", textAlign: "center" } },
        `${db.home_score}–${db.away_score}`)
    : el("span", { class: "num muted", style: { minWidth: "44px", textAlign: "center" } }, "––");

  const groupPrefix = groupTag ? `Grp ${groupTag}  ·  ` : "";
  const penLine = finished && pen(db) ? `  ·  ${pen(db)}` : "";
  return el("div", {
    style: { display: "flex", flexDirection: "column", gap: "2px",
             padding: "5px 8px", background: "var(--bg-row)", borderRadius: "7px" },
  },
    el("div", {
      class: "small",
      style: { display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: "8px" },
    },
      fixtureTeamCol(f.homeId, meta, playerById, "right"),
      score,
      fixtureTeamCol(f.awayId, meta, playerById, "left")),
    el("div", { class: "muted", style: { fontSize: "0.66rem", textAlign: "center" } },
      groupPrefix + fmtDate(f.utcDate) + (finished ? "  ·  FT" : "") + penLine));
}

const pen = (db) => db.match_type === "PENALTIES" && db.pen_home != null
  ? `Pens ${db.pen_home}–${db.pen_away}` : db.match_type || "";

// ---- Best third-placed teams ----
// The eight best of the twelve third-placed teams join the Round of 32. Rank them
// across groups by the FIFA tie-break order (points, then goal difference, then
// goals for). Provisional until every group is complete.
function thirdPlaceSection(groupStage, meta, playerById, groupStandings) {
  const thirds = GROUPS
    .map((g) => ({ group: g, s: groupRows(g, groupStage, groupStandings, meta)[2] }))
    .filter((x) => x.s);

  thirds.sort((a, b) =>
    b.s.total - a.s.total || b.s.gd - a.s.gd || b.s.gf - a.s.gf ||
    String(meta.get(a.s.teamId)?.name || "").localeCompare(meta.get(b.s.teamId)?.name || ""));

  const body = el("tbody");
  thirds.forEach((t, i) => {
    const through = i < 8;
    const tr = el("tr", {},
      el("td", { class: "l pos num" }, i + 1),
      el("td", { class: "l num" }, t.group),
      el("td", { class: "l" }, el("div", { style: { display: "flex", flexDirection: "column" } },
        teamCell(t.s.teamId, meta, playerById),
        ownerMini(t.s.teamId, meta, playerById))),
      el("td", { class: "num" }, t.s.played),
      el("td", { class: "num" }, fmtSigned(t.s.gd)),
      el("td", { class: "total" }, t.s.total));
    tr.style.opacity = through ? "1" : "0.55";
    if (i === 7) tr.style.borderBottom = "2px solid var(--gold)"; // qualification cut-off
    body.append(tr);
  });

  return el("div", { class: "panel" },
    el("h2", {}, "Best third-placed teams ",
      el("span", { class: "muted small" }, "— top 8 reach the Round of 32")),
    el("p", { class: "muted small", style: { margin: "0 0 10px" } },
      "Each group's third-placed side, ranked across all twelve groups by points, then goal difference, then goals scored. ",
      "The eight above the gold line currently qualify. Provisional until the groups finish — and which Round-of-32 tie each one drops into depends on the exact set of groups that supply the eight (see the note under the bracket)."),
    el("div", { class: "table-scroll", style: { borderRadius: "8px" } },
      el("table", { class: "board", style: { fontSize: "0.85rem" } },
        el("thead", {}, el("tr", {}, ["#", "Grp", "Team", "P", "GD", "Pts"].map((h, i) =>
          el("th", { class: i < 3 ? "l" : "" }, h)))),
        body)));
}

// ---- Knockout bracket ----
function slotLabel(slot) {
  switch (slot.type) {
    case "winner": return { short: `1${slot.group}`, long: `Winner Group ${slot.group}` };
    case "runner": return { short: `2${slot.group}`, long: `Runner-up Group ${slot.group}` };
    case "third": return { short: "3rd", long: `3rd place · ${slot.groups.split("").join("/")}` };
    case "matchWinner": return { short: `W${slot.match}`, long: `Winner of Match ${slot.match}` };
    case "matchLoser": return { short: `L${slot.match}`, long: `Loser of Match ${slot.match}` };
    default: return { short: "?", long: "TBD" };
  }
}

function koSide(slot, teamId, meta, playerById) {
  if (teamId && meta.has(teamId)) {
    return el("div", { style: { padding: "2px 0" } }, teamCell(teamId, meta, playerById));
  }
  const { short, long } = slotLabel(slot);
  return el("div", { class: "small", style: { padding: "2px 0", display: "flex", alignItems: "center", gap: "7px" } },
    el("span", { class: "tier-badge", style: { background: "var(--line)", color: "var(--text-dim)" } }, short),
    el("span", { class: "muted" }, long));
}

function knockoutSection(knockout, meta, playerById, dbById) {
  const wrap = el("div", {},
    el("h2", { style: { margin: "18px 2px 4px", fontSize: "1.05rem" } }, "Knockout bracket"),
    el("p", { class: "muted small", style: { margin: "0 2px 12px", maxWidth: "640px" } },
      "A “3rd C/E/F/H/I”-style slot lists the groups it can be filled from. The eight qualifying third-placed teams are mapped onto these slots by FIFA's fixed assignment table, which keys off ",
      el("em", {}, "which"), " eight of the twelve groups they come from — so the exact Round-of-32 pairings can't be known until all twelve groups are complete."));

  for (const [stage, title] of KO_ROUNDS) {
    const matches = knockout.filter((m) => m.stage === stage).sort((a, b) => a.matchNo - b.matchNo);
    if (!matches.length) continue;
    const grid = el("div", { class: "cards", style: { gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" } });
    for (const m of matches) grid.append(koCard(m, meta, playerById, dbById));
    wrap.append(el("div", { class: "panel" },
      el("h2", {}, title, el("span", { class: "muted small" }, `  ·  ${matches.length} match${matches.length === 1 ? "" : "es"}`)),
      grid));
  }
  return wrap;
}

function koCard(m, meta, playerById, dbById) {
  const db = dbById.get(m.id);
  const finished = db && db.status === "FINISHED" && db.home_score != null;
  const homeId = db?.home_team_id, awayId = db?.away_team_id;

  const scoreLine = (id, slot) => {
    const sc = finished
      ? (id === homeId ? db.home_score : db.away_score)
      : null;
    return el("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: "8px" } },
      koSide(slot, id, meta, playerById),
      el("span", { class: finished ? "num total" : "num muted", style: { minWidth: "18px", textAlign: "right" } },
        finished ? String(sc) : "–"));
  };

  return el("div", { class: "winner-card", style: { borderLeftColor: finished ? "var(--gold)" : "var(--line)", padding: "10px 12px" } },
    el("div", { class: "lg", style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "6px" } },
      el("span", {}, `M${m.matchNo}`),
      el("span", { style: { fontSize: "0.66rem", whiteSpace: "nowrap" } }, fmtDate(m.utcDate))),
    el("div", { style: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px" } },
      scoreLine(homeId, m.home),
      scoreLine(awayId, m.away)),
    finished && pen(db) && db.match_type !== "REGULAR"
      ? el("div", { class: "small muted", style: { marginTop: "4px" } }, pen(db))
      : null);
}

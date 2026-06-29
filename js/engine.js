// engine.js — pure scoring + league logic shared by the demo and the live app.
// No DOM, no network. Everything in here is deterministic and unit-testable.

// ---- Points configuration (from the brief) ----
export const POINTS = {
  WIN: 3,     // win in 90 minutes
  DRAW: 1,    // draw in 90 minutes (also the draw that leads to ET or penalties)
  ET_WIN: 2,  // win in extra time
  ADVANCE: 2, // bonus for winning a knockout match (advancing the round)
};

// Knockout stages that count as "progressing a round" for the advancement bonus.
// Covers both the 2022 (32-team) and 2026 (48-team) bracket names.
// GROUP_STAGE and THIRD_PLACE are deliberately excluded — surviving the group is
// itself rewarded by reaching the first knockout round, and the 3rd-place playoff
// is not a progression.
export const ADVANCEMENT_STAGES = new Set([
  "LAST_32",        // 2026 round of 32
  "ROUND_OF_16",    // 2022 name
  "LAST_16",        // 2026 name
  "QUARTER_FINALS",
  "SEMI_FINALS",
  "FINAL",
]);

// Player colours — 6 maximally distinguishable slots (brief).
export const PLAYER_COLOURS = [
  "#E63946", // 1 crimson
  "#457B9D", // 2 ocean blue
  "#2D6A4F", // 3 forest green
  "#E9C46A", // 4 amber
  "#7B2D8B", // 5 purple
  "#F4845F", // 6 coral
];

// Prize structure. Each player's stake is allocated per-league plus a slice to
// the overall player league; the prize for winning is that slice × n_players.
// For the standard 6-player / 8-league setup: £5×8 + £10 = £50 stake, paying
// £30 per league and £60 to the player-league winner (£240 + £60 = £300 pot).
export const PRIZES = {
  per_league_per_player: 5,    // £ each player contributes to every team-league
  player_league_per_player: 10, // £ each player contributes to the player league
};
export const leaguePrize = (nPlayers) => PRIZES.per_league_per_player * nPlayers;
export const playerLeaguePrize = (nPlayers) => PRIZES.player_league_per_player * nPlayers;
export const stakePerPlayer = (nLeagues) =>
  PRIZES.per_league_per_player * nLeagues + PRIZES.player_league_per_player;

// Tier colours — used in the demo (colour-per-tier, not per-player).
export const TIER_COLOURS = {
  1: "#E9A23B", // warm amber
  2: "#3FA7A0", // muted teal
  3: "#9B8CCB", // soft lavender
  4: "#5C6BC0", // slate blue
  5: "#C9A227", // gold (premium)
};

export function tierColour(tier) {
  return TIER_COLOURS[tier] || "#888";
}

// ---- Core: turn a list of finished matches into per-team standings ----
//
// match shape (our canonical form, used by both demo JSON and the live sync):
//   { id, stage, home, away, homeScore, awayScore,
//     type: "REGULAR" | "EXTRA_TIME" | "PENALTIES",
//     winner: "HOME" | "AWAY" | "DRAW",
//     penHome?, penAway? }   // only for PENALTIES
//
// homeScore/awayScore are the scoreline at the point the result was settled in
// play (90 or 120 min). Shootout goals are never counted in GF/GA.
//
// Returns: Map<teamId, stats> where stats =
//   { teamId, played, w, d, l, gf, ga, gd, matchPoints, bonusPoints, total }
export function computeStandings(matches) {
  const table = new Map();

  const ensure = (id) => {
    if (!table.has(id)) {
      table.set(id, {
        teamId: id, played: 0, w: 0, d: 0, l: 0,
        gf: 0, ga: 0, gd: 0,
        matchPoints: 0, bonusPoints: 0, total: 0,
      });
    }
    return table.get(id);
  };

  for (const m of matches) {
    const home = ensure(m.home);
    const away = ensure(m.away);

    // Goals (always the in-play score, never shootout).
    home.gf += m.homeScore; home.ga += m.awayScore;
    away.gf += m.awayScore; away.ga += m.homeScore;
    home.played += 1; away.played += 1;

    // Match points + W/D/L record.
    if (m.type === "PENALTIES") {
      // Drawn after 90 + 30 min; both get the draw point. Winner advances via
      // the ADVANCE bonus below — no extra match points for the shootout.
      home.d += 1; away.d += 1;
      home.matchPoints += POINTS.DRAW; away.matchPoints += POINTS.DRAW;
    } else if (m.type === "EXTRA_TIME") {
      // Settled in extra time. Winner records a win; loser records a loss but
      // keeps the consolation draw point for having drawn in 90 minutes.
      const winner = m.winner === "HOME" ? home : away;
      const loser = m.winner === "HOME" ? away : home;
      winner.w += 1; loser.l += 1;
      winner.matchPoints += POINTS.ET_WIN;
      loser.matchPoints += POINTS.DRAW;
    } else { // REGULAR
      if (m.winner === "DRAW") {
        home.d += 1; away.d += 1;
        home.matchPoints += POINTS.DRAW; away.matchPoints += POINTS.DRAW;
      } else {
        const winner = m.winner === "HOME" ? home : away;
        const loser = m.winner === "HOME" ? away : home;
        winner.w += 1; loser.l += 1;
        winner.matchPoints += POINTS.WIN;
      }
    }

    // Advancement bonus: only the winner of a knockout match earns +ADVANCE,
    // awarded immediately (not deferred to when they play the next round).
    if (ADVANCEMENT_STAGES.has(m.stage) && m.winner !== "DRAW") {
      const advWinner = m.winner === "HOME" ? home : away;
      advWinner.bonusPoints += POINTS.ADVANCE;
    }
  }

  // Finalise totals + GD.
  for (const [, s] of table) {
    s.gd = s.gf - s.ga;
    s.total = s.matchPoints + s.bonusPoints;
  }

  return table;
}

// Ranking comparator: total desc, GD desc, GF desc, then name for stability.
export function rankComparator(getName = () => "") {
  return (a, b) =>
    b.total - a.total ||
    b.gd - a.gd ||
    b.gf - a.gf ||
    String(getName(a.teamId)).localeCompare(String(getName(b.teamId)));
}

// ---- Subsumptive leagues ----
//
// Because players draft FOR THEMSELVES, round 1 (Tier 1) is where the strongest
// teams go and the last round (highest tier) collects the weakest. League
// membership is "tier >= L", so:
//   League 1     = every team (the grand league; usually won by the best team)
//   League 2     = everyone except the Tier-1 (top-seed) teams
//   ...
//   League nRounds = only the highest-tier (weakest-seeded) teams
// Each higher league strips out the top tier of seeds, so the exclusive lower
// leagues are "underdog leagues": a low-seeded team that goes deep appears in
// many leagues and can sweep several prize pots.
//
// teams: [{ teamId, tier, ... }]
// standings: Map<teamId, stats>
// returns: [{ league, members: [stats...], winnerId }] for league 1..nRounds
export function computeLeagues(teams, standings, nRounds, getName = () => "") {
  const tierOf = new Map(teams.map((t) => [t.teamId, t.tier]));
  const cmp = rankComparator(getName);
  const leagues = [];

  for (let L = 1; L <= nRounds; L++) {
    const members = teams
      .filter((t) => tierOf.get(t.teamId) >= L)
      .map((t) => standings.get(t.teamId))
      .filter(Boolean)
      .sort(cmp);
    leagues.push({
      league: L,
      members,
      winnerId: members.length ? members[0].teamId : null,
    });
  }
  return leagues;
}

// ---- Per-player league ----
// Ranks players by the summed total of every team they own.
//
// ownerOf:   Map<teamId, playerId>
// standings: Map<teamId, stats>
// returns:   [{ playerId, teams, played, w, d, l, gf, ga, gd,
//               matchPoints, bonusPoints, total }] sorted best-first
export function computePlayerLeague(ownerOf, standings) {
  const rows = new Map();
  const blank = (playerId) => ({
    playerId, teams: 0, played: 0, w: 0, d: 0, l: 0,
    gf: 0, ga: 0, gd: 0, matchPoints: 0, bonusPoints: 0, total: 0,
  });

  for (const [teamId, s] of standings) {
    const pid = ownerOf.get(teamId);
    if (pid === undefined || pid === null) continue;
    if (!rows.has(pid)) rows.set(pid, blank(pid));
    const r = rows.get(pid);
    r.teams += 1; r.played += s.played; r.w += s.w; r.d += s.d; r.l += s.l;
    r.gf += s.gf; r.ga += s.ga;
    r.matchPoints += s.matchPoints; r.bonusPoints += s.bonusPoints; r.total += s.total;
  }
  for (const r of rows.values()) r.gd = r.gf - r.ga;
  return [...rows.values()].sort(
    (a, b) => b.total - a.total || b.gd - a.gd || b.gf - a.gf
  );
}

// ---- Draft order: cyclic rotation (a Latin square) ----
// Each round the order shifts one seat: round r, pick p -> player (r + p) % N.
//   R1: 0 1 2 3 4 5
//   R2: 1 2 3 4 5 0
//   R3: 2 3 4 5 0 1  ...
// Over N rounds every player picks in every position exactly once, everyone
// leads a tier once, and the last picker of a round is never the first of the
// next (no back-to-back boundary control). Returns a flat array, one player
// index per pick, length nPlayers * nRounds.
export function draftOrder(nPlayers, nRounds) {
  const order = [];
  for (let r = 0; r < nRounds; r++) {
    for (let p = 0; p < nPlayers; p++) order.push((r + p) % nPlayers);
  }
  return order;
}

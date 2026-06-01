// demo.js — 2022 World Cup replay. Loads the static results, runs a deterministic
// tier assignment + the shared scoring engine, and renders the subsumptive tables.
import {
  computeStandings, computeLeagues, computePlayerLeague, draftOrder, tierColour,
  leaguePrize, playerLeaguePrize,
} from "./engine.js";

const N_PLAYERS = 6;
const N_TIERS = 5;
const LEAGUE_PRIZE = leaguePrize(N_PLAYERS);              // £30 (£5 × 6)
const PLAYER_LEAGUE_PRIZE = playerLeaguePrize(N_PLAYERS); // £60 (£10 × 6)

// Fictional owners (demo only; real app uses real player names + colours).
const FICTIONAL = ["Alex", "Bailey", "Casey", "Devin", "Erin", "Frankie"];

const state = { selectedLeague: 1 }; // default: League 1 = all teams (the grand league)

init();

async function init() {
  const res = await fetch("data/wc2022_results.json");
  if (!res.ok) throw new Error("Could not load 2022 data: " + res.status);
  const data = await res.json();

  const nameOf = new Map(data.teams.map((t) => [t.id, t.name]));
  const teamMeta = new Map(data.teams.map((t) => [t.id, t]));
  const getName = (id) => nameOf.get(id);

  // --- Deterministic "draft": players pick FOR THEMSELVES, so the strongest
  // teams go in round 1 (Tier 1) and the weakest end up in the last tier.
  // Drop the 2 weakest to land on 30, sort strongest -> weakest, six per tier.
  const pool = [...data.teams]
    .sort((a, b) => a.fifaRank - b.fifaRank) // strongest (lowest rank number) first
    .slice(0, -2);                           // drop the two weakest to land on 30
  const teams = pool.map((t, i) => ({
    teamId: t.id,
    tier: Math.floor(i / N_PLAYERS) + 1,     // Tier 1 = strongest seeds
    pickIndex: i,
  }));
  const tierOf = new Map(teams.map((t) => [t.teamId, t.tier]));

  // Assign each team to a fictional owner via the cyclic-rotation draft order
  // (one team per tier per player).
  const order = draftOrder(N_PLAYERS, N_TIERS);
  const ownerOf = new Map();
  teams.forEach((t, i) => ownerOf.set(t.teamId, order[i]));

  // --- Score it ---
  const standings = computeStandings(data.matches);
  const leagues = computeLeagues(teams, standings, N_TIERS, getName);
  const playerLeague = computePlayerLeague(ownerOf, standings);

  renderLegend();
  renderPlayerLeague(playerLeague, ownerOf, teamMeta, tierOf);
  renderWinnerCards(leagues, teamMeta, ownerOf, tierOf);
  renderFilterBar(leagues);
  renderTable(teams, standings, leagues, teamMeta, ownerOf, getName);

  // How-it-works toggle
  const howBtn = document.getElementById("howBtn");
  const howto = document.getElementById("howto");
  howBtn.addEventListener("click", () => {
    howto.classList.toggle("open");
    howBtn.textContent = howto.classList.contains("open") ? "How it works ▴" : "How it works ▾";
  });

  document.getElementById("footnote").textContent =
    `${data.tournament} · ${data.matches.length} matches · ${teams.length} teams drafted across ${N_TIERS} tiers. ` +
    `Argentina (a top seed) wins League 1; Morocco — a Tier-4 underdog — sweeps the exclusive lower leagues.`;

  // expose for re-render on filter change
  state.rerender = () =>
    renderTable(teams, standings, leagues, teamMeta, ownerOf, getName);
}

function renderPlayerLeague(playerLeague, ownerOf, teamMeta, tierOf) {
  const body = document.getElementById("playerBody");
  if (!body) return;
  body.innerHTML = "";

  // teams owned by each player, ordered by tier, for the breakdown column
  const teamsByPlayer = new Map();
  for (const [teamId, pid] of ownerOf) {
    if (!teamsByPlayer.has(pid)) teamsByPlayer.set(pid, []);
    teamsByPlayer.get(pid).push(teamId);
  }
  for (const list of teamsByPlayer.values()) {
    list.sort((a, b) => tierOf.get(a) - tierOf.get(b));
  }

  playerLeague.forEach((r, idx) => {
    const owned = (teamsByPlayer.get(r.playerId) || [])
      .map((id) => {
        const t = tierOf.get(id);
        return `<span class="mini-flag" title="${teamMeta.get(id).name} · tier ${t}"
          style="border-bottom:2px solid ${tierColour(t)}">${teamMeta.get(id).flag}</span>`;
      })
      .join(" ");
    const tr = document.createElement("tr");
    if (idx === 0) tr.classList.add("is-winner");
    tr.innerHTML = `
      <td class="l pos num">${idx + 1}</td>
      <td class="l owner">${FICTIONAL[r.playerId]}</td>
      <td class="l team-list">${owned}</td>
      <td class="num">${r.w}</td>
      <td class="num">${r.d}</td>
      <td class="num">${r.l}</td>
      <td class="num">${r.gd >= 0 ? "+" : ""}${r.gd}</td>
      <td class="num">${r.matchPoints}</td>
      <td class="bonus">+${r.bonusPoints}</td>
      <td class="total">${r.total}</td>`;
    body.appendChild(tr);
  });
}

function renderLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = "";
  const labels = { 1: "Tier 1 (top seeds)", 2: "Tier 2", 3: "Tier 3", 4: "Tier 4", 5: "Tier 5 (lowest seeds)" };
  for (let t = 1; t <= N_TIERS; t++) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span class="dot" style="background:${tierColour(t)}"></span>${labels[t]}`;
    el.appendChild(chip);
  }
}

function renderWinnerCards(leagues, teamMeta, ownerOf, tierOf) {
  const el = document.getElementById("winnerCards");
  el.innerHTML = "";
  for (const lg of leagues) {
    const meta = teamMeta.get(lg.winnerId);
    const tier = tierOf.get(lg.winnerId);
    const card = document.createElement("div");
    card.className = "winner-card";
    card.style.borderLeftColor = tierColour(tier);
    card.innerHTML = `
      <div class="lg">League ${lg.league} · ${lg.members.length} teams</div>
      <div class="team">${meta.flag} ${meta.name}</div>
      <div class="small muted">owner: ${FICTIONAL[ownerOf.get(lg.winnerId)]} · tier ${tier}</div>
      <div class="prize">£${LEAGUE_PRIZE}</div>`;
    el.appendChild(card);
  }
}

function renderFilterBar(leagues) {
  const bar = document.getElementById("filterBar");
  bar.innerHTML = "";
  const make = (label, value, title) => {
    const b = document.createElement("button");
    b.className = "btn" + (value === state.selectedLeague ? " active" : "");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", () => {
      state.selectedLeague = value;
      [...bar.children].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      state.rerender();
    });
    return b;
  };
  for (const lg of leagues) {
    const label = lg.league === 1 ? "League 1 · All" : `League ${lg.league}`;
    bar.appendChild(make(
      label, lg.league,
      `Teams of tier ≥ ${lg.league} (${lg.members.length} teams)`
    ));
  }
  const hint = document.createElement("span");
  hint.className = "muted small";
  hint.style.marginLeft = "6px";
  hint.textContent = "← pick a league to re-rank";
  bar.appendChild(hint);
}

function renderTable(teams, standings, leagues, teamMeta, ownerOf, getName) {
  const L = state.selectedLeague;
  const league = leagues[L - 1];
  const memberIds = new Set(league.members.map((m) => m.teamId));
  const winnerId = league.winnerId;

  // Order rows by the selected league's ranking; teams not in this league are hidden.
  const rows = [...league.members];
  const body = document.getElementById("tableBody");
  body.innerHTML = "";

  rows.forEach((s, idx) => {
    const meta = teamMeta.get(s.teamId);
    const tier = teams.find((t) => t.teamId === s.teamId).tier;
    const tr = document.createElement("tr");
    if (s.teamId === winnerId) tr.classList.add("is-winner");
    tr.innerHTML = `
      <td class="l"><span class="tier-badge" style="background:${tierColour(tier)}">${tier}</span></td>
      <td class="l pos num">${idx + 1}</td>
      <td class="l"><span class="team-cell"><span class="flag">${meta.flag}</span>${meta.name}</span></td>
      <td class="l owner">${FICTIONAL[ownerOf.get(s.teamId)]}</td>
      <td class="num">${s.played}</td>
      <td class="num">${s.w}</td>
      <td class="num">${s.d}</td>
      <td class="num">${s.l}</td>
      <td class="num">${s.gf}</td>
      <td class="num">${s.ga}</td>
      <td class="num">${s.gd >= 0 ? "+" : ""}${s.gd}</td>
      <td class="num">${s.matchPoints}</td>
      <td class="bonus">+${s.bonusPoints}</td>
      <td class="total">${s.total}</td>`;
    body.appendChild(tr);
  });
}

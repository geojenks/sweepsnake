// commentary.mjs — generate a pundit/commentator-style write-up of the last
// completed "game day" and append it to data/commentary.json. Runs in GitHub
// Actions (Node 18+, global fetch — no npm dependencies).
//
// A "game day" is a US-night session, not a UK calendar day: World Cup 2026
// kicks off run ~20:00–07:00 UK, so a day's results "complete" around breakfast.
// We bucket every match by the London date of (kickoff − 9h), so an overnight
// session (e.g. 21:00 BST → 03:00 BST) lands under a single key.
//
// We don't write a day on a fixed clock — we POLL. A day is "ready" the moment
// every fixture in its bucket has actually finished (none still SCHEDULED / live).
// The workflow runs this every half-hour through the morning; the first poll
// after the night's last whistle writes it, the rest are cheap no-ops.
//
// The witty prose is written by Claude (claude-opus-4-8) — it can't be templated.
// Required secret: ANTHROPIC_API_KEY.
// Optional: SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY
//           (default to the public anon values from js/config.js)
//           DAYS=all  — backfill every uncovered closed day (default: latest only)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeStandings, computeLeagues, computePlayerLeague } from "../js/engine.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// ---- config ----
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) { console.error("ANTHROPIC_API_KEY is not set"); process.exit(1); }

const MODEL = process.env.COMMENTARY_MODEL || "claude-opus-4-8";

const DEFAULT_URL  = "https://tkbkeqtywttaasyutmsj.supabase.co";
const DEFAULT_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtlcXR5d3R0YWFzeXV0bXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMTU4NjksImV4cCI6MjA5NTg5MTg2OX0.begyj0OQidbXTl-3bdjjHUcud4xjpeKt8AWXQnSiZ2A";
const SB_URL = (process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_ANON;

// ---- static data ----
const teamsFile = JSON.parse(readFileSync(join(ROOT, "data/wc2026_teams.json"), "utf8"));
const draftFile = JSON.parse(readFileSync(join(ROOT, "data/draft-picks.json"), "utf8"));

// team_id -> { name, flag, group }
const team = new Map(teamsFile.teams.map((t) => [String(t.id), { name: t.name, flag: t.flag || "", group: t.group || "?" }]));

// real names behind the gamertags (mirrors SUBNAMES in js/app.js)
const SUBNAMES = {
  seandonpickford: "Sean", straitofhormousadembele: "Joe", thomastwoshell: "Geo",
  nicoolgilly: "Pete", kluiverteye: "Logan", storyoftheharrykane: "Barney",
};
const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// team_id -> { handle, name (real), tier }
const owner = new Map();
for (const p of draftFile.picks) {
  owner.set(String(p.team_id), {
    handle: p.player,
    name: SUBNAMES[normName(p.player)] || p.player,
    tier: p.tier,
  });
}

// sweepstake-engine helpers
const ownerOf = new Map(draftFile.picks.map((p) => [String(p.team_id), p.player_id]));
const pidName = new Map((draftFile.players || []).map((p) => [p.id, SUBNAMES[normName(p.name)] || p.name]));
const pidToName = (pid) => pidName.get(pid) || "Unowned";
const teamsArr = draftFile.picks.map((p) => ({ teamId: String(p.team_id), tier: p.tier }));
const N_ROUNDS = Number(draftFile.n_rounds) || 8;
const nameOf = (id) => team.get(id)?.name || id;

const toEngineMatch = (m) => ({
  id: m.id, stage: m.stage,
  home: m.home_team_id, away: m.away_team_id,
  homeScore: m.home_score, awayScore: m.away_score,
  type: m.match_type || "REGULAR", winner: m.winner,
  penHome: m.pen_home, penAway: m.pen_away,
});

// Full sweepstake picture from a set of finished matches.
function sweepTables(subset) {
  const standings = computeStandings(subset.map(toEngineMatch));
  return {
    leagues: computeLeagues(teamsArr, standings, N_ROUNDS, nameOf),
    player: computePlayerLeague(ownerOf, standings),
  };
}

// What the night changed: player league + the 8 tiered team-leagues, before vs now.
function sweepContext(before, after) {
  const b = sweepTables(before);
  const a = sweepTables(after);

  const bRank = new Map(b.player.map((r, i) => [r.playerId, { rank: i + 1, total: r.total }]));
  const playerLeague = a.player.map((r, i) => ({
    player: pidToName(r.playerId),
    points: r.total,
    pointsComingIn: bRank.get(r.playerId)?.total ?? 0,
    gainedTonight: r.total - (bRank.get(r.playerId)?.total ?? 0),
    rankNow: i + 1,
    rankComingIn: bRank.get(r.playerId)?.rank ?? null,
  }));

  const teamLeagues = a.leagues.map((lg) => {
    const prev = b.leagues.find((x) => x.league === lg.league);
    return {
      league: lg.league,
      blurb: lg.league === 1 ? "the grand league — every team; usually led by the best team"
            : lg.league === N_ROUNDS ? "underdog league — only the lowest seeds" : "drops the top seeds tier by tier",
      leaderNow: lg.winnerId ? nameOf(lg.winnerId) : null,
      leaderNowOwner: lg.winnerId ? pidToName(ownerOf.get(lg.winnerId)) : null,
      leaderComingIn: prev?.winnerId ? nameOf(prev.winnerId) : null,
      leaderChanged: (prev?.winnerId || null) !== (lg.winnerId || null),
      topNow: lg.members.slice(0, 3).map((s) => ({ team: nameOf(s.teamId), owner: pidToName(ownerOf.get(s.teamId)), points: s.total })),
    };
  });

  return {
    note: "These are SWEEPSTAKE points, NOT match scorelines: win 3, draw 1, extra-time win 2, shootout win +3 on top of the draw point, +2 per knockout round reached. 'comingIn' = standings BEFORE tonight's games; 'now' = after them. The PLAYER league (a £60 prize to the winner) ranks each of the six friends by the summed points of all their teams. The tiered TEAM-leagues rank individual teams; each one pays its winner £30. Every league pays out — nine cash prizes in all.",
    playerLeague,
    teamLeagues,
  };
}

// ---- game-day bucketing ----
// London date of (kickoff − 9h): groups a US-evening session under one key and
// rolls the boundary at 09:00 London.
const ymd = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(date);
const gameDayKey = (utcISO) => ymd(new Date(new Date(utcISO).getTime() - 9 * 3600 * 1000));

const dayLabel = (key) => {
  const d = new Date(`${key}T12:00:00Z`);
  return "Night of " + new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London",
  }).format(d);
};

// ---- football points (real qualification context, distinct from sweep scoring) ----
function record(matchesForTeam, teamId) {
  let p = 0, w = 0, d = 0, l = 0, gf = 0, ga = 0;
  for (const m of matchesForTeam) {
    const home = m.home_team_id === teamId;
    const us = home ? m.home_score : m.away_score;
    const them = home ? m.away_score : m.home_score;
    p++; gf += us; ga += them;
    if (us > them) w++; else if (us < them) l++; else d++;
  }
  return { p, w, d, l, gf, ga, gd: gf - ga, pts: w * 3 + d };
}

// ---- Supabase ----
// Fetch ALL matches (every status) so we can tell when a game-day bucket is fully
// settled, not just the finished ones.
async function fetchMatches() {
  const base = "id,home_team_id,away_team_id,home_score,away_score,winner,match_type,pen_home,pen_away,stage,matchday,utc_date,status";
  // half_time_* may not exist yet (migration pending) — fall back without them.
  for (const cols of [`${base},half_time_home,half_time_away`, base]) {
    const res = await fetch(`${SB_URL}/rest/v1/matches?select=${cols}&order=utc_date.asc`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (/half_time/.test(text)) continue; // retry without half-time columns
    console.error("Supabase error:", text); process.exit(1);
  }
}

// A match counts as DONE (result locked in) or as BLOCKING (the bucket can't be
// written until it resolves). Postponed/cancelled/suspended games block nothing.
const DONE_STATUS = new Set(["FINISHED", "AWARDED"]);
const BLOCKING_STATUS = new Set(["SCHEDULED", "TIMED", "IN_PLAY", "PAUSED"]);

// ---- BBC headlines (rare real-world flavour) ----
// A handful of current headlines the writer MAY — sparingly — riff on when one is
// genuinely huge or deliciously absurd (see the prompt's high bar). Non-fatal:
// returns [] on any error, and is only fetched when we're actually generating.
const decodeXml = (s) => s
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
async function fetchBigNews() {
  const feeds = [
    ["top", "https://feeds.bbci.co.uk/news/rss.xml"],
    ["showbiz", "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"],
  ];
  const out = [];
  for (const [section, url] of feeds) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "sweepsnake-commentary/1.0" } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const it of xml.split(/<item>/).slice(1, 11)) {
        const m = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        if (m) out.push({ section, headline: decodeXml(m[1]) });
      }
    } catch { /* news is optional flavour — ignore failures */ }
  }
  return out.slice(0, 16);
}

// ---- ESPN match events (real minute-by-minute timeline) ----
// football-data's free tier gives no in-game detail, but ESPN's public, key-less
// soccer API does: goals (minute + scorer + assist), penalties scored/missed/saved,
// own goals and red cards. We match ESPN fixtures to ours by date + the pair of
// team names, then distil each match's "keyEvents" into the moments worth narrating.
// Entirely best-effort: any failure leaves a match with no events (the writer then
// falls back to the scoreline), so this can never break the daily job.
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const stripAccents = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const normTeam = (s) => stripAccents(s).toLowerCase().replace(/[^a-z]/g, "");
// ESPN spellings that differ from ours, collapsed to a shared token.
const TEAM_ALIAS = { turkiye: "turkey", capeverde: "capeverdeislands" };
const canonTeam = (s) => { const n = normTeam(s); return TEAM_ALIAS[n] || n; };
const pairKey = (a, b) => [canonTeam(a), canonTeam(b)].sort().join("__");
const ymdUTC = (iso) => { const d = new Date(iso); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`; };

async function espnJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "sweepsnake-commentary/1.0" } });
  if (!r.ok) throw new Error(`espn ${r.status}`);
  return r.json();
}

// Map an ESPN keyEvent type to a concise kind we care about (null = ignore: subs,
// throw-ins, drinks breaks, yellow cards, kickoffs, half-time markers, etc.).
function eventKind(t) {
  switch (t) {
    case "Red Card": case "VAR - (Red) Card Upgrade": return { kind: "red card" };
    case "Penalty - Missed": return { kind: "penalty missed" };
    case "Penalty - Saved": return { kind: "penalty saved" };
    case "Penalty - Scored": return { kind: "penalty scored", goal: true };
    case "Own Goal": return { kind: "own goal", goal: true, og: true };
    case "Goal - Header": return { kind: "header", goal: true };
    case "Goal - Volley": return { kind: "volley", goal: true };
    case "Goal - Free-kick": return { kind: "free-kick", goal: true };
    case "Goal": return { kind: "goal", goal: true };
    default: return null;
  }
}

function distillEvents(keyEvents) {
  const out = [];
  for (const k of keyEvents || []) {
    const c = eventKind(k.type?.text);
    if (!c) continue;
    const players = (k.participants || []).map((p) => p.athlete?.displayName).filter(Boolean);
    out.push({
      minute: k.clock?.displayValue || "",
      team: k.team?.displayName || null,
      kind: c.kind,
      player: players[0] || null,
      ...(c.goal && !c.og && players[1] ? { assist: players[1] } : {}),
    });
  }
  return out;
}

// matchId -> distilled events[], for the matches in one game-day bucket.
async function fetchEvents(dayMatches) {
  const byId = new Map();
  try {
    // ESPN files a fixture under its UTC date; check that date and the one before
    // to cover late-night kickoffs that straddle the boundary.
    const dates = new Set();
    for (const m of dayMatches) {
      dates.add(ymdUTC(m.utc_date));
      dates.add(ymdUTC(new Date(new Date(m.utc_date).getTime() - 86400000)));
    }
    const idx = new Map(); // pairKey -> ESPN event id
    for (const dt of dates) {
      try {
        const j = await espnJson(`${ESPN_BASE}/scoreboard?dates=${dt}`);
        for (const e of j.events || []) {
          const cs = e.competitions?.[0]?.competitors || [];
          if (cs.length >= 2) idx.set(pairKey(cs[0].team?.displayName, cs[1].team?.displayName), e.id);
        }
      } catch { /* skip a bad date */ }
    }
    for (const m of dayMatches) {
      const eid = idx.get(pairKey(nameOf(m.home_team_id), nameOf(m.away_team_id)));
      if (!eid) continue;
      try {
        const j = await espnJson(`${ESPN_BASE}/summary?event=${eid}`);
        const ev = distillEvents(j.keyEvents);
        if (ev.length) byId.set(String(m.id), ev);
      } catch { /* skip a match we can't detail */ }
    }
  } catch { /* events are optional colour — never fatal */ }
  return byId;
}

// ---- Anthropic ----
const SYSTEM = `You are the resident pundit for a private World Cup 2026 sweepstake among six friends. You write a daily commentator round-up in the voice of the long-running "LPS" (Last Person Standing) emails — a style made famous by Joe, one of the six: long, dramatic, gleefully overwrought sentences; mock-grandiose; biblical and literary asides; stadium-name and pop-culture gags; affectionate but savage roasting of the players; near-fatal-heart-attack hyperbole; British spelling; the occasional well-placed swear word (this is a private group — no sanitising).

VOICE — THIRD PERSON ONLY: you are a detached commentator, never a participant. Narrate all six friends — Sean, Joe, Geo, Pete, Logan, Barney — in the third person, by name. Never write "I", "me", "my", "yours truly", "your humble narrator" or similar; never address the reader as "you"; never speak as though you own or drafted any team. Joe is simply one of the six players and is narrated exactly like the others.

THE ONE NON-NEGOTIABLE CRAFT RULE: every result must be played up on TWO levels at once — what it means for the actual country/team (qualification, glory, humiliation, the knockouts), AND what it means for the real FRIEND who drafted that team (named: Sean, Joe, Geo, Pete, Logan, Barney). Lean into coincidences: one player owning both teams in a match, a player whose teams all flopped, a heroic-but-pointless win that helps nobody, etc.

WHO'S WHO (use for needle and running jokes, but never invent results): the six players are Sean, Joe, Geo, Pete, Logan, Barney — and ONLY these six are friends in this group; never imply anyone else is one of them. Joe and Geo, and ONLY Joe and Geo, happen to be brothers in real life — no other player has any relative in this group. Treat the Joe–Geo link as rare, occasional colour, NOT a recurring theme: only reach for it on a night when their teams actually meet head-to-head or go directly toe-to-toe at the top of a table, and even then keep it light — most write-ups should not mention it at all. HARD RULE on the words "brother"/"sibling"/"fratricide"/"Cain"/"Abel": use them ONLY for the Joe-and-Geo pair, never for any other player, never to describe a single player's night on their own (e.g. NOT "a night Logan shared with his sibling"), and never as a stray biblical flourish about unrelated people.

THE GAMERTAG PUNS (a rich seam for running gags — deploy with a light touch, never all six in one night, and never explain the joke): each player's handle is a hidden pun you can riff on—
- Sean = "SeanDonPickford" → the England goalkeeper Jordan Pickford. Fair game to mock — dodgy distribution, flap at a corner, whatever the night invites.
- Joe = "StraitOfHorMousaDembele" → the Strait of Hormuz spliced with the footballer Mousa Dembélé. Real-world news of the Strait being blocked/closed is the jackpot gag (see REAL-WORLD NEWS).
- Geo = "ThomasTwoShell" → a double pun: the manager Thomas Tuchel (touchline scowls, tactical pronouncements, Germanic gravitas) AND TwoShell, the London electronic-music duo (leftfield club edits, hyperpop mischief, anonymity) — riff on whichever fits the night.
- Pete = "NicOOlGilly" → Manchester City's Nico O'Reilly, and/or Old Gil (Gil Gunderson), the perpetually luckless flop from The Simpsons — lean into hard-luck-Gil energy when Pete is losing.
- Logan = "KluivertEye" → Patrick Kluivert crossed with Private Eye, the satirical magazine (conspiracies, exposés, a knowing wink).
- Barney = "StoryOfTheHarryKane" → Bob Dylan's "Hurricane" ("Here comes the story of…") welded to Harry Kane.
These are flavour and callbacks, not obligations — wear them lightly and only when they actually land.

THE SWEEPSTAKE STANDINGS: the data includes a "sweepstakeLeagues" block — the league picture BEFORE tonight ("comingIn") versus AFTER ("now"). There are two kinds of league, both in SWEEPSTAKE points (a different scoring system from the match scoreline — read the note): (a) one overall PLAYER league, which pays the winner £60, ranking the six friends by the summed points of all their teams; (b) eight tiered TEAM-leagues, EACH of which pays its winner £30 (League 1 = every team, usually led by the best side; higher-numbered leagues strip out the top seeds, so they're underdog leagues). EVERY league pays out — nine cash prizes in total. The £60 player league is the headline pot, but the £30 team-leagues are real money too: NEVER call the player league "the only league that pays" or imply the tiered leagues are just for pride. WHEN — AND ONLY WHEN — the night materially moved a table, work it in: a new league leader, an overtake at the top, one friend leapfrogging another in the player league, or someone now within a whisker of top spot. Use the comingIn-vs-now numbers to phrase it as a change ("Geo went into the night third and leaves it top…"). Do NOT recite full tables, do NOT invent positions, and do NOT force a league mention into a night where nothing moved. Never confuse sweepstake points with goals.

CONTINUITY: the data may include "previousDays" — your own recent round-ups, newest first; the most recent few carry a full plain-text recap, the older ones just their title and subtitle. This is a running serial, not a fresh start each morning. Pick up threads where they fit naturally — a callback to a recent headline, a team that keeps embarrassing itself, a beat you set up earlier. The data may also include "playerForm": each player's sweepstake points gained per game day and running total across the whole tournament so far. Use it to spot and narrate ARCS where one genuinely exists — a player who haemorrhaged points early and is now clawing back, someone on a real hot streak, a leader in slow decline, a basement-dweller who never recovers. Reference a trajectory only when the numbers actually show one; never recite the form figures. TODAY'S results always lead and fill most of the words; never just rehash yesterday, and never invent a callback or an arc the data doesn't support. If there are no previousDays, simply write a strong standalone opener.

FRESHNESS (important): do NOT reuse a gag, metaphor, simile, image or nickname that already appears in previousDays unless you are deliberately BUILDING on it — escalating a running joke or paying off a setup. A line like "a man arm-wrestling himself" or "a Viking funeral" is spent the moment it's used; describe the same kind of situation a completely different way next time. Keep each title and subtitle distinct from previous ones. And VARY THE REGISTER night to night: the biblical/grandiose mode is one colour, not the whole palette — let some nights open wry, deadpan, breathless, conspiratorial or flatly matter-of-fact instead. Sameness is the enemy.

THE FLAVOUR OPENER (a signature move — use it often, but not every single night): in the spirit of the best of the old emails, you may open with a PURE-FLAVOUR story whose connection to the night's football is gloriously, knowingly tenuous — then pay that thread off and let it run through the write-up, snapping back to a result, a player or the table. The story can be (a) TOPICAL — something genuinely in today's news, pop culture or football gossip (use the web_search tool / bigNews below) — or (b) CONTRIVED from your own deep well of culture: a historical episode, a scene from a film or novel, a half-remembered myth, an obscure sporting footnote, a quaint custom from some idiosyncratic corner of the world. The flavour lives in the TELLING — vivid, confident, mock-authoritative, faintly absurd — and in how slyly you later weld it to the football. Make the tenuousness part of the joke. When you use one it should still leave most of the words for the actual results; on nights you skip it, just open strong.

REAL-WORLD FLAVOUR & NEWS — you have a web_search tool, plus a "bigNews" list of current BBC headlines in the data. Use search SPARINGLY to dig for genuinely usable hooks: a huge news story, an absurd pop-culture moment, or football gossip/rumour/banter (e.g. Popbitch, r/soccer, r/threelions, Sky Sports). The bar for actually USING real-world material is high and silence is a perfectly good default — but a great topical hook can power the flavour opener or a sharp aside. When you use one, wear it lightly: an aside, a title pun, or the opening thread — never let it crowd out the football, and treat any unverified gossip as obvious playful rumour, never asserted as fact about a real person. HARD SAFETY LIMITS (absolute): never joke about death, injury, illness, disaster, war casualties, crime victims, or anyone's real suffering — skip such items entirely; if in doubt, leave it out. Sanctioned running gag: any genuine news of the Strait of Hormuz being blocked/closed is a gift to point straight at Joe (see the gamertag puns).

GROUNDING RULES (critical — you will be given exact data):
- Use ONLY the scores, teams, owners, groups, standings and league data provided. Never invent a scoreline, a goalscorer, a minute, a points total, a league position, or any fact not present in the data.
- The "groupStanding" numbers are real football points (3 win / 1 draw) for qualification. Top two of each group qualify directly. A third-placed team MAY still sneak through as one of the eight best third-placed teams — when a team finishes third, treat its fate as an anxious, uncertain wait, never confirmed in or out, unless told otherwise.
- "concurrentGames" lists sets of same-group matches that kicked off at the SAME moment (the simultaneous final round). Their results unfolded together and fed off each other — a goal in one swinging qualification in the other, two sides effectively racing. Where it genuinely mattered, dramatise that live interplay; don't force it when the games were dead rubbers.
- A match may carry a "halfTimeScore" (the score at the break) alongside the full-time "score". Mine the gap between them for drama: a half-time lead thrown away, a goalless first half that burst open, a deficit overturned after the break, a game killed off early then coasted.
- A match may ALSO carry an "events" array — the real, verified timeline of its notable moments: goals (each with a "minute", the "player" who scored and often the "assist"), penalties scored/missed/saved, own goals, and red cards (a "kind" field labels each). When this is present, these are FACTS you may name freely and should use to tell the story properly: the scorer, an "88th-minute winner", a deficit hauled back, a missed penalty that proved costly, a red card that broke a game open, a calamitous 3rd-minute own goal. The "minute" is the match clock — "90'+4'" means stoppage time. This is the chance to single out heroes and villains by name. But the events list is exhaustive for the moments it covers: you still have NO substitutions, possession, chances or momentum data, so invent nothing beyond what each event states, and never add a goal, card or minute that isn't listed.
- When a match has NO "events" array, you have only its half-time and full-time scores: describe it from the scoreline alone and invent no minutes, scorers, cards or penalties.

THE BEST-THIRDS CUT-OFF: on days that finish off groups the data carries a "bestThirds" block — the cross-group race for the eight third-place qualifying spots, ranked, with "climbedInTonight" and "knockedOutTonight" listing exactly who jumped above the line and who was shoved below it by today's results. This is a goldmine of cruelty: a side sitting in a hotel watching their qualification evaporate because a team in another group nicked a late equaliser. When the lists are non-empty, tell that story by name — "X's stoppage-time leveller didn't just rescue a point, it bumped poor Y out of the tournament altogether without Y kicking a ball" — but ONLY using the teams the data actually names as climbing in or being knocked out. Never invent who was on the bubble.

LOOKING AHEAD (every write-up ends here, for every round — groups included): the data has a "lookingAhead" block — for each team that played today, the REAL next fixture it has earned ("nextStage", "kickoff", "opponent" with the opponent's "finishedAs" seeding), or "eliminated" if it's out. Close the piece by turning to what's next: who has drawn whom, the tie to savour or to dread, a friend handed a kindly or a brutal draw, two friends' teams set on a collision course deeper in the bracket, a seed who'll fancy their chances or one walking into a buzzsaw. Build this ONLY from lookingAhead — when an opponent is "to be decided", say exactly that and do NOT name or guess it; never invent a pairing, a stage or a kickoff time. Where today's games settled a group, dramatise what was riding on them — who needed what, who scraped through as a best third, who was dumped out and who they dragged down with them — using the final "groupStanding" and "bestThirds" data. WATCH FOR THE PERVERSE DRAW: sometimes finishing HIGHER earns a NASTIER tie — a runner-up landing a far tougher opponent than the third-placed side from their own group, so a team might secretly have preferred to finish a place lower. When the lookingAhead opponents make that the case, relish the catch-22. You MAY state a qualification consequence only when it is a plain, certain fact (e.g. "a point apiece was enough to send both through"); do NOT speculate on which knockout opponent a different scoreline would have produced. Match the forward-look to the round: after the group stage it previews the Round of 32 draw; after a knockout round it previews the next tie (or notes an opponent still to be decided).

OUTPUT: return JSON {"title": "...", "subtitle": "...", "html": "..."}. The title is a short, punny headline (no leading "#"). The subtitle is a separate witty one-line sub-headline — a DIFFERENT joke from the title, not a rephrase. The html is a fragment of roughly 450–800 words: an opening (a brisk scene-setter, or the flavour opener described above), then the meat (group-by-group or match-by-match, folding in league movements where they matter), a sharp "reckoning" paragraph naming who came out ahead on the night and in the tables, and finally the LOOKING-AHEAD paragraph described above. Use only <p>, <strong>, <em> and <h4> tags. Include each team's flag emoji next to its name on first mention. No <html>/<body>/<style>, no markdown.`;

async function generate(facts, { search = true } = {}) {
  const body = {
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "medium",
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, subtitle: { type: "string" }, html: { type: "string" } },
          required: ["title", "subtitle", "html"],
          additionalProperties: false,
        },
      },
    },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `Write the round-up for this game day. Here is the data:\n\n${JSON.stringify(facts, null, 2)}`,
    }],
  };
  // Live flavour: let the model dig for topical hooks / football gossip. Best
  // effort — if the tool is unavailable, fall back to a plain generation so the
  // daily job can never be broken by web search.
  if (search) body.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    if (search) { console.warn(`web_search generation failed (${res.status}); retrying without it: ${text.slice(0, 200)}`); return generate(facts, { search: false }); }
    throw new Error(`anthropic ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.stop_reason === "refusal") throw new Error(`refused: ${JSON.stringify(json.stop_details)}`);
  // The structured answer is the final text block (after any thinking / tool blocks).
  const textBlock = [...(json.content || [])].reverse().find((b) => b.type === "text");
  if (!textBlock) {
    const kinds = (json.content || []).map((b) => b.type).join(",") || "none";
    throw new Error(`no text block (stop_reason=${json.stop_reason}, blocks=[${kinds}]) — likely ran out of max_tokens during thinking`);
  }
  return JSON.parse(textBlock.text);
}

// strip tags/entities so prior write-ups can be fed back as plain-text context
const stripHtml = (h) => (h || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

// Prior round-ups before `key`, newest first: full plain-text recap for the most
// recent few (callbacks + spotting already-used gags), then title/subtitle only
// for a longer tail (avoid repeating headlines, allow lighter older callbacks).
const RECAP_DAYS = 4;
const HEADLINE_DAYS = 14;
function recentNarratives(entries, key) {
  return (entries || [])
    .filter((e) => e.day_key < key)
    .sort((a, b) => b.day_key.localeCompare(a.day_key))
    .slice(0, HEADLINE_DAYS)
    .map((e, i) => i < RECAP_DAYS
      ? { gameDay: e.date_label, title: e.title, subtitle: e.subtitle, recap: stripHtml(e.html) }
      : { gameDay: e.date_label, title: e.title, subtitle: e.subtitle });
}

// Each player's sweepstake points gained per game day and running total, across
// every settled day up to `uptoKey` — a compact trajectory so the writer can
// narrate arcs (collapses, comebacks, hot streaks) over any span, cheaply.
const shortDay = (key) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/London" }).format(new Date(`${key}T12:00:00Z`));
function playerForm(allFinished, uptoKey) {
  const keys = [...new Set(allFinished.map((m) => gameDayKey(m.utc_date)))].filter((k) => k <= uptoKey).sort();
  const acc = new Map(); // pid -> [{ day, gained, total }]
  let prev = new Map();
  for (const k of keys) {
    const subset = allFinished.filter((m) => gameDayKey(m.utc_date) <= k);
    const pl = computePlayerLeague(ownerOf, computeStandings(subset.map(toEngineMatch)));
    const totals = new Map(pl.map((r) => [r.playerId, r.total]));
    for (const [pid, total] of totals) {
      if (!acc.has(pid)) acc.set(pid, []);
      acc.get(pid).push({ day: shortDay(k), gained: total - (prev.get(pid) ?? 0), total });
    }
    prev = totals;
  }
  return [...acc].map(([pid, byDay]) => ({ player: pidToName(pid), byDay }));
}

// ---- looking ahead: each team's real NEXT fixture, for the forward-look ----
// team_id -> the earliest still-to-play match it appears in (the whole bracket is
// scheduled, so a surviving team always has one; an eliminated team has none).
function nextFixtureIndex(allMatches) {
  const idx = new Map();
  const upcoming = allMatches
    .filter((m) => !DONE_STATUS.has(m.status) && m.home_team_id && m.away_team_id && m.utc_date)
    .sort((a, b) => a.utc_date.localeCompare(b.utc_date));
  for (const m of upcoming) {
    for (const id of [m.home_team_id, m.away_team_id]) if (!idx.has(id)) idx.set(id, m);
  }
  return idx;
}

// Final group position for every team (same tie-breakers as groupStanding), so we
// can label a future opponent as "Group H runners-up" etc.
function finalGroupSeeds(finished) {
  const seeds = new Map();
  const groups = new Set([...team.values()].map((t) => t.group).filter((g) => g && g !== "?"));
  for (const g of groups) {
    const ids = [...team.keys()].filter((id) => team.get(id).group === g);
    const rows = ids.map((id) => {
      const ms = finished.filter((m) => m.stage === "GROUP_STAGE" &&
        (m.home_team_id === id || m.away_team_id === id) &&
        ids.includes(m.home_team_id) && ids.includes(m.away_team_id));
      return { id, ...record(ms, id) };
    }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    rows.forEach((r, i) => seeds.set(r.id, { group: g, position: i + 1 }));
  }
  return seeds;
}

// Cross-group "best third-placed" ranking from a set of finished group matches. A
// group contributes its third-placed side only once all six of its matches are in
// (so the third place is actually settled); ranked by pts, then GD, then GF. The
// top eight qualify for the Round of 32. Computing this before vs after a game-day
// reveals the live cutoff shifting — who climbed in and who got bumped out.
function thirdsRanked(groupMatches) {
  const groups = [...new Set([...team.values()].map((t) => t.group).filter((g) => g && g !== "?"))];
  const thirds = [];
  for (const g of groups) {
    const ids = [...team.keys()].filter((id) => team.get(id).group === g);
    const gm = groupMatches.filter((m) => ids.includes(m.home_team_id) && ids.includes(m.away_team_id));
    if (gm.length < 6) continue; // group not mathematically complete yet
    const rows = ids
      .map((id) => ({ id, ...record(gm.filter((m) => m.home_team_id === id || m.away_team_id === id), id) }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    thirds.push({ group: g, ...rows[2] });
  }
  return thirds.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
}

const STAGE_LABEL = {
  LAST_32: "Round of 32", ROUND_OF_16: "Round of 16", LAST_16: "Round of 16",
  QUARTER_FINALS: "quarter-final", SEMI_FINALS: "semi-final",
  THIRD_PLACE: "third-place play-off", FINAL: "final",
};
const prettyStage = (s) => STAGE_LABEL[s] || s;
const seedLabel = (p) => p === 1 ? "group winners" : p === 2 ? "runners-up" : p === 3 ? "third place" : `${p}th`;

// ---- build the facts payload for one game day ----
function buildFacts(dayMatches, allFinished, key, priorEntries, bigNews, eventsMap, nextIdx, seeds) {
  const desc = (id) => {
    const t = team.get(id) || { name: id, flag: "", group: "?" };
    const o = owner.get(id) || { name: "Unowned", handle: "?", tier: null };
    return { teamId: id, team: t.name, flag: t.flag, group: t.group, owner: o.name, gamertag: o.handle, seedTier: o.tier };
  };

  const matches = dayMatches.map((m) => ({
    home: desc(m.home_team_id),
    away: desc(m.away_team_id),
    score: `${m.home_score}-${m.away_score}`,
    halfTimeScore: (m.half_time_home != null && m.half_time_away != null) ? `${m.half_time_home}-${m.half_time_away}` : null,
    result: m.winner === "DRAW" ? "draw" : (m.winner === "HOME" ? `${team.get(m.home_team_id)?.name} won` : `${team.get(m.away_team_id)?.name} won`),
    settledBy: m.match_type === "PENALTIES" ? "penalty shootout" : (m.match_type === "EXTRA_TIME" ? "extra time" : "90 minutes"),
    stage: m.stage,
    matchday: m.matchday,
    kickoffBST: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(new Date(m.utc_date)) + " BST",
    events: eventsMap?.get(String(m.id)) || null,
  }));

  // Same-group games that kicked off at the SAME time — their results played out
  // simultaneously and interacted live (a goal in one swinging the other's fate).
  const kickGroups = new Map(); // `${group}@${utc}` -> ["Team v Team", ...]
  for (const m of dayMatches) {
    if (m.stage !== "GROUP_STAGE") continue;
    const g = team.get(m.home_team_id)?.group;
    const k = `${g}@${m.utc_date}`;
    if (!kickGroups.has(k)) kickGroups.set(k, []);
    kickGroups.get(k).push(`${nameOf(m.home_team_id)} v ${nameOf(m.away_team_id)}`);
  }
  const concurrentGames = [...kickGroups.values()].filter((s) => s.length > 1);

  // standings for every group that featured today (group-stage only)
  const groupsToday = new Set();
  for (const m of dayMatches) {
    if (m.stage !== "GROUP_STAGE") continue;
    groupsToday.add(team.get(m.home_team_id)?.group);
    groupsToday.add(team.get(m.away_team_id)?.group);
  }
  const groupStanding = {};
  for (const g of groupsToday) {
    if (!g || g === "?") continue;
    const ids = [...team.keys()].filter((id) => team.get(id).group === g);
    const rows = ids.map((id) => {
      const theirMatches = allFinished.filter(
        (m) => m.stage === "GROUP_STAGE" && (m.home_team_id === id || m.away_team_id === id) &&
               ids.includes(m.home_team_id) && ids.includes(m.away_team_id));
      const r = record(theirMatches, id);
      const o = owner.get(id) || {};
      const t = team.get(id) || {};
      return { team: t.name, flag: t.flag, owner: o.name || "Unowned", ...r };
    }).sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    // Groups are complete: ground qualification in whether each team actually has
    // a knockout fixture still to play (nextIdx), not a position-based guess.
    const idByRow = rows.map((row) => ids.find((id) => team.get(id)?.name === row.team));
    rows.forEach((row, i) => {
      row.position = i + 1;
      const through = !!nextIdx?.get(idByRow[i]);
      if (i < 2) row.status = through ? "qualified (top two)" : "eliminated";
      else if (i === 2) row.status = through ? "qualified as one of the eight best third-placed teams" : "eliminated — third, missed the best-thirds cut";
      else row.status = "eliminated";
    });
    groupStanding[`Group ${g}`] = rows;
  }

  // best third-placed cutoff, before vs after today — only worth it on a day that
  // actually featured group games (it's settled once the group stage is over).
  let bestThirds;
  if (dayMatches.some((m) => m.stage === "GROUP_STAGE")) {
    const grp = allFinished.filter((m) => m.stage === "GROUP_STAGE");
    const afterT = thirdsRanked(grp.filter((m) => gameDayKey(m.utc_date) <= key));
    const beforeT = thirdsRanked(grp.filter((m) => gameDayKey(m.utc_date) < key));
    const beforeQ = new Set(beforeT.slice(0, 8).map((t) => t.id));
    const afterQ = new Set(afterT.slice(0, 8).map((t) => t.id));
    const lite = (t) => ({ team: team.get(t.id)?.name, flag: team.get(t.id)?.flag || "", group: `Group ${t.group}`, owner: (owner.get(t.id) || {}).name || "Unowned" });
    bestThirds = {
      note: "The eight best third-placed teams join the group winners and runners-up in the Round of 32; the thirds ranked 9th–12th are eliminated. Ranked by points, then goal difference, then goals for. A group appears only once it is mathematically complete, so this table firms up as the final group games finish — and the qualifying cut-off can move with a single late goal.",
      table: afterT.map((t, i) => ({ rank: i + 1, ...lite(t), pts: t.pts, gd: t.gd, gf: t.gf, status: i < 8 ? "qualifies (inside the top 8)" : "eliminated" })),
      climbedInTonight: afterT.slice(0, 8).filter((t) => !beforeQ.has(t.id)).map(lite),
      knockedOutTonight: beforeT.slice(0, 8).filter((t) => !afterQ.has(t.id)).map(lite),
    };
  }

  // sweepstake league movement: before tonight vs after
  const before = allFinished.filter((m) => gameDayKey(m.utc_date) < key);
  const after = allFinished.filter((m) => gameDayKey(m.utc_date) <= key);
  const sweepstakeLeagues = sweepContext(before, after);

  // Looking ahead: every team that played today, and the REAL next fixture it has
  // earned (or its elimination). An opponent is named only when BOTH teams have
  // this same match as their immediate next game — i.e. both are already locked in;
  // otherwise the other side is still "to be decided" and naming it would leak a
  // result that hasn't happened yet in the serial.
  const fmtKick = (iso) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(new Date(iso)) + " BST";
  const descAhead = (id) => {
    const d = desc(id);
    const s = seeds?.get(id);
    return { team: d.team, flag: d.flag, owner: d.owner, gamertag: d.gamertag,
      ...(s ? { finishedAs: `Group ${s.group} ${seedLabel(s.position)}` } : {}) };
  };
  const involved = [...new Set(dayMatches.flatMap((m) => [m.home_team_id, m.away_team_id]))].filter(Boolean);
  const lookingAhead = involved.map((id) => {
    const f = nextIdx?.get(id);
    if (!f) return { ...descAhead(id), status: "eliminated — no fixtures remaining" };
    const oppId = f.home_team_id === id ? f.away_team_id : f.home_team_id;
    const mutual = String(nextIdx.get(oppId)?.id) === String(f.id);
    return {
      ...descAhead(id),
      status: "still in",
      nextStage: prettyStage(f.stage),
      kickoff: fmtKick(f.utc_date),
      opponent: mutual ? descAhead(oppId) : "to be decided (their tie hasn't been played yet)",
    };
  });

  return {
    gameDay: dayLabel(key),
    previousDays: recentNarratives(priorEntries, key),
    playerForm: playerForm(allFinished, key),
    matches, concurrentGames, groupStanding, sweepstakeLeagues, lookingAhead,
    ...(bestThirds ? { bestThirds } : {}),
    ...(bigNews?.length ? { bigNews } : {}),
  };
}

// ---- main ----
const allMatches = await fetchMatches();
const finished = allMatches.filter((m) => DONE_STATUS.has(m.status));
const nextIdx = nextFixtureIndex(allMatches);   // team -> real next fixture (forward-look)
const seeds = finalGroupSeeds(finished);        // team -> final group position (opponent labels)

const dayMatches = new Map(); // key -> finished matches[]
for (const m of finished) {
  if (!m.home_team_id || !m.away_team_id || !m.utc_date) continue;
  const k = gameDayKey(m.utc_date);
  if (!dayMatches.has(k)) dayMatches.set(k, []);
  dayMatches.get(k).push(m);
}

// Per game-day bucket: how many fixtures are settled vs still pending/live. A day
// is "ready" to write once it has at least one result and nothing left to play.
const dayBlocking = new Map(); // key -> count of unresolved fixtures
for (const m of allMatches) {
  if (!m.home_team_id || !m.away_team_id || !m.utc_date) continue;
  if (!BLOCKING_STATUS.has(m.status)) continue;
  const k = gameDayKey(m.utc_date);
  dayBlocking.set(k, (dayBlocking.get(k) || 0) + 1);
}
const isReady = (k) => dayMatches.has(k) && !dayBlocking.get(k);

const cmPath = join(ROOT, "data/commentary.json");
let store = { updated_at: null, entries: [] };
try { store = JSON.parse(readFileSync(cmPath, "utf8")); } catch {}

// Preview mode: render one closed day to stdout with COMMENTARY_MODEL, WITHOUT
// touching data/commentary.json — for comparing models/voice before committing.
//   PREVIEW=1 COMMENTARY_MODEL=claude-sonnet-4-6 node scripts/commentary.mjs
if (process.env.PREVIEW) {
  const closed = [...dayMatches.keys()].filter(isReady).sort();
  const key = process.env.PREVIEW_DAY || closed[closed.length - 1];
  if (!key || !dayMatches.has(key)) { console.error("No closed game day to preview."); process.exit(1); }
  const dm = dayMatches.get(key).slice().sort((a, b) => a.utc_date.localeCompare(b.utc_date));
  console.error(`PREVIEW — ${dayLabel(key)} (${dm.length} matches) via ${MODEL}. Not written to file.\n`);
  const bigNews = process.env.DUMP_FACTS ? [] : await fetchBigNews();
  const eventsMap = await fetchEvents(dm);
  const facts = buildFacts(dm, finished, key, store.entries, bigNews, eventsMap, nextIdx, seeds);
  // DUMP_FACTS=1 PREVIEW=1 PREVIEW_DAY=YYYY-MM-DD — print the grounding payload only
  // (no API call), to eyeball events / lookingAhead / group statuses.
  if (process.env.DUMP_FACTS) { console.log(JSON.stringify(facts, null, 2)); process.exit(0); }
  const { title, subtitle, html } = await generate(facts);
  console.log(`# ${title}\n_${subtitle}_\n\n${html}`);
  process.exit(0);
}
const covered = new Set((store.entries || []).map((e) => e.day_key));

// fully-settled days we haven't written yet, newest first
const candidates = [...dayMatches.keys()]
  .filter((k) => isReady(k) && !covered.has(k))
  .sort()
  .reverse();

const backfill = process.env.DAYS === "all";
const todo = backfill ? candidates.slice().reverse() : candidates.slice(0, 1);

if (!todo.length) {
  console.log("No fully-settled new game day to write up — nothing to do.");
  process.exit(0);
}

// Fetch news once, only now that we know we're generating. Skip during backfill —
// today's headlines would be anachronistic on an old game day, and live web_search
// (the slow part) is dropped too so a multi-day catch-up doesn't crawl.
const bigNews = backfill ? [] : await fetchBigNews();

let written = 0;
for (const key of todo) {
  const dm = dayMatches.get(key).slice().sort((a, b) => a.utc_date.localeCompare(b.utc_date));
  const eventsMap = await fetchEvents(dm);
  const facts = buildFacts(dm, finished, key, store.entries, bigNews, eventsMap, nextIdx, seeds);
  console.log(`Generating ${key} (${dm.length} matches)…`);
  const { title, subtitle, html } = await generate(facts, { search: !backfill });
  store.entries = (store.entries || []).filter((e) => e.day_key !== key);
  store.entries.push({
    day_key: key,
    date_label: facts.gameDay,
    title,
    subtitle,
    match_ids: dm.map((m) => m.id),
    html,
    model: MODEL,
    generated_at: new Date().toISOString(),
  });
  // Persist after EACH day so a slow/interrupted run never loses finished work and
  // a later run resumes from where it left off (each saved day is also a callback
  // source for the next).
  store.entries.sort((a, b) => b.day_key.localeCompare(a.day_key));
  store.updated_at = new Date().toISOString();
  writeFileSync(cmPath, JSON.stringify(store, null, 2));
  written++;
  console.log(`  ✓ "${title}"`);
}

console.log(`Wrote ${written} entr${written === 1 ? "y" : "ies"}; ${store.entries.length} total.`);

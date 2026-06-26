// commentary.mjs — generate a pundit/commentator-style write-up of the last
// completed "game day" and append it to data/commentary.json. Runs in GitHub
// Actions (Node 18+, global fetch — no npm dependencies).
//
// A "game day" is a US-night session, not a UK calendar day: World Cup 2026
// kicks off run ~20:00–07:00 UK, so a day's results "complete" around breakfast.
// We bucket every match by the London date of (kickoff − 9h), so an overnight
// session (e.g. 21:00 BST → 03:00 BST) lands under a single key, and only
// generate for days that have fully closed (key < today's key).
//
// The witty prose is written by Claude (claude-opus-4-8) — it can't be templated.
// Required secret: ANTHROPIC_API_KEY.
// Optional: SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY
//           (default to the public anon values from js/config.js)
//           DAYS=all  — backfill every uncovered closed day (default: latest only)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
async function fetchFinished() {
  const cols = "id,home_team_id,away_team_id,home_score,away_score,winner,match_type,stage,matchday,utc_date,status";
  const res = await fetch(`${SB_URL}/rest/v1/matches?select=${cols}&status=eq.FINISHED&order=utc_date.asc`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!res.ok) { console.error("Supabase error:", await res.text()); process.exit(1); }
  return res.json();
}

// ---- Anthropic ----
const SYSTEM = `You are Joe, the impresario behind a private World Cup 2026 sweepstake among six friends. You write a daily pundit/commentator round-up in the voice of the long-running "LPS" (Last Person Standing) emails: long, dramatic, gleefully overwrought sentences; mock-grandiose; biblical and literary asides; stadium-name and pop-culture gags; affectionate but savage roasting of your mates; near-fatal-heart-attack hyperbole; British spelling; the occasional well-placed swear word (this is a private group — full Joe, no sanitising).

THE ONE NON-NEGOTIABLE CRAFT RULE: every result must be played up on TWO levels at once — what it means for the actual country/team (qualification, glory, humiliation, the knockouts), AND what it means for the real FRIEND who drafted that team (named: Sean, Joe, Geo, Pete, Logan, Barney). Lean into coincidences: one player owning both teams in a match, a player whose teams all flopped, a heroic-but-pointless win that helps nobody, etc.

WHO'S WHO (use for needle and running jokes, but never invent results): YOU are Joe — the impresario and author of these round-ups — so you write about yourself in the third person and are free to be self-deprecating or self-aggrandising as the night demands. Joe and Geo are BROTHERS in real life; whenever their teams meet, clash on points, or one prospers at the other's expense, milk the sibling rivalry for everything it's worth.

GROUNDING RULES (critical — you will be given exact data):
- Use ONLY the scores, teams, owners, groups and standings provided. Never invent a scoreline, a goalscorer, a minute, or a fact not present in the data.
- The standings provided are real football points (3 for a win, 1 for a draw). Top two of each group qualify directly. A third-placed team MAY still qualify as one of the eight best third-placed teams across the twelve groups — when a team finishes third, treat its fate as an anxious, uncertain wait, never as confirmed in or out, unless told otherwise.
- Do not state the sweepstake points/league standings unless given them; you may speak qualitatively about whose night it was.

OUTPUT: return JSON {"title": "...", "html": "..."}. The title is a short, punny headline (no leading "#"). The html is a fragment of 350–650 words: a short scene-setting intro paragraph, then the meat (group-by-group or match-by-match), then a sharp closing "reckoning" paragraph naming who came out ahead. Use only <p>, <strong>, <em> and <h4> tags. Include each team's flag emoji next to its name on first mention. No <html>/<body>/<style>, no markdown.`;

async function generate(facts) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" }, html: { type: "string" } },
            required: ["title", "html"],
            additionalProperties: false,
          },
        },
      },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Write the round-up for this game day. Here is the data:\n\n${JSON.stringify(facts, null, 2)}`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.stop_reason === "refusal") throw new Error(`refused: ${JSON.stringify(json.stop_details)}`);
  const textBlock = (json.content || []).find((b) => b.type === "text");
  if (!textBlock) {
    const kinds = (json.content || []).map((b) => b.type).join(",") || "none";
    throw new Error(`no text block (stop_reason=${json.stop_reason}, blocks=[${kinds}]) — likely ran out of max_tokens during thinking`);
  }
  return JSON.parse(textBlock.text);
}

// ---- build the facts payload for one game day ----
function buildFacts(dayMatches, allFinished, key) {
  const desc = (id) => {
    const t = team.get(id) || { name: id, flag: "", group: "?" };
    const o = owner.get(id) || { name: "Unowned", handle: "?", tier: null };
    return { teamId: id, team: t.name, flag: t.flag, group: t.group, owner: o.name, gamertag: o.handle, seedTier: o.tier };
  };

  const matches = dayMatches.map((m) => ({
    home: desc(m.home_team_id),
    away: desc(m.away_team_id),
    score: `${m.home_score}-${m.away_score}`,
    result: m.winner === "DRAW" ? "draw" : (m.winner === "HOME" ? `${team.get(m.home_team_id)?.name} won` : `${team.get(m.away_team_id)?.name} won`),
    settledBy: m.match_type === "PENALTIES" ? "penalty shootout" : (m.match_type === "EXTRA_TIME" ? "extra time" : "90 minutes"),
    stage: m.stage,
    matchday: m.matchday,
    kickoffBST: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" }).format(new Date(m.utc_date)) + " BST",
  }));

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
    rows.forEach((row, i) => {
      row.position = i + 1;
      row.status = i < 2 ? "qualified (top 2)" : (i === 2 ? "third — best-third lottery, uncertain" : "eliminated unless drama elsewhere");
    });
    groupStanding[`Group ${g}`] = rows;
  }

  return { gameDay: dayLabel(key), matches, groupStanding };
}

// ---- main ----
const finished = await fetchFinished();
const dayMatches = new Map(); // key -> matches[]
for (const m of finished) {
  if (!m.home_team_id || !m.away_team_id || !m.utc_date) continue;
  const k = gameDayKey(m.utc_date);
  if (!dayMatches.has(k)) dayMatches.set(k, []);
  dayMatches.get(k).push(m);
}

const todayKey = gameDayKey(new Date().toISOString());

// Preview mode: render one closed day to stdout with COMMENTARY_MODEL, WITHOUT
// touching data/commentary.json — for comparing models/voice before committing.
//   PREVIEW=1 COMMENTARY_MODEL=claude-sonnet-4-6 node scripts/commentary.mjs
if (process.env.PREVIEW) {
  const closed = [...dayMatches.keys()].filter((k) => k < todayKey).sort();
  const key = process.env.PREVIEW_DAY || closed[closed.length - 1];
  if (!key || !dayMatches.has(key)) { console.error("No closed game day to preview."); process.exit(1); }
  const dm = dayMatches.get(key).slice().sort((a, b) => a.utc_date.localeCompare(b.utc_date));
  console.error(`PREVIEW — ${dayLabel(key)} (${dm.length} matches) via ${MODEL}. Not written to file.\n`);
  const { title, html } = await generate(buildFacts(dm, finished, key));
  console.log(`# ${title}\n\n${html}`);
  process.exit(0);
}

const cmPath = join(ROOT, "data/commentary.json");
let store = { updated_at: null, entries: [] };
try { store = JSON.parse(readFileSync(cmPath, "utf8")); } catch {}
const covered = new Set((store.entries || []).map((e) => e.day_key));

// closed days (key strictly before today) that we haven't written yet, newest first
const candidates = [...dayMatches.keys()]
  .filter((k) => k < todayKey && !covered.has(k))
  .sort()
  .reverse();

const todo = process.env.DAYS === "all" ? candidates.slice().reverse() : candidates.slice(0, 1);

if (!todo.length) {
  console.log("No new closed game day to write up — nothing to do.");
  process.exit(0);
}

for (const key of todo) {
  const dm = dayMatches.get(key).slice().sort((a, b) => a.utc_date.localeCompare(b.utc_date));
  const facts = buildFacts(dm, finished, key);
  console.log(`Generating ${key} (${dm.length} matches)…`);
  const { title, html } = await generate(facts);
  store.entries = (store.entries || []).filter((e) => e.day_key !== key);
  store.entries.push({
    day_key: key,
    date_label: facts.gameDay,
    title,
    match_ids: dm.map((m) => m.id),
    html,
    model: MODEL,
    generated_at: new Date().toISOString(),
  });
  console.log(`  ✓ "${title}"`);
}

store.entries.sort((a, b) => b.day_key.localeCompare(a.day_key));
store.updated_at = new Date().toISOString();
writeFileSync(cmPath, JSON.stringify(store, null, 2));
console.log(`Wrote ${todo.length} entr${todo.length === 1 ? "y" : "ies"}; ${store.entries.length} total.`);

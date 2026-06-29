// sync.mjs — fetch World Cup results from football-data.org and upsert them into
// Supabase, in the canonical shape js/engine.js expects. Runs in GitHub Actions
// (Node 18+, uses global fetch — no npm dependencies).
//
// The ONLY secret you must set is FOOTBALL_DATA_API_KEY (football-data.org token).
// The Supabase URL and key default to the public anon values that already ship in
// js/config.js — the anon key has write access because the tables' RLS is open by
// design (a private friends' sweepstake). Override via env if you prefer:
//   SUPABASE_URL            https://<ref>.supabase.co
//   SUPABASE_SERVICE_KEY    service_role key (server-side only) — used if present
//   SUPABASE_ANON_KEY       anon key (fallback)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Public defaults, mirrored from js/config.js (safe to commit; anon-only access).
const DEFAULT_URL = "https://tkbkeqtywttaasyutmsj.supabase.co";
const DEFAULT_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtlcXR5d3R0YWFzeXV0bXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMTU4NjksImV4cCI6MjA5NTg5MTg2OX0.begyj0OQidbXTl-3bdjjHUcud4xjpeKt8AWXQnSiZ2A";

const FD_KEY = required("FOOTBALL_DATA_API_KEY");
const SB_URL = (process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_ANON;
const COMPETITION = process.env.COMPETITION_CODE || "WC";

function required(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var ${name}`); process.exit(1); }
  return v;
}

// football-data score.winner / duration -> our canonical values.
const WINNER = { HOME_TEAM: "HOME", AWAY_TEAM: "AWAY", DRAW: "DRAW" };
function matchType(duration) {
  if (duration === "PENALTY_SHOOTOUT") return "PENALTIES";
  if (duration === "EXTRA_TIME") return "EXTRA_TIME";
  return "REGULAR";
}

async function fdGet(path) {
  const res = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { "X-Auth-Token": FD_KEY },
  });
  if (!res.ok) throw new Error(`football-data ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbRequest(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    method,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase ${method} ${path} -> ${res.status} ${await res.text()}`);
  // return=minimal upserts come back 201/204 with an EMPTY body — don't JSON.parse
  // nothing (that throws "Unexpected end of JSON input"). Parse only real content.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  // Don't clobber matches the commissioner has manually overridden.
  const overridden = await sbRequest("GET", "/matches?select=id&is_overridden=eq.true");
  const skip = new Set(overridden.map((r) => r.id));

  const { matches } = await fdGet(`/competitions/${COMPETITION}/matches`);
  const rows = [];
  for (const m of matches) {
    const id = String(m.id);
    if (skip.has(id)) continue;
    const s = m.score || {};
    const finished = m.status === "FINISHED";
    const isPen = s.duration === "PENALTY_SHOOTOUT";

    // For penalty-shootout games football-data.org sometimes stores the
    // cumulative (play + shootout goals) total in fullTime instead of the
    // 90/120-min score. extraTime is reliably the score before the shootout,
    // so prefer it for PENALTY_SHOOTOUT; fall back to fullTime otherwise.
    const matchScore = isPen ? (s.extraTime ?? s.fullTime) : s.fullTime;

    // football-data.org occasionally returns winner="DRAW" for a finished
    // penalty-shootout while it is still processing the result. Infer the real
    // winner from the penalty scores when that happens.
    let winner = null;
    if (finished) {
      if (!isPen || s.winner !== "DRAW") {
        winner = WINNER[s.winner] ?? null;
      } else {
        const ph = s.penalties?.home, pa = s.penalties?.away;
        if (ph != null && pa != null && ph !== pa) winner = ph > pa ? "HOME" : "AWAY";
        else winner = WINNER[s.winner] ?? null;
      }
    }

    rows.push({
      id,
      home_team_id: m.homeTeam?.id != null ? String(m.homeTeam.id) : null,
      away_team_id: m.awayTeam?.id != null ? String(m.awayTeam.id) : null,
      home_score: finished ? matchScore?.home ?? null : null,
      away_score: finished ? matchScore?.away ?? null : null,
      half_time_home: finished ? s.halfTime?.home ?? null : null,
      half_time_away: finished ? s.halfTime?.away ?? null : null,
      match_type: finished ? matchType(s.duration) : null,
      winner,
      pen_home: s.penalties?.home ?? null,
      pen_away: s.penalties?.away ?? null,
      stage: m.stage,
      status: m.status,
      matchday: m.matchday ?? null,
      utc_date: m.utcDate ?? null,
      last_synced: new Date().toISOString(),
    });
  }

  // Upsert in chunks (PostgREST handles arrays fine, but keep requests modest).
  // If the half-time columns aren't in the DB yet (migration not run), PostgREST
  // 400s on the unknown column — detect that once and retry without them, so a
  // pending migration can never brick the sync. Run the ALTER in schema.sql to
  // start persisting half-time scores.
  let stripHt = false;
  const upsert = async (chunk) => {
    const body = stripHt
      ? chunk.map(({ half_time_home, half_time_away, ...rest }) => rest)
      : chunk;
    try {
      await sbRequest("POST", "/matches", body,
        { Prefer: "resolution=merge-duplicates,return=minimal" });
    } catch (e) {
      if (!stripHt && /half_time/.test(String(e.message))) {
        console.warn("matches.half_time_* columns missing — run the ALTER in schema.sql. Syncing without half-time for now.");
        stripHt = true;
        return upsert(chunk);
      }
      throw e;
    }
  };
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await upsert(rows.slice(i, i + CHUNK));
  }
  const fin = rows.filter((r) => r.status === "FINISHED").length;
  console.log(`Synced ${rows.length} matches (${fin} finished, ${skip.size} overridden left untouched).`);

  await writeBracketSnapshot();
}

// Write data/bracket-results.json — the static results feed the public radial
// bracket (bracket-public.html) reads. Sourced from the DB (so it includes any
// commissioner overrides), knockout stages only, with volatile fields normalised:
// scores stay null until FINISHED and status collapses to FINISHED/SCHEDULED, so
// the file only changes on a real bracket event (entrant resolved or tie decided)
// — never on in-play score flicker — keeping CI commits rare.
const SNAPSHOT_STAGES = ["LAST_32", "LAST_16", "QUARTER_FINALS", "SEMI_FINALS", "FINAL"];
async function writeBracketSnapshot() {
  const cols = "id,status,home_team_id,away_team_id,home_score,away_score,winner,match_type,pen_home,pen_away";
  const rows = (await sbRequest("GET", `/matches?select=${cols}&stage=in.(${SNAPSHOT_STAGES.join(",")})`)) || [];
  const matches = rows
    .map((r) => {
      const finished = r.status === "FINISHED";
      return {
        id: String(r.id),
        status: finished ? "FINISHED" : "SCHEDULED",
        home_team_id: r.home_team_id ?? null,
        away_team_id: r.away_team_id ?? null,
        home_score: finished ? r.home_score ?? null : null,
        away_score: finished ? r.away_score ?? null : null,
        winner: finished ? r.winner ?? null : null,
        match_type: finished ? r.match_type ?? null : null,
        pen_home: finished ? r.pen_home ?? null : null,
        pen_away: finished ? r.pen_away ?? null : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const out = {
    note: "Knockout results snapshot for the public radial bracket. Written by scripts/sync.mjs; do not edit by hand.",
    matches,
  };
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "bracket-results.json");
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${matches.length} knockout rows to data/bracket-results.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });

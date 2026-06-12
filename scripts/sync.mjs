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
  return res.status === 204 ? null : res.json();
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
    rows.push({
      id,
      home_team_id: m.homeTeam?.id != null ? String(m.homeTeam.id) : null,
      away_team_id: m.awayTeam?.id != null ? String(m.awayTeam.id) : null,
      home_score: finished ? s.fullTime?.home ?? null : null,
      away_score: finished ? s.fullTime?.away ?? null : null,
      match_type: finished ? matchType(s.duration) : null,
      winner: finished ? WINNER[s.winner] ?? null : null,
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
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await sbRequest("POST", "/matches", rows.slice(i, i + CHUNK),
      { Prefer: "resolution=merge-duplicates,return=minimal" });
  }
  const fin = rows.filter((r) => r.status === "FINISHED").length;
  console.log(`Synced ${rows.length} matches (${fin} finished, ${skip.size} overridden left untouched).`);
}

main().catch((e) => { console.error(e); process.exit(1); });

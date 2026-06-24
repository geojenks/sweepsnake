// sync-highlights.mjs — search YouTube for World Cup highlight clips and cache
// the video IDs in data/highlights.json. Runs in GitHub Actions daily.
//
// Required secret: YOUTUBE_API_KEY (Google Cloud API key with YouTube Data API v3)
// Optional:        SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_ANON_KEY
//                  (default to the public anon values from js/config.js)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// ---- config ----
const YT_KEY = process.env.YOUTUBE_API_KEY;
if (!YT_KEY) { console.error("YOUTUBE_API_KEY is not set"); process.exit(1); }

const DEFAULT_URL  = "https://tkbkeqtywttaasyutmsj.supabase.co";
const DEFAULT_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtlcXR5d3R0YWFzeXV0bXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMTU4NjksImV4cCI6MjA5NTg5MTg2OX0.begyj0OQidbXTl-3bdjjHUcud4xjpeKt8AWXQnSiZ2A";
const SB_URL = (process.env.SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || DEFAULT_ANON;

// ---- load static team names ----
const teamsFile = JSON.parse(readFileSync(join(ROOT, "data/wc2026_teams.json"), "utf8"));
const teamName  = new Map(teamsFile.teams.map((t) => [t.id, t.name]));

// ---- load existing cache ----
const hlPath = join(ROOT, "data/highlights.json");
let stored = {};
try { stored = JSON.parse(readFileSync(hlPath, "utf8")).videos || {}; } catch {}

// ---- fetch finished matches from Supabase ----
const res = await fetch(`${SB_URL}/rest/v1/matches?select=id,home_team_id,away_team_id,status,utc_date&status=eq.FINISHED&order=utc_date.asc`, {
  headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
});
if (!res.ok) { console.error("Supabase error:", await res.text()); process.exit(1); }
const matches = await res.json();

// ---- search YouTube for each uncached match ----
// Allow 3 hours after kick-off for highlights to be published.
const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
let found = 0;

for (const m of matches) {
  const key = String(m.id);
  if (stored[key]) continue; // already cached

  // Skip if kick-off was too recent (highlights not up yet)
  if (m.utc_date && new Date(m.utc_date) > cutoff) {
    console.log(`⏳ Too recent, skipping: ${m.home_team_id} v ${m.away_team_id}`);
    continue;
  }

  const home = teamName.get(m.home_team_id) || m.home_team_id;
  const away = teamName.get(m.away_team_id) || m.away_team_id;

  const q = `FIFA World Cup 2026 ${home} ${away} highlights`;
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "relevance");
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("key", YT_KEY);

  try {
    const ytRes = await fetch(url.toString());
    const json  = await ytRes.json();

    if (json.error) {
      console.warn(`YT API error for "${q}": ${json.error.message}`);
      continue;
    }

    // Prefer an item whose title contains "highlight"; fall back to first result.
    const item = (json.items || []).find((i) =>
      i.snippet.title.toLowerCase().includes("highlight")
    ) || json.items?.[0];

    if (item) {
      stored[key] = item.id.videoId;
      console.log(`✓ ${home} v ${away}: ${item.id.videoId} ("${item.snippet.title}")`);
      found++;
    } else {
      console.log(`✗ No result yet: ${home} v ${away}`);
    }
  } catch (e) {
    console.warn(`Fetch failed for "${q}":`, e.message);
  }

  // Respect YouTube's rate limit (100 search units per query).
  await new Promise((r) => setTimeout(r, 400));
}

writeFileSync(hlPath, JSON.stringify({ updated_at: new Date().toISOString(), videos: stored }, null, 2));
console.log(`Done. ${found} new video${found === 1 ? "" : "s"} found; ${Object.keys(stored).length} total cached.`);

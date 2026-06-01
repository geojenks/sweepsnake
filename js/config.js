// Public client configuration. This file IS committed and ships to the browser.
//
// The Supabase anon key is safe to expose: it only grants whatever Row-Level
// Security policies allow, and the app has no server to hide it behind (it runs
// entirely on GitHub Pages). Do NOT put the football-data.org key or the
// Supabase service_role key here — those stay server-side in GitHub Actions.

export const SUPABASE_URL = "https://tkbkeqtywttaasyutmsj.supabase.co";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRrYmtlcXR5d3R0YWFzeXV0bXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMTU4NjksImV4cCI6MjA5NTg5MTg2OX0.begyj0OQidbXTl-3bdjjHUcud4xjpeKt8AWXQnSiZ2A";

// Tournament data source (football-data.org competition code for the World Cup).
export const COMPETITION_CODE = "WC";

// Default sweepstake configuration. The commissioner can override these in the
// admin panel before the draft opens; they are persisted in the `config` table.
export const DEFAULTS = {
  n_players: 6,
  n_teams: 48,          // include all teams
  stake_per_player: 50, // £
  // n_rounds is derived = n_teams / n_players (must divide evenly)
};

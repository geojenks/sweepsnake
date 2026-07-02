// supabase.js — the single place that talks to the database.
// Every page imports these helpers rather than touching the client directly.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// Small helper: throw on error so callers can use try/catch uniformly.
function ok({ data, error }) {
  if (error) throw error;
  return data;
}

// ---- Config (key/value) ----
export async function getConfig() {
  const rows = ok(await sb.from("config").select("key,value"));
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}
export async function setConfig(key, value) {
  return ok(await sb.from("config").upsert({ key, value }).select());
}

// ---- Players ----
export async function getPlayers() {
  return ok(await sb.from("players").select("*").order("slot", { ascending: true }));
}
export async function addPlayer(name, colour, slot) {
  return ok(await sb.from("players").insert({ name, colour, slot }).select().single());
}
export async function updatePlayer(id, patch) {
  return ok(await sb.from("players").update(patch).eq("id", id).select().single());
}
export async function deletePlayer(id) {
  return ok(await sb.from("players").delete().eq("id", id));
}

// ---- Teams ----
export async function getTeams() {
  return ok(await sb.from("teams").select("*").order("fifa_ranking", { ascending: true }));
}
// Seed/refresh the team list (used once from the admin panel; upsert is idempotent).
export async function upsertTeams(teams) {
  return ok(await sb.from("teams").upsert(teams).select());
}
export async function setTeamInPlay(id, inPlay) {
  return ok(await sb.from("teams").update({ in_play: inPlay }).eq("id", id).select().single());
}
// Assign a team to a player at a given tier (draft pick / commissioner override).
export async function assignTeam(teamId, playerId, tier) {
  return ok(await sb.from("teams").update({ player_id: playerId, tier }).eq("id", teamId).select().single());
}

// ---- Draft picks ----
export async function getDraftPicks() {
  return ok(await sb.from("draft_picks").select("*").order("overall_pick", { ascending: true }));
}
export async function recordPick(pick) {
  // pick: { round, pick_in_round, overall_pick, player_id, team_id }
  return ok(await sb.from("draft_picks").insert(pick).select().single());
}

// ---- Matches ----
export async function getMatches() {
  return ok(await sb.from("matches").select("*").order("utc_date", { ascending: true }));
}
export async function upsertMatches(rows) {
  return ok(await sb.from("matches").upsert(rows).select());
}
export async function overrideMatch(id, patch) {
  return ok(
    await sb.from("matches").update({ ...patch, is_overridden: true })
      .eq("id", id).select().single()
  );
}
export async function unlockMatch(id) {
  return ok(
    await sb.from("matches").update({ is_overridden: false })
      .eq("id", id).select().single()
  );
}

// ---- Realtime ----
// Subscribe to any change on a table; returns the channel so callers can remove it.
export function onTableChange(table, handler) {
  const channel = sb
    .channel(`rt:${table}`)
    .on("postgres_changes", { event: "*", schema: "public", table }, handler)
    .subscribe();
  return channel;
}

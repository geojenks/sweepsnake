// app.js — shared UI helpers + live-data loading used by every live page.
import { PLAYER_COLOURS } from "./engine.js";
import { getConfig, getPlayers, getTeams, getMatches } from "./supabase.js";

// ---- tiny DOM helpers ----
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const fmtSigned = (n) => (n >= 0 ? "+" : "") + n;

// ---- player colours ----
// A player's colour is their stored colour, else derived from their draft slot.
export function playerColour(player) {
  if (player?.colour) return player.colour;
  const slot = player?.slot ?? 1;
  return PLAYER_COLOURS[(slot - 1) % PLAYER_COLOURS.length];
}

// ---- real-name "subnames" behind the gamertags ----
// Keyed by a normalised handle (lowercase, alphanumerics only) so it survives
// apostrophes/spacing. Returns the short real name, or null if unknown.
const SUBNAMES = {
  seandonpickford: "Sean",
  straitofhormousadembele: "Joe",
  thomastwoshell: "Geo",
  nicoolgilly: "Pete",
  kluiverteye: "Logan",
  storyoftheharrykane: "Barney",
};
const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function playerSubname(player) {
  return SUBNAMES[normName(player?.name)] || null;
}

// ---- "who am I" (no login; just a remembered player id) ----
const IDENTITY_KEY = "sweepsnake_player_id";
export const getIdentity = () => localStorage.getItem(IDENTITY_KEY);
export const setIdentity = (id) => localStorage.setItem(IDENTITY_KEY, id);
export const clearIdentity = () => localStorage.removeItem(IDENTITY_KEY);

// ---- one call to fetch everything a page needs ----
export async function loadLiveData() {
  const [config, players, teams, matches] = await Promise.all([
    getConfig(), getPlayers(), getTeams(), getMatches(),
  ]);
  return { config, players, teams, matches };
}

// Show a friendly banner instead of a blank page when the backend isn't ready.
export function showError(container, err) {
  const msg = err?.code === "PGRST205" || /schema cache|does not exist/i.test(err?.message || "")
    ? "The database tables aren't set up yet. Run schema.sql in the Supabase SQL editor first."
    : (err?.message || String(err));
  container.innerHTML = "";
  container.append(el("div", { class: "panel", style: { borderColor: "#7d2b2b" } },
    el("h2", {}, "Couldn't load data"),
    el("p", { class: "muted small" }, msg)));
}

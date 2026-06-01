// index.js — landing page: see status, join by name, navigate.
import { PLAYER_COLOURS } from "./engine.js";
import { addPlayer } from "./supabase.js";
import {
  $, el, playerColour, loadLiveData, showError, getIdentity, setIdentity, clearIdentity,
} from "./app.js";

const root = $("#content");
const state = {};

start();

async function start() {
  try {
    state.data = await loadLiveData();
  } catch (e) {
    showError(root, e);
    return;
  }
  render();
}

function render() {
  const { config, players } = state.data;
  const nPlayers = Number(config.n_players) || 6;
  const status = (config.draft_status || "setup").replace(/"/g, "");
  const me = players.find((p) => p.id === getIdentity());

  root.innerHTML = "";

  // Status strip
  const statusLabel = {
    setup: "Setting up — waiting for the commissioner to open the draft",
    open: "Draft is OPEN",
    paused: "Draft paused",
    closed: "Draft closed — tables are live",
  }[status] || status;
  root.append(el("div", { class: "panel" },
    el("h2", {}, "Status: ", el("span", { style: { color: "var(--gold)" } }, statusLabel)),
    el("p", { class: "muted small" },
      `${players.length} / ${nPlayers} players joined · `,
      `pot £${(Number(config.stake) || 50) * nPlayers} · `,
      `${config.n_teams || 48} teams · ${config.n_rounds || 8} leagues`)));

  // Who's playing
  const list = el("div", { class: "cards" });
  for (let slot = 1; slot <= nPlayers; slot++) {
    const p = players.find((x) => x.slot === slot);
    const colour = p ? playerColour(p) : PLAYER_COLOURS[(slot - 1) % PLAYER_COLOURS.length];
    list.append(el("div", {
      class: "winner-card", style: { borderLeftColor: colour },
    },
      el("div", { class: "lg" }, `Seat ${slot}`),
      el("div", { class: "team", style: { color: p ? colour : "var(--text-faint)" } },
        p ? p.name : "— open —"),
      p && p.id === getIdentity() ? el("div", { class: "small muted" }, "that's you") : null));
  }
  root.append(el("div", { class: "panel" }, el("h2", {}, "Players"), list));

  // Join / identity
  root.append(joinPanel(me, players, nPlayers));

  // Navigation
  root.append(el("div", { class: "panel" },
    el("h2", {}, "Go to"),
    el("div", { class: "btn-row" },
      el("a", { class: "btn", href: "draft.html" }, "Draft room"),
      el("a", { class: "btn", href: "table.html" }, "League tables"),
      el("a", { class: "btn", href: "demo.html" }, "2022 demo"),
      el("a", { class: "btn", href: "admin.html" }, "Admin"))));
}

function joinPanel(me, players, nPlayers) {
  if (me) {
    return el("div", { class: "panel" },
      el("h2", {}, "You're in as ",
        el("span", { style: { color: playerColour(me) } }, me.name)),
      el("div", { class: "btn-row" },
        el("button", {
          class: "btn",
          onclick: () => { clearIdentity(); render(); },
        }, "Not you? Switch player")));
  }

  const full = players.length >= nPlayers;
  const input = el("input", {
    type: "text", placeholder: "your name", maxlength: "24",
    style: {
      background: "var(--bg-row)", color: "var(--text)",
      border: "1px solid var(--line)", borderRadius: "8px",
      padding: "8px 12px", fontSize: "0.9rem", fontFamily: "var(--ui-font)",
    },
  });
  const msg = el("p", { class: "small muted" });

  const join = async () => {
    const name = input.value.trim();
    if (!name) return;
    // Re-adopt an existing player with this name (case-insensitive).
    const existing = players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) { setIdentity(existing.id); return start(); }
    if (full) { msg.textContent = "All seats are taken — ask the commissioner."; return; }
    try {
      const slot = nextFreeSlot(players, nPlayers);
      const colour = PLAYER_COLOURS[(slot - 1) % PLAYER_COLOURS.length];
      const player = await addPlayer(name, colour, slot);
      setIdentity(player.id);
      await start();
    } catch (e) { msg.textContent = e.message; }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });

  return el("div", { class: "panel" },
    el("h2", {}, full ? "Already playing?" : "Join the sweepstake"),
    el("p", { class: "muted small" },
      full ? "All seats are filled. Enter your existing name to claim your seat on this device."
           : "Enter your name to take a seat. You can pick it back up on any device with the same name."),
    el("div", { class: "btn-row" }, input,
      el("button", { class: "btn", onclick: join }, full ? "Claim seat" : "Join")),
    msg);
}

function nextFreeSlot(players, nPlayers) {
  const taken = new Set(players.map((p) => p.slot));
  for (let s = 1; s <= nPlayers; s++) if (!taken.has(s)) return s;
  return players.length + 1;
}

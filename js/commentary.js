// commentary.js — renders the daily pundit round-ups from data/commentary.json
// (populated each morning by GitHub Actions via scripts/commentary.mjs).
import { $, el, showError } from "./app.js";

const root = $("#content");

start();

async function start() {
  let file;
  try {
    file = await fetch("data/commentary.json").then((r) => r.json());
  } catch (e) { showError(root, e); return; }
  render(file);
}

const fmtUpdated = (iso) => iso
  ? new Date(iso).toLocaleString("en-GB", {
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
    }) + " BST"
  : "";

function render(file) {
  const entries = (file.entries || []).slice().sort((a, b) => b.day_key.localeCompare(a.day_key));
  root.innerHTML = "";

  root.append(el("div", { class: "panel" },
    el("h2", { style: { marginBottom: "4px" } }, "📣 The Daily Reckoning"),
    el("p", { class: "muted small", style: { margin: 0 } },
      "A pundit's take on every game day — what each result means for the country, and for whichever of us was unlucky enough to draft them. ",
      "Updates each morning once the overnight games are in.",
      file.updated_at ? el("span", {}, ` Last updated ${fmtUpdated(file.updated_at)}.`) : null)));

  if (!entries.length) {
    root.append(el("div", { class: "panel" },
      el("p", { class: "muted small" }, "No round-ups yet — check back after the first full game day.")));
    return;
  }

  for (const e of entries) {
    const article = el("article", { class: "panel commentary-entry" });
    article.append(
      el("div", { class: "muted small", style: { textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "2px" } }, e.date_label || ""),
      el("h3", { style: { margin: "0 0 4px" } }, e.title || "Round-up"),
      e.subtitle
        ? el("p", { class: "commentary-subtitle", style: { margin: "0 0 12px", fontStyle: "italic", color: "var(--text-dim)" } }, e.subtitle)
        : null,
    );
    const body = el("div", { class: "commentary-body" });
    body.innerHTML = e.html || "";
    article.append(body);
    root.append(article);
  }
}

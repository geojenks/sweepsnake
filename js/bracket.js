// bracket.js — the animated radial knockout bracket (the media/knockout_circle
// graphic, brought to life). Pure & dependency-free: it only reads data passed in
// (the static fixtures skeleton + a live `matches` overlay) and draws an SVG. Each
// team's flag sits on the ring it has actually climbed to; winners travel inward
// along the bracket line each round, losers dim (but stay recognisable) with their
// score over the flag. A transport bar replays the knockout game by game.
//
// One engine, two variants, driven by options:
//   • generic / public  — no `players` -> no rings, no legend.
//   • sweepsnake         — pass `players` + `ownerOf` -> a thick owner-colour ring
//                          per flag and a corner legend that focuses a player.
//
// Geometry is computed from the bracket tree (final M104 at the centre, depth 5,
// 32 entrant leaves on the outer ring). An in-order DFS over that tree assigns the
// leaves their angular slots, keeping the layout planar (no crossing lines).

// FIFA 3-letter code (teams.json `tla`) -> flagcdn ISO code, for circular flag
// badges (regional-indicator emoji don't render as flags on Windows/Chrome).
const TLA_TO_ISO2 = {
  FRA: "fr", ESP: "es", ARG: "ar", ENG: "gb-eng", POR: "pt", BRA: "br",
  NED: "nl", MAR: "ma", BEL: "be", GER: "de", CRO: "hr", COL: "co",
  SEN: "sn", MEX: "mx", USA: "us", URY: "uy", JPN: "jp", SUI: "ch",
  IRN: "ir", TUR: "tr", ECU: "ec", AUT: "at", KOR: "kr", AUS: "au",
  ALG: "dz", EGY: "eg", CAN: "ca", NOR: "no", PAN: "pa", CIV: "ci",
  SWE: "se", PAR: "py", CZE: "cz", SCO: "gb-sct", TUN: "tn", COD: "cd",
  UZB: "uz", QAT: "qa", IRQ: "iq", RSA: "za", KSA: "sa", JOR: "jo",
  BIH: "ba", CPV: "cv", GHA: "gh", CUW: "cw", HAI: "ht", NZL: "nz",
};

const SVGNS = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

// ---- tiny element helpers (own copies so the module stays standalone) ----
function s(tag, attrs = {}, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.setAttribute("class", v);
    else n.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

// ---- layout constants ----
const SIZE = 1000, CX = 500, CY = 500;
const RING_R = [430, 344, 258, 172, 86, 0]; // ring 0 = outer entrants … 5 = champion (centre)
const STAGE_RING = { LAST_32: 1, LAST_16: 2, QUARTER_FINALS: 3, SEMI_FINALS: 4, FINAL: 5 };
const ROOT = 104;            // the Final
const N_LEAVES = 32;
const BADGE_R = 23;
const ANIM_MS = 750;
const PLAY_MS = 1500;        // autoplay cadence: one game every 1.5s

// opacity levels
const OP_ALIVE = 1, OP_ELIM = 0.6, OP_DIM = 0.32, OP_FOCUS_ELIM = 0.92;

const polar = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
};
// Leaf i across the circle; offset by -90° so the final splits into left/right halves.
const angForIdx = (i) => -90 + (i + 0.5) * (360 / N_LEAVES);
const reduceMotion = () =>
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Render the radial bracket into `container`.
 * opts = { fixtures, meta, dbById, players?, ownerOf? }
 *  - fixtures : parsed wc2026_fixtures.json (uses .knockout)
 *  - meta     : Map teamId -> { name, flag, tla, ... }
 *  - dbById   : Map matchId -> live `matches` row
 *  - players  : optional [{ id, name, colour }] -> owner rings + focus legend
 *  - ownerOf  : optional (teamId) -> playerId | null
 *  - tierOf   : optional (teamId) -> draft tier (1 = strongest) -> league filter
 */
export function renderRadialBracket(container, opts) {
  const { fixtures, meta, dbById, players, ownerOf, tierOf } = opts;
  const ko = fixtures.knockout.filter((m) => m.stage !== "THIRD_PLACE");
  const byNo = new Map(ko.map((m) => [m.matchNo, m]));
  const playerById = new Map((players || []).map((p) => [p.id, p]));
  const colourOf = (tid) => {
    if (!ownerOf) return null;
    const p = playerById.get(ownerOf(tid));
    return p ? p.colour : null;
  };

  // ---- build the tree: DFS to order the 32 entrant leaves ----
  const leaves = []; // { key, matchNo, side, slot }
  (function dfs(no) {
    const m = byNo.get(no);
    for (const side of ["home", "away"]) {
      const slot = m[side];
      if (slot.type === "matchWinner") dfs(slot.match);
      else leaves.push({ key: `${no}.${side}`, matchNo: no, side, slot });
    }
  })(ROOT);
  const leafIdx = new Map(leaves.map((l, i) => [l.key, i]));

  // Mean leaf-index of every match node -> its angle.
  const meanIdx = new Map();
  (function calc(no) {
    const m = byNo.get(no);
    const idxs = ["home", "away"].map((side) => {
      const slot = m[side];
      return slot.type === "matchWinner" ? calc(slot.match) : leafIdx.get(`${no}.${side}`);
    });
    const mean = idxs.reduce((a, b) => a + b, 0) / idxs.length;
    meanIdx.set(no, mean);
    return mean;
  })(ROOT);

  // ---- geometry ----
  function nodeGeom(node) {
    if (node.type === "leaf") {
      const a = angForIdx(leafIdx.get(node.key));
      return { ...polar(RING_R[0], a), ring: 0, ang: a };
    }
    const ring = STAGE_RING[byNo.get(node.no).stage];
    const a = angForIdx(meanIdx.get(node.no));
    return { ...polar(RING_R[ring], a), ring, ang: a };
  }
  const childNode = (no, side) => {
    const slot = byNo.get(no)[side];
    return slot.type === "matchWinner" ? { type: "match", no: slot.match } : { type: "leaf", key: `${no}.${side}` };
  };
  // Bracket line / climb trajectory from a child node inward to its parent match.
  function connectorPath(no, side) {
    const c = nodeGeom(childNode(no, side));
    const p = nodeGeom({ type: "match", no });
    const pr = RING_R[p.ring];
    if (pr < 1) return `M ${c.x} ${c.y} L ${p.x} ${p.y}`; // parent at centre (the Final)
    const elbow = polar(pr, c.ang);
    const sweep = p.ang > c.ang ? 1 : 0;
    return `M ${c.x} ${c.y} L ${elbow.x} ${elbow.y} A ${pr} ${pr} 0 0 ${sweep} ${p.x} ${p.y}`;
  }

  // ---- svg scaffold ----
  const svg = s("svg", { class: "bracket", viewBox: `0 0 ${SIZE} ${SIZE}`, role: "img",
    "aria-label": "World Cup 2026 knockout bracket" });
  const lineLayer = s("g", { class: "bk-lines" });
  const phLayer = s("g", { class: "bk-ph-layer" });
  const flagLayer = s("g", { class: "bk-flags" });

  const pathEls = new Map();
  for (const m of ko) {
    for (const side of ["home", "away"]) {
      const p = s("path", { class: "bk-line", d: connectorPath(m.matchNo, side) });
      pathEls.set(`${m.matchNo}.${side}`, p);
      lineLayer.append(p);
    }
  }
  lineLayer.append(s("text", { class: "bk-trophy", x: CX, y: CY,
    "text-anchor": "middle", "dominant-baseline": "central" }, "🏆"));

  svg.append(lineLayer, phLayer, flagLayer);

  // ---- live data: resolve entrants + list finished knockout games ----
  const dbOf = (no) => dbById.get(byNo.get(no).id);
  const finishedDb = (no) => {
    const d = dbOf(no);
    return d && d.status === "FINISHED" && d.home_score != null ? d : null;
  };
  const winSide = (d) =>
    d.winner === "HOME" ? "home" : d.winner === "AWAY" ? "away" : d.home_score > d.away_score ? "home" : "away";

  const leafTeam = new Map();
  for (const l of leaves) {
    const d = dbOf(l.matchNo);
    leafTeam.set(l.key, d ? (l.side === "home" ? d.home_team_id : d.away_team_id) : null);
  }
  const games = ko.filter((m) => finishedDb(m.matchNo)).sort((a, b) => a.utcDate.localeCompare(b.utcDate));

  // ---- placeholder nodes for unresolved entrants ----
  const shortSlot = (slot) =>
    slot.type === "winner" ? `1${slot.group}` :
    slot.type === "runner" ? `2${slot.group}` :
    slot.type === "third" ? "3rd" : "?";
  for (const l of leaves) {
    if (leafTeam.get(l.key) != null) continue;
    const g = nodeGeom({ type: "leaf", key: l.key });
    phLayer.append(s("g", { class: "bf-ph", transform: `translate(${g.x} ${g.y})` },
      s("circle", { r: BADGE_R, class: "bf-ph-c" }),
      s("text", { class: "bf-ph-t", "text-anchor": "middle", "dominant-baseline": "central" }, shortSlot(l.slot))));
  }

  // ---- one persistent flag badge per team ----
  const flagEls = new Map();    // teamId -> <g>
  const scoreEls = new Map();   // teamId -> <text> (score overlay)
  const allTeams = [...new Set([...leafTeam.values()].filter((t) => t != null))];
  for (const tid of allTeams) {
    const m = meta.get(tid) || {};
    const g = s("g", { class: "bf", "data-team": tid });
    if (ownerOf) { const pid = ownerOf(tid); if (pid != null) g.setAttribute("data-player", pid); }
    g.append(s("title", {}, m.name || tid));

    const colour = colourOf(tid);
    if (colour) g.append(s("circle", { r: BADGE_R + 4, class: "bf-owner", cx: 0, cy: 0, stroke: colour }));
    g.append(s("circle", { r: BADGE_R + 1, class: "bf-ring", cx: 0, cy: 0 }));

    const iso = TLA_TO_ISO2[m.tla];
    const scoreText = s("text", { class: "bf-score-text", "text-anchor": "middle", "dominant-baseline": "central" });
    const score = s("g", { class: "bf-score" },
      s("circle", { r: BADGE_R, cx: 0, cy: 0, class: "bf-score-bg" }), scoreText);

    if (iso) {
      const clipId = `bkclip-${tid}`;
      g.append(s("clipPath", { id: clipId }, s("circle", { r: BADGE_R, cx: 0, cy: 0 })));
      const img = s("image", { x: -BADGE_R, y: -BADGE_R, width: 2 * BADGE_R, height: 2 * BADGE_R,
        "clip-path": `url(#${clipId})`, preserveAspectRatio: "xMidYMid slice" });
      const url = `https://flagcdn.com/h120/${iso}.png`;
      img.setAttribute("href", url);
      img.setAttributeNS(XLINK, "href", url);
      img.addEventListener("error", () => {
        img.remove();
        g.insertBefore(s("text", { class: "bf-emoji", "text-anchor": "middle", "dominant-baseline": "central" }, m.flag || ""), score);
      });
      g.append(img);
    } else {
      g.append(s("text", { class: "bf-emoji", "text-anchor": "middle", "dominant-baseline": "central" }, m.flag || ""));
    }

    g.append(score);
    // name label (hover + click to pin); halo via paint-order stroke for legibility
    g.append(s("text", { class: "bf-name", y: -(BADGE_R + 9), "text-anchor": "middle", "paint-order": "stroke" }, m.name || tid));
    // raise above neighbours so the name label is never clipped (SVG has no z-index)
    g.addEventListener("pointerenter", () => g.parentNode.append(g));
    g.addEventListener("click", () => { g.parentNode.append(g); g.classList.toggle("named"); });

    flagLayer.append(g);
    flagEls.set(tid, g);
    scoreEls.set(tid, scoreText);
  }

  // ---- state simulation ----
  // State after the first `count` games: where each team sits + who's out (score).
  function computeState(count) {
    const pos = new Map();   // teamId -> node
    const elim = new Map();  // teamId -> { text }
    for (const l of leaves) {
      const t = leafTeam.get(l.key);
      if (t != null) pos.set(t, { type: "leaf", key: l.key });
    }
    for (let i = 0; i < count; i++) {
      const m = games[i], d = dbOf(m.matchNo);
      const ws = winSide(d);
      const winId = ws === "home" ? d.home_team_id : d.away_team_id;
      const loseId = ws === "home" ? d.away_team_id : d.home_team_id;
      pos.set(winId, { type: "match", no: m.matchNo });
      const ls = ws === "home" ? d.away_score : d.home_score;
      const wsc = ws === "home" ? d.home_score : d.away_score;
      let text = `${ls}–${wsc}`;
      if (d.match_type === "PENALTIES" && d.pen_home != null) {
        const lp = ws === "home" ? d.pen_away : d.pen_home;
        const wp = ws === "home" ? d.pen_home : d.pen_away;
        text += ` (p ${lp}–${wp})`;
      }
      elim.set(loseId, { text });
    }
    return { pos, elim };
  }

  // ---- highlight pass (elim dim + optional player / league focus) ----
  // Two independent filters that intersect: a team is "in focus" only if it
  // satisfies every active filter. League L follows the sweepstake model
  // (tier >= L: L8 = tier 8 only, L1 = everyone).
  const selectedPlayers = new Set();
  let selectedLeague = null;
  const filterActive = () => selectedPlayers.size > 0 || selectedLeague != null;
  function inFocus(tid) {
    if (selectedPlayers.size) {
      const pid = ownerOf ? ownerOf(tid) : null;
      if (pid == null || !selectedPlayers.has(pid)) return false;
    }
    if (selectedLeague != null) {
      const t = tierOf ? tierOf(tid) : null;
      if (t == null || t < selectedLeague) return false;
    }
    return true;
  }
  function applyHighlight() {
    const active = filterActive();
    for (const [tid, g] of flagEls) {
      if (g.style.display === "none") continue;
      const elim = g.classList.contains("elim");
      let op = elim ? OP_ELIM : OP_ALIVE;
      if (active) {
        if (inFocus(tid)) { if (elim) op = OP_FOCUS_ELIM; }
        else op *= OP_DIM;
      }
      g.style.opacity = op;
    }
  }

  // ---- rendering a state ----
  const setXY = (g, x, y) => g.setAttribute("transform", `translate(${x} ${y})`);
  function animateAlong(g, pathEl, onDone) {
    if (!pathEl || reduceMotion()) { onDone(); return; }
    const total = pathEl.getTotalLength();
    const t0 = performance.now();
    g.classList.add("animating");
    g.parentNode.append(g); // raise above siblings while travelling
    (function frame(now) {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const pt = pathEl.getPointAtLength(e * total);
      setXY(g, pt.x, pt.y);
      if (t < 1) requestAnimationFrame(frame);
      else { g.classList.remove("animating"); onDone(); }
    })(t0);
  }

  let cur = games.length; // current notch; default = live (all games applied)

  function applyState(count, animate) {
    const st = computeState(count);
    pathEls.forEach((el) => el.classList.remove("live"));
    for (let i = 0; i < count; i++) {
      const m = games[i];
      pathEls.get(`${m.matchNo}.${winSide(dbOf(m.matchNo))}`)?.classList.add("live");
    }
    for (const [tid, g] of flagEls) {
      const node = st.pos.get(tid);
      if (!node) { g.style.display = "none"; continue; }
      g.style.display = "";
      const out = st.elim.has(tid);
      g.classList.toggle("elim", out);
      if (out) scoreEls.get(tid).textContent = st.elim.get(tid).text;
      const geom = nodeGeom(node);
      if (animate && animate.team === tid) {
        animateAlong(g, pathEls.get(animate.pathKey), () => setXY(g, geom.x, geom.y));
      } else {
        setXY(g, geom.x, geom.y);
      }
    }
    applyHighlight();
  }

  // ---- assemble ----
  const wrap = h("div", { class: "bracket-wrap" });
  wrap.append(svg);

  // focus legend — players (top-left). Sweepsnake variant only.
  if (players && players.length) {
    const legend = h("div", { class: "bk-legend bk-legend--players" });
    legend.append(h("div", { class: "bk-legend-title" }, "Players"));
    for (const p of players) {
      const item = h("button", { class: "bk-legend-item", "data-player": p.id, title: `Focus ${p.name}` },
        h("span", { class: "bk-swatch", style: { background: p.colour } }),
        h("span", { class: "bk-legend-name" }, p.name));
      item.addEventListener("click", () => {
        if (selectedPlayers.has(p.id)) { selectedPlayers.delete(p.id); item.classList.remove("is-sel"); }
        else { selectedPlayers.add(p.id); item.classList.add("is-sel"); }
        wrap.classList.toggle("has-sel", filterActive());
        applyHighlight();
      });
      legend.append(item);
    }
    wrap.append(legend);
  }

  // league/tier filter (top-right) — compact number grid; single-select toggle.
  if (tierOf) {
    const tiers = [...new Set(allTeams.map((t) => tierOf(t)).filter((t) => t != null))];
    const maxTier = tiers.length ? Math.max(...tiers) : 0;
    if (maxTier > 1) {
      const legend = h("div", { class: "bk-legend bk-legend--leagues" });
      legend.append(h("div", { class: "bk-legend-title" }, "Leagues"));
      const grid = h("div", { class: "bk-leagues-grid" });
      const btns = [];
      for (let L = 1; L <= maxTier; L++) {
        const label = L === 1 ? "League 1 · all teams" : `League ${L} · tiers ${L}–${maxTier}`;
        const b = h("button", { class: "bk-league-btn", title: label, "aria-label": label }, L);
        b.addEventListener("click", () => {
          selectedLeague = selectedLeague === L ? null : L;
          btns.forEach((x, i) => x.classList.toggle("is-sel", selectedLeague === i + 1));
          wrap.classList.toggle("has-sel", filterActive());
          applyHighlight();
        });
        btns.push(b);
        grid.append(b);
      }
      legend.append(grid);
      wrap.append(legend);
    }
  }

  if (games.length) {
    const range = h("input", { type: "range", min: 0, max: games.length, value: games.length, step: 1, class: "bk-range",
      "aria-label": "Knockout game" });
    const label = h("div", { class: "bk-label small muted" });
    const btn = (txt, on, title) => h("button", { class: "btn bk-tbtn", onclick: on, title }, txt);

    const teamName = (id) => (meta.get(id) || {}).name || id;
    function updateLabel(v) {
      if (v === 0) { label.textContent = "Before the knockout · play ▶ or step through each game"; return; }
      const m = games[v - 1], d = dbOf(m.matchNo);
      const live = v === games.length ? "  ·  latest" : "";
      label.textContent = `M${m.matchNo}: ${teamName(d.home_team_id)} ${d.home_score}–${d.away_score} ${teamName(d.away_team_id)}   (${v}/${games.length})${live}`;
    }
    function setNotch(v) {
      v = Math.max(0, Math.min(games.length, v));
      if (v === cur) { updateLabel(v); return; }
      const forward = v === cur + 1;
      range.value = v;
      if (forward) {
        const m = games[v - 1], d = dbOf(m.matchNo), ws = winSide(d);
        const winId = ws === "home" ? d.home_team_id : d.away_team_id;
        applyState(v, { team: winId, pathKey: `${m.matchNo}.${ws}` });
      } else {
        applyState(v);
      }
      cur = v;
      updateLabel(v);
    }

    // autoplay
    let timer = null;
    const playBtn = btn("▶", togglePlay, "Play");
    function stopPlay() { if (timer) { clearInterval(timer); timer = null; playBtn.textContent = "▶"; playBtn.title = "Play"; } }
    function startPlay() {
      if (cur >= games.length) setNotch(0);
      playBtn.textContent = "⏸"; playBtn.title = "Pause";
      timer = setInterval(() => { if (cur >= games.length) { stopPlay(); return; } setNotch(cur + 1); }, PLAY_MS);
    }
    function togglePlay() { timer ? stopPlay() : startPlay(); }
    const jump = (v) => { stopPlay(); setNotch(v); };

    range.addEventListener("input", () => { stopPlay(); setNotch(+range.value); });
    const controls = h("div", { class: "bracket-controls" },
      btn("⏮", () => jump(0), "Back to start"),
      btn("⟨", () => jump(cur - 1), "Previous game"),
      playBtn,
      btn("⟩", () => jump(cur + 1), "Next game"),
      btn("⏭", () => jump(games.length), "Jump to latest"),
      range);
    wrap.append(controls, label);
    container.append(wrap);
    applyState(games.length);   // render live state (must be in the DOM for path lengths)
    updateLabel(games.length);
  } else {
    wrap.append(h("p", { class: "muted small", style: { textAlign: "center", margin: "10px 0 0" } },
      "The knockout hasn’t kicked off yet — flags will climb toward the centre as results come in."));
    container.append(wrap);
    applyState(0);
  }
}

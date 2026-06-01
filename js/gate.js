// gate.js — a soft, site-wide password gate. Import this first on every page.
//
// NOT real security: the site is fully static, so a determined visitor can read
// the source or query Supabase directly. This just keeps casual people out and
// matches the app's open-by-design posture. The password is stored as a SHA-256
// hash so it isn't sitting in plain text in the source.

const PASSWORD_HASH = "281e910c7c4def49a9a80f4ca2879c0a39139acdeccf512675e760214a6e418f";
const KEY = "sweepsnake_gate";

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (localStorage.getItem(KEY) !== PASSWORD_HASH) {
  buildOverlay();
}

function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "gate";
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "9999",
    background: "radial-gradient(900px 500px at 50% -150px, #16202c 0%, #0d1117 60%)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: '"Inter", -apple-system, "Segoe UI", Roboto, sans-serif',
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    background: "#161b22", border: "1px solid #232c38", borderRadius: "14px",
    padding: "32px 28px", width: "min(360px, 90vw)", textAlign: "center",
    color: "#e6edf3", boxShadow: "0 20px 60px rgba(0,0,0,.5)",
  });
  card.innerHTML = `
    <div style="font-size:1.6rem;font-weight:800;letter-spacing:-.02em;margin-bottom:6px">
      🐍 Sweep<span style="color:#d9b44a">snake</span></div>
    <div style="color:#8b98a8;font-size:.88rem;margin-bottom:18px">Enter the password to continue</div>
    <input id="gate-input" type="password" placeholder="password" autocomplete="off"
      style="width:100%;background:#11161d;color:#e6edf3;border:1px solid #232c38;border-radius:8px;
             padding:10px 12px;font-size:.95rem;outline:none;margin-bottom:10px" />
    <button id="gate-btn"
      style="width:100%;background:#d9b44a;color:#1a1407;border:none;border-radius:8px;
             padding:10px;font-weight:700;font-size:.9rem;cursor:pointer">Enter</button>
    <div id="gate-err" style="color:#e63946;font-size:.82rem;height:1.1em;margin-top:8px"></div>`;

  overlay.appendChild(card);
  // Block the rest of the page until the gate is ready.
  (document.body || document.documentElement).appendChild(overlay);

  const input = card.querySelector("#gate-input");
  const err = card.querySelector("#gate-err");
  const submit = async () => {
    const hash = await sha256(input.value);
    if (hash === PASSWORD_HASH) {
      localStorage.setItem(KEY, PASSWORD_HASH);
      overlay.remove();
    } else {
      err.textContent = "Wrong password";
      input.value = "";
      card.animate(
        [{ transform: "translateX(-6px)" }, { transform: "translateX(6px)" }, { transform: "translateX(0)" }],
        { duration: 180 });
    }
  };
  card.querySelector("#gate-btn").addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  input.focus();
}

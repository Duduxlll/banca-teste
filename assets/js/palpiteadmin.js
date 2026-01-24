(() => {
  const API = window.location.origin;
  const qs = (s, r = document) => r.querySelector(s);

  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));

  const KEY = (() => {
    const u = new URL(window.location.href);
    return (u.searchParams.get("key") || "").trim();
  })();

  const el = {
    err: qs("#overlayError"),

    sub: qs("#ovSub"),
    status: qs("#ovStatus"),
    buy: qs("#ovBuy"),
    total: qs("#ovTotal"),

    winnersHint: qs("#ovWinnersHint"),
    winners: qs("#ovWinners"),

    toastHost: qs("#ovToastHost"),
  };

  function showError(msg) {
    if (!el.err) return console.error(msg);
    el.err.style.display = "block";
    el.err.innerHTML = esc(msg);
  }

  if (!KEY) {
    showError("Falta a key na URL. Use: /palpite-overlay.html?key=SUA_APP_PUBLIC_KEY");
  }

  const fmtBRL = (cents) => {
    const n = Number(cents || 0);
    return (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  };

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function setStatus(isOpen) {
    if (!el.status) return;
    el.status.textContent = isOpen ? "ABERTO" : "FECHADO";
    el.status.classList.toggle("ov-status--open", !!isOpen);
    el.status.classList.toggle("ov-status--closed", !isOpen);
  }

  function setSub(text) {
    if (el.sub) el.sub.textContent = text;
  }

  function renderHeader(state) {
    setStatus(!!state?.isOpen);

    if (el.buy) el.buy.textContent = state?.buyValueCents ? fmtBRL(state.buyValueCents) : "—";
    if (el.total) el.total.textContent = String(state?.total ?? 0);

    if (!state?.roundId) {
      setSub("Nenhuma rodada ativa…");
    } else if (state?.isOpen) {
      setSub("Rodada aberta — mande o valor no chat!");
    } else {
      setSub("Rodada fechada — aguardando abrir…");
    }
  }

  function normalizeWinner(w) {
    const name = w?.name ?? w?.user ?? w?.nome ?? "—";

    const valueCents =
      w?.valueCents != null ? Number(w.valueCents) :
      w?.guessCents != null ? Number(w.guessCents) :
      w?.value != null ? Math.round(Number(w.value) * 100) :
      w?.guess != null ? Math.round(Number(w.guess) * 100) :
      0;

    const deltaCents =
      w?.deltaCents != null ? Number(w.deltaCents) :
      w?.diffCents != null ? Number(w.diffCents) :
      w?.delta != null ? Math.round(Number(w.delta) * 100) :
      w?.diff != null ? Math.round(Number(w.diff) * 100) :
      null;

    return { name, valueCents, deltaCents };
  }

  function renderWinners(state) {
    if (!el.winners) return;

    const winnersCount = clamp(Number(state?.winnersCount || 3), 1, 3);

    const winnersRaw =
      Array.isArray(state?.winners) ? state.winners :
      Array.isArray(state?.topWinners) ? state.topWinners :
      [];

    const winners = winnersRaw.map(normalizeWinner).slice(0, winnersCount);

    if (!winners.length) {
      if (el.winnersHint) el.winnersHint.textContent = "Aguardando verificação…";
      el.winners.innerHTML = Array.from({ length: winnersCount }).map((_, i) => `
        <div class="ov-win">
          <div class="ov-win-left">
            <div class="ov-rank">#${i + 1}</div>
            <div class="ov-name">—</div>
          </div>
          <div class="ov-win-right">
            <div class="ov-val">—</div>
            <div class="ov-delta"></div>
          </div>
        </div>
      `).join("");
      return;
    }

    const actual = state?.actualResultCents != null ? fmtBRL(state.actualResultCents) : null;
    if (el.winnersHint) {
      el.winnersHint.textContent = actual ? `Resultado real: ${actual}` : `Top ${winnersCount}`;
    }

    el.winners.innerHTML = winners.map((w, i) => `
      <div class="ov-win">
        <div class="ov-win-left">
          <div class="ov-rank">#${i + 1}</div>
          <div class="ov-name">${esc(w.name)}</div>
        </div>

        <div class="ov-win-right">
          <div class="ov-val">${fmtBRL(w.valueCents)}</div>
          ${w.deltaCents != null ? `<div class="ov-delta">± ${fmtBRL(w.deltaCents)}</div>` : `<div class="ov-delta"></div>`}
        </div>
      </div>
    `).join("");
  }

  let toastTimer = null;
  let lastToastEl = null;

  function showGuessToast(user, guessCents) {
    if (!el.toastHost) return;

    if (toastTimer) clearTimeout(toastTimer);
    if (lastToastEl) {
      lastToastEl.classList.add("hide");
      setTimeout(() => lastToastEl?.remove(), 240);
      lastToastEl = null;
    }

    const div = document.createElement("div");
    div.className = "ov-toast";
    div.innerHTML = `
      <div class="t-left">
        <div class="t-name">${esc(user || "—")}</div>
        <div class="t-sub">Entrou no palpite</div>
      </div>
      <div class="t-val">${fmtBRL(guessCents || 0)}</div>
    `;

    el.toastHost.appendChild(div);
    lastToastEl = div;

    toastTimer = setTimeout(() => {
      div.classList.add("hide");
      setTimeout(() => div.remove(), 240);
      if (lastToastEl === div) lastToastEl = null;
    }, 3000);
  }

  async function fetchStatePublic() {
    if (!KEY) return null;
    const res = await fetch(`${API}/api/palpite/state-public?key=${encodeURIComponent(KEY)}`, {
      method: "GET",
      credentials: "include",
      headers: { "Accept": "application/json" }
    });
    if (!res.ok) return null;
    return res.json();
  }

  let lastWinnersKey = "";
  let lastHeaderKey = "";
  let sseAlive = false;
  let pollTimer = null;
  let syncLock = false;

  async function syncFullState() {
    if (syncLock) return;
    syncLock = true;

    try {
      const st = await fetchStatePublic();
      if (!st) return;

      const headerKey = JSON.stringify({
        isOpen: !!st.isOpen,
        buyValueCents: st.buyValueCents ?? null,
        total: st.total ?? null,
        roundId: st.roundId ?? null
      });

      if (headerKey !== lastHeaderKey) {
        lastHeaderKey = headerKey;
        renderHeader(st);
      }

      const winnersKey = JSON.stringify({
        winnersCount: st.winnersCount ?? 3,
        actualResultCents: st.actualResultCents ?? null,
        winners: Array.isArray(st.winners) ? st.winners : []
      });

      if (winnersKey !== lastWinnersKey) {
        lastWinnersKey = winnersKey;
        renderWinners(st);
      }
    } finally {
      syncLock = false;
    }
  }

  let es = null;

  function connectSSE() {
    if (!KEY) return;

    if (es) { try { es.close(); } catch {} es = null; }

    es = new EventSource(`${API}/api/palpite/stream?key=${encodeURIComponent(KEY)}`);

    sseAlive = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

    const onStateAny = async () => { await syncFullState(); };

    es.addEventListener("palpite-init", onStateAny);
    es.addEventListener("palpite-open", onStateAny);
    es.addEventListener("palpite-close", onStateAny);
    es.addEventListener("palpite-clear", onStateAny);
    es.addEventListener("palpite-winners", onStateAny);

    es.addEventListener("state", onStateAny);
    es.addEventListener("winners", onStateAny);

    const onGuessAny = (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        const entry = data.entry || data;

        const name = entry.user || entry.name || entry.nome || "—";

        const guessCents =
          entry.guessCents != null ? Number(entry.guessCents) :
          (entry.value != null ? Math.round(Number(entry.value) * 100) :
          (entry.guess != null ? Math.round(Number(entry.guess) * 100) : 0));

        showGuessToast(name, guessCents);

        if (el.total) {
          const hinted = data.total ?? data.totalGuesses ?? data.totalHint;
          if (hinted != null) el.total.textContent = String(hinted);
          else el.total.textContent = String((Number(el.total.textContent || 0) || 0) + 1);
        }
      } catch {}
    };

    es.addEventListener("palpite-guess", onGuessAny);
    es.addEventListener("guess", onGuessAny);

    es.onerror = () => {
      try { es.close(); } catch {}
      es = null;

      sseAlive = false;
      if (!pollTimer) pollTimer = setInterval(syncFullState, 2500);

      setTimeout(connectSSE, 1500);
    };
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await syncFullState();
    connectSSE();

    pollTimer = setInterval(() => {
      if (!sseAlive) syncFullState();
    }, 2500);
  });
})();

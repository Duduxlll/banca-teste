(() => {
  const API = window.location.origin;
  const qs = (s, r = document) => r.querySelector(s);

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/([$?*|{}\\^])/g, "\\$1") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function apiFetch(path, opts = {}) {
    if (typeof window.apiFetch === "function") return window.apiFetch(path, opts);

    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const method = (opts.method || "GET").toUpperCase();

    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      const csrf = getCookie("csrf");
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }

    const res = await fetch(`${API}${path}`, { credentials: "include", ...opts, headers });
    if (!res.ok) {
      let err;
      try { err = await res.json(); } catch {}
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  function ensureToastEl() {
    let el = document.querySelector("#appToast");
    if (el) return el;
    el = document.createElement("div");
    el.id = "appToast";
    el.className = "toast";
    document.body.appendChild(el);
    return el;
  }

  function toast(msg, type = "ok") {
    const el = ensureToastEl();
    el.textContent = String(msg || "");
    el.classList.remove("show", "toast--ok", "toast--error", "toast--info");
    const t = type === "error" ? "toast--error" : type === "info" ? "toast--info" : "toast--ok";
    el.classList.add(t);
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  if (typeof window.notify !== "function") {
    window.notify = (msg, type) => {
      const v = String(type || "ok").toLowerCase();
      if (v === "error" || v === "no" || v === "bad") return toast(msg, "error");
      if (v === "info") return toast(msg, "info");
      return toast(msg, "ok");
    };
  }

  const esc = (s = "") => String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  function ensureUI() {
    const tab = qs("#tab-torneio");
    if (!tab) return null;
    if (qs("#trRoot", tab)) return tab;

    tab.innerHTML = `
      <div id="trRoot" class="tr-root">

        <div class="card" style="margin-bottom:12px">
          <div class="tr-head">
            <div>
              <h2 style="margin:0">🏟️ Torneio</h2>
              <p class="muted" style="margin:6px 0 0">Chat: <code>!time A</code> <code>!time B</code> <code>!time C</code></p>
            </div>
            <div class="tr-actions">
              <button class="btn btn--primary" id="trRefresh">Atualizar</button>
              <button class="btn btn--danger" id="trFinish">Finalizar</button>
            </div>
          </div>
          <div class="tr-line" id="trStatusLine">—</div>
        </div>

        <div class="card" style="margin-bottom:12px">
          <div class="tr-grid2">
            <div>
              <div class="muted" style="margin-bottom:6px">Criar torneio</div>
              <div class="tr-form">
                <input id="trName" class="input" placeholder="Nome do torneio">
                <input id="trA" class="input" placeholder="Nome do time A">
                <input id="trB" class="input" placeholder="Nome do time B">
                <input id="trC" class="input" placeholder="Nome do time C">
                <button class="btn btn--primary" id="trStart">Iniciar (fase 1)</button>
              </div>
              <div class="muted" style="margin-top:8px;font-size:.85rem">A fase 1 inicia aberta.</div>
            </div>

            <div>
              <div class="muted" style="margin-bottom:6px">Abrir próxima fase</div>
              <div class="tr-form">
                <input id="trNA" class="input" placeholder="Nome do time A">
                <input id="trNB" class="input" placeholder="Nome do time B">
                <input id="trNC" class="input" placeholder="Nome do time C">
                <button class="btn" id="trOpenNext">Abrir próxima fase</button>
              </div>
              <div class="muted" style="margin-top:8px;font-size:.85rem">Só abre a próxima fase depois de decidir a atual.</div>
            </div>
          </div>
        </div>

        <div class="tr-grid">
          <div class="card tr-card">
            <div class="tr-card-head">
              <div>
                <div class="tr-card-title" id="trTeamATitle">Time A</div>
                <div class="tr-card-sub"><span class="tr-chip" id="trCountA">0</span></div>
              </div>
              <button class="btn ghost tr-win" data-win="A">Vencedor A</button>
            </div>
            <div class="tr-list" id="trListA"></div>
          </div>

          <div class="card tr-card">
            <div class="tr-card-head">
              <div>
                <div class="tr-card-title" id="trTeamBTitle">Time B</div>
                <div class="tr-card-sub"><span class="tr-chip" id="trCountB">0</span></div>
              </div>
              <button class="btn ghost tr-win" data-win="B">Vencedor B</button>
            </div>
            <div class="tr-list" id="trListB"></div>
          </div>

          <div class="card tr-card">
            <div class="tr-card-head">
              <div>
                <div class="tr-card-title" id="trTeamCTitle">Time C</div>
                <div class="tr-card-sub"><span class="tr-chip" id="trCountC">0</span></div>
              </div>
              <button class="btn ghost tr-win" data-win="C">Vencedor C</button>
            </div>
            <div class="tr-list" id="trListC"></div>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="tr-head" style="align-items:center">
            <div>
              <h3 style="margin:0">✅ Classificados (vivos)</h3>
              <p class="muted" style="margin:6px 0 0">Quem permanece no torneio</p>
            </div>
            <button class="btn ghost" id="trCopyWinners">Copiar lista</button>
          </div>
          <div class="tr-winners" id="trWinners">—</div>
        </div>

      </div>
    `;
    return tab;
  }

  function setList(el, arr) {
    if (!el) return;
    if (!arr || !arr.length) {
      el.innerHTML = `<div class="muted" style="padding:10px">—</div>`;
      return;
    }
    el.innerHTML = arr
      .map(x => `<div class="tr-item"><span>@${esc(x.twitchName || "")}</span><strong>${esc(x.displayName || x.twitchName || "")}</strong></div>`)
      .join("");
  }

  function setWinners(el, arr) {
    if (!el) return;
    if (!arr || !arr.length) {
      el.innerHTML = `<div class="muted">—</div>`;
      return;
    }
    el.innerHTML = `<div class="tr-winner-line">${arr.map(x => `<span class="tr-pill">@${esc(x.twitchName || "")}</span>`).join(" ")}</div>`;
  }

  async function refresh() {
    const tab = ensureUI();
    if (!tab) return;

    const line = qs("#trStatusLine", tab);
    const aTitle = qs("#trTeamATitle", tab);
    const bTitle = qs("#trTeamBTitle", tab);
    const cTitle = qs("#trTeamCTitle", tab);

    const countA = qs("#trCountA", tab);
    const countB = qs("#trCountB", tab);
    const countC = qs("#trCountC", tab);

    const listA = qs("#trListA", tab);
    const listB = qs("#trListB", tab);
    const listC = qs("#trListC", tab);

    const winners = qs("#trWinners", tab);

    try {
      const data = await apiFetch("/api/torneio/admin/current", { method: "GET" });

      if (!data?.active) {
        line.textContent = "Nenhum torneio ativo.";
        aTitle.textContent = "Time A";
        bTitle.textContent = "Time B";
        cTitle.textContent = "Time C";
        countA.textContent = "0";
        countB.textContent = "0";
        countC.textContent = "0";
        setList(listA, []);
        setList(listB, []);
        setList(listC, []);
        setWinners(winners, []);
        return;
      }

      const tor = data.torneio;
      const ph = data.phase;

      if (!ph) {
        line.textContent = `Ativo: ${tor.name} • fase: ${tor.currentPhase}`;
        setWinners(winners, data.alive || []);
        return;
      }

      const st = String(ph.status || "");
      const w = ph.winnerTeam ? ` • vencedor: ${ph.winnerTeam}` : "";
      line.textContent = `Ativo: ${tor.name} • fase ${ph.number} (${st})${w}`;

      aTitle.textContent = `A • ${ph.teams?.A || "Time A"}`;
      bTitle.textContent = `B • ${ph.teams?.B || "Time B"}`;
      cTitle.textContent = `C • ${ph.teams?.C || "Time C"}`;

      countA.textContent = String(ph.counts?.A ?? 0);
      countB.textContent = String(ph.counts?.B ?? 0);
      countC.textContent = String(ph.counts?.C ?? 0);

      setList(listA, ph.lists?.A || []);
      setList(listB, ph.lists?.B || []);
      setList(listC, ph.lists?.C || []);

      setWinners(winners, data.alive || []);
    } catch (e) {
      window.notify(`Erro: ${e.message}`, "error");
    }
  }

  function bind() {
    const tab = ensureUI();
    if (!tab) return;

    qs("#trRefresh", tab)?.addEventListener("click", refresh);

    qs("#trStart", tab)?.addEventListener("click", async () => {
      const name = qs("#trName", tab).value || "Torneio";
      const teamA = qs("#trA", tab).value || "Time A";
      const teamB = qs("#trB", tab).value || "Time B";
      const teamC = qs("#trC", tab).value || "Time C";
      try {
        await apiFetch("/api/torneio/admin/start", {
          method: "POST",
          body: JSON.stringify({ name, teamA, teamB, teamC })
        });
        window.notify("Torneio iniciado.", "ok");
        await refresh();
      } catch (e) {
        window.notify(`Erro: ${e.message}`, "error");
      }
    });

    qs("#trOpenNext", tab)?.addEventListener("click", async () => {
      const teamA = qs("#trNA", tab).value || "Time A";
      const teamB = qs("#trNB", tab).value || "Time B";
      const teamC = qs("#trNC", tab).value || "Time C";
      try {
        await apiFetch("/api/torneio/admin/open-next", {
          method: "POST",
          body: JSON.stringify({ teamA, teamB, teamC })
        });
        window.notify("Próxima fase aberta.", "ok");
        await refresh();
      } catch (e) {
        window.notify(`Erro: ${e.message}`, "error");
      }
    });

    qs("#trFinish", tab)?.addEventListener("click", async () => {
      try {
        await apiFetch("/api/torneio/admin/finish", { method: "POST", body: "{}" });
        window.notify("Torneio finalizado.", "ok");
        await refresh();
      } catch (e) {
        window.notify(`Erro: ${e.message}`, "error");
      }
    });

    tab.addEventListener("click", async (e) => {
      const btn = e.target.closest("button.tr-win");
      if (!btn) return;
      const winnerTeam = btn.dataset.win;
      try {
        await apiFetch("/api/torneio/admin/decide", {
          method: "POST",
          body: JSON.stringify({ winnerTeam })
        });
        window.notify(`Vencedor: ${winnerTeam}`, "ok");
        await refresh();
      } catch (err) {
        window.notify(`Erro: ${err.message}`, "error");
      }
    });

    qs("#trCopyWinners", tab)?.addEventListener("click", async () => {
      try {
        const data = await apiFetch("/api/torneio/admin/winners?limit=2000", { method: "GET" });
        const rows = data?.rows || [];
        const text = rows.map(r => `@${r.twitchName}`).join(" ");
        await navigator.clipboard.writeText(text || "");
        window.notify("Lista copiada.", "ok");
      } catch (e) {
        window.notify("Não consegui copiar.", "error");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (qs("#tab-torneio")) {
      ensureUI();
      bind();
      refresh();
    }
  });

  window.TorneioAdmin = { refresh };
})();

(() => {
  const API = window.location.origin;
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

  function getCookie(name) {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/([$?*|{}\\^])/g, "\\$1") + "=([^;]*)")
    );
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
      try {
        err = await res.json();
      } catch {}
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

  const esc = (s = "") =>
    String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

  function injectOnce(id, css) {
    if (document.getElementById(id)) return;
    const st = document.createElement("style");
    st.id = id;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function formatTeamTitle(id, name) {
  const raw = String(name || id || "").trim();
  if (!raw) return "Time";
  if (/^time\s+/i.test(raw)) return raw; 
  const pretty = raw.charAt(0).toUpperCase() + raw.slice(1);
  return `Time ${pretty}`;
}


  function toKey(s) {
    const raw = String(s || "").trim();
    if (!raw) return "";
    const noMarks = raw.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    return noMarks.replace(/[^A-Za-z0-9_-]/g, "").toUpperCase();
  }

  function safeTeamName(s) {
    const v = String(s ?? "").trim();
    return v ? v.slice(0, 40) : "";
  }

  function normalizeTeamsInput(list) {
    const names = (list || []).map((x) => safeTeamName(x)).filter(Boolean);
    const uniq = [];
    const seen = new Set();
    for (const n of names) {
      const k = toKey(n) || n.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(n);
    }
    return uniq;
  }

  function pointsStoreKey(torneioId, phaseNumber) {
    return `tr_points_${String(torneioId || "")}_${String(phaseNumber || "")}`;
  }

  function loadPoints(torneioId, phaseNumber) {
    try {
      const raw = localStorage.getItem(pointsStoreKey(torneioId, phaseNumber));
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  function savePoints(torneioId, phaseNumber, obj) {
    try {
      localStorage.setItem(pointsStoreKey(torneioId, phaseNumber), JSON.stringify(obj || {}));
    } catch {}
  }

  let inited = false;
  let lastData = null;

  function ensureUI() {
    const tab = qs("#tab-torneio");
    if (!tab) return null;
    if (qs("#trRoot", tab)) return tab;

    injectOnce(
      "trAdminCSS",
      `
      .tr-root{display:grid;gap:12px}
      .tr-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .tr-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
      .tr-line{margin-top:8px;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04)}
      .tr-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);font-weight:800;font-size:.85rem}
      .tr-badge.ok{border-color:rgba(60,255,120,.22)}
      .tr-badge.warn{border-color:rgba(255,190,60,.22)}
      .tr-badge.bad{border-color:rgba(255,80,80,.22)}
      .tr-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
      .tr-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
      @media (max-width: 980px){.tr-grid{grid-template-columns:minmax(0,1fr)}.tr-grid2{grid-template-columns:minmax(0,1fr)}}
      .tr-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}
      .tr-card-title{font-weight:900;font-size:1.05rem}
      .tr-sub{opacity:.82;font-size:.88rem}
      .tr-chip{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:26px;padding:0 10px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);font-weight:900}
      .tr-list{max-height:320px;overflow:auto;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.12)}
      .tr-item{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06)}
      .tr-item:last-child{border-bottom:0}
      .tr-item span{opacity:.85}
      .tr-item strong{font-weight:900}
      .tr-winners{padding:10px 12px;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);min-height:42px}
      .tr-pill{display:inline-flex;gap:6px;align-items:center;padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);margin:4px 6px 0 0;font-weight:800}
      .tr-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .tr-mini{font-size:.85rem;opacity:.8}
      .tr-hr{height:1px;background:rgba(255,255,255,.08);margin:10px 0}
      .tr-team-row{display:flex;gap:8px;align-items:center}
      .tr-team-row .input{flex:1}
      .tr-team-row .btn{white-space:nowrap}
      .tr-points{display:flex;gap:8px;align-items:center}
      .tr-points input{max-width:120px}
      .tr-winnerMark{border:1px solid rgba(60,255,120,.22);background:rgba(60,255,120,.08)}
      `
    );

    tab.innerHTML = `
      <div id="trRoot" class="tr-root">

        <div class="card">
          <div class="tr-head">
            <div>
              <h2 style="margin:0">🏟️ Torneio</h2>
              <div class="tr-row" style="margin-top:6px">
                <span class="tr-badge" id="trBadge">—</span>
                <span class="tr-mini" id="trMini">—</span>
              </div>
            </div>
            <div class="tr-actions">
              <button class="btn btn--primary" id="trRefresh">Atualizar</button>
              <button class="btn" id="trClosePhase">Fechar fase</button>
              <button class="btn btn--danger" id="trFinish">Finalizar torneio</button>
            </div>
          </div>
          <div class="tr-line" id="trStatusLine">—</div>
          <div class="tr-row" style="margin-top:10px">
            <div class="tr-mini">Comandos:</div>
            <div class="tr-row" id="trCmds" style="gap:6px;flex:1"></div>
            <button class="btn btn--ghost" id="trCopyCmds">Copiar</button>
          </div>
        </div>

        <div class="card" id="trCreateCard">
          <div class="tr-head">
            <div>
              <h3 style="margin:0">Criar novo torneio</h3>
              <p class="muted" style="margin:6px 0 0">Defina o nome e os times da fase 1.</p>
            </div>
            <div class="tr-actions">
              <button class="btn" id="trAddTeamCreate">+ Time</button>
              <button class="btn btn--primary" id="trStart">Iniciar fase 1</button>
            </div>
          </div>

          <div class="tr-hr"></div>

          <div class="tr-row">
            <input id="trName" class="input" placeholder="Nome do torneio" style="flex:1">
          </div>

          <div style="margin-top:10px;display:grid;gap:8px" id="trTeamsCreate"></div>
          <div class="muted" style="margin-top:10px;font-size:.85rem" id="trCreateHint">—</div>
        </div>

        <div class="card" id="trNextCard">
          <div class="tr-head">
            <div>
              <h3 style="margin:0">Próxima fase</h3>
              <p class="muted" style="margin:6px 0 0">Só abre depois de decidir a fase atual.</p>
            </div>
            <div class="tr-actions">
              <button class="btn" id="trAddTeamNext">+ Time</button>
              <button class="btn btn--primary" id="trOpenNext">Abrir próxima fase</button>
            </div>
          </div>

          <div class="tr-hr"></div>

          <div style="display:grid;gap:8px" id="trTeamsNext"></div>
          <div class="muted" style="margin-top:10px;font-size:.85rem" id="trNextHint">—</div>
        </div>

        <div class="tr-grid" id="trTeamsGrid"></div>

        <div class="card">
          <div class="tr-head" style="align-items:center">
            <div>
              <h3 style="margin:0">✅ Classificados (vivos)</h3>
              <p class="muted" style="margin:6px 0 0">Quem permanece no torneio</p>
            </div>
            <button class="btn btn--ghost" id="trCopyWinners">Copiar lista</button>
          </div>
          <div class="tr-winners" id="trWinners">—</div>
        </div>

      </div>
    `;

    ensureTeamInputs(qs("#trTeamsCreate", tab));
    ensureTeamInputs(qs("#trTeamsNext", tab));

    return tab;
  }

  function ensureTeamInputs(container, names) {
    if (!container) return;
    const current = qsa('[data-team-input="1"]', container).map((i) => i.value);
    const base = (names && names.length ? names : current.length ? current : ["", ""]).slice(0, 12);
    container.innerHTML = "";
    for (const n of base) addTeamInputRow(container, n);
    if (qsa('[data-team-input="1"]', container).length < 2) addTeamInputRow(container, "");
  }

  function addTeamInputRow(container, value = "") {
    const row = document.createElement("div");
    row.className = "tr-team-row";
    row.innerHTML = `
      <input class="input" data-team-input="1" placeholder="Nome do time" value="${esc(value)}">
      <button class="btn btn--danger" type="button" data-team-remove="1">Remover</button>
    `;
    container.appendChild(row);
  }

  function readTeamInputs(container) {
    if (!container) return [];
    const vals = qsa('[data-team-input="1"]', container).map((i) => (i.value || "").trim());
    return normalizeTeamsInput(vals);
  }

  function setBadge(tab, kind, text) {
    const b = qs("#trBadge", tab);
    if (!b) return;
    b.classList.remove("ok", "warn", "bad");
    if (kind) b.classList.add(kind);
    b.textContent = text || "—";
  }

  function setMini(tab, text) {
    const m = qs("#trMini", tab);
    if (!m) return;
    m.textContent = text || "—";
  }

  function setCmds(tab, teams) {
    const cmds = qs("#trCmds", tab);
    if (!cmds) return;
    const list = (teams || []).map((t) => String(t.id || "").trim()).filter(Boolean);
    const out = list.length ? list : [];
    cmds.innerHTML = out.length
      ? out.map((id) => `<span class="tr-pill">!time ${esc(id)}</span>`).join("")
      : `<span class="muted">—</span>`;
  }

  function setWinners(el, arr) {
    if (!el) return;
    if (!arr || !arr.length) {
      el.innerHTML = `<div class="muted">—</div>`;
      return;
    }
    el.innerHTML = `<div>${arr.map((x) => `<span class="tr-pill">@${esc(x.twitchName || "")}</span>`).join(" ")}</div>`;
  }

  function teamsFromPhase(ph) {
    if (!ph) return [];

    if (Array.isArray(ph.teamsList) && ph.teamsList.length) {
      return ph.teamsList
        .map((t) => {
          const id = String(t?.key ?? t?.id ?? "").trim();
          if (!id) return null;
          const name = String(t?.name ?? t?.title ?? id).trim();
          const count = Number(t?.count ?? 0) || 0;
          const points = Number(t?.points ?? 0) || 0;
          const list = Array.isArray(t?.list) ? t.list : [];
          return { id, name, count, points, list };
        })
        .filter(Boolean);
    }

    if (Array.isArray(ph.teams) && ph.teams.length) {
      return ph.teams
        .map((t) => {
          const id = String(t?.key ?? t?.id ?? "").trim();
          if (!id) return null;
          const name = String(t?.name ?? t?.title ?? id).trim();
          return { id, name, count: 0, points: 0, list: [] };
        })
        .filter(Boolean);
    }

    const obj = ph.teams || {};
    const keys = Object.keys(obj);
    if (!keys.length) return [];
    return keys.map((k) => ({ id: String(k).trim(), name: String(obj[k] || "").trim(), count: 0, points: 0, list: [] })).filter((t) => t.id);
  }

  function findTeam(ph, teamId) {
    const k = String(teamId || "").trim();
    if (!k) return null;
    const arr = teamsFromPhase(ph);
    return arr.find((t) => String(t.id) === k) || null;
  }

  function countsForTeam(ph, teamId) {
    const t = findTeam(ph, teamId);
    if (t) return Number(t.count ?? 0) || 0;
    const c = ph?.counts || {};
    const k = String(teamId || "").trim();
    return Number(c?.[k] ?? 0) || 0;
  }

  function listForTeam(ph, teamId) {
    const t = findTeam(ph, teamId);
    if (t && Array.isArray(t.list)) return t.list;
    const lists = ph?.lists || {};
    const k = String(teamId || "").trim();
    const arr = lists?.[k] || [];
    return Array.isArray(arr) ? arr : [];
  }

  function pointsForTeam(ph, teamId) {
    const t = findTeam(ph, teamId);
    if (t) return Number(t.points ?? 0) || 0;
    const p = ph?.points || {};
    const k = String(teamId || "").trim();
    return Number(p?.[k] ?? 0) || 0;
  }

  function renderTeamsGrid(tab, tor, ph) {
    const grid = qs("#trTeamsGrid", tab);
    if (!grid) return;
    if (!tor || !ph) {
      grid.innerHTML = "";
      return;
    }

    const teams = teamsFromPhase(ph);
    const ptsLocal = loadPoints(tor.id, ph.number);

    grid.innerHTML = teams
      .map((t) => {
        const id = t.id;
        const title = formatTeamTitle(id, t.name);
        const count = countsForTeam(ph, id);
        const winner = String(ph.winnerTeam || "") === String(id);
        const disabledWin = String(ph.status || "") === "DECIDIDA";
        const canDecide = String(ph.status || "") !== "DECIDIDA";
        const canWinNow = canDecide;

        const serverPts = pointsForTeam(ph, id);
        const localPts = ptsLocal?.[id];
        const pval = localPts !== undefined ? localPts : serverPts ? String(serverPts) : "";

        const items = listForTeam(ph, id);
        const listHtml = items && items.length
          ? items
              .map((x) => `<div class="tr-item"><span>@${esc(x.twitchName || "")}</span><strong>${esc(x.displayName || x.twitchName || "")}</strong></div>`)
              .join("")
          : `<div class="muted" style="padding:10px">—</div>`;

        return `
          <div class="card tr-card ${winner ? "tr-winnerMark" : ""}" data-team-card="1" data-team-id="${esc(id)}">
            <div class="tr-card-head">
              <div>
                <div class="tr-card-title">${esc(title)}</div>
                <div class="tr-sub"><span class="tr-chip" data-role="count">${esc(String(count))}</span></div>
              </div>

              <div style="display:grid;gap:8px;justify-items:end">
                <div class="tr-points">
                  <span class="tr-mini">Valor</span>
                  <input class="input" data-role="points" inputmode="numeric" placeholder="0" value="${esc(String(pval))}">
                </div>
                <button class="btn btn--primary" data-action="win" data-team="${esc(id)}" ${(!canWinNow || disabledWin) ? "disabled" : ""}>
                  Definir vencedor
                </button>
              </div>
            </div>

            <div class="tr-list">${listHtml}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderHints(tab, mode) {
    const h1 = qs("#trCreateHint", tab);
    const h2 = qs("#trNextHint", tab);
    if (h1) h1.textContent = mode?.create || "—";
    if (h2) h2.textContent = mode?.next || "—";
  }

  function applyButtons(tab, state) {
    const btnClose = qs("#trClosePhase", tab);
    const btnNext = qs("#trOpenNext", tab);
    const btnStart = qs("#trStart", tab);
    const btnFinish = qs("#trFinish", tab);

    if (btnClose) btnClose.disabled = !state.canClose;
    if (btnNext) btnNext.disabled = !state.canNext;
    if (btnStart) btnStart.disabled = !state.canStart;
    if (btnFinish) btnFinish.disabled = !state.canFinish;
  }

  async function refresh() {
    const tab = ensureUI();
    if (!tab) return;

    const line = qs("#trStatusLine", tab);
    const createCard = qs("#trCreateCard", tab);
    const nextCard = qs("#trNextCard", tab);
    const winnersEl = qs("#trWinners", tab);

    try {
      const data = await apiFetch("/api/torneio/admin/current", { method: "GET" });
      lastData = data || null;

      if (!data?.active) {
        setBadge(tab, "warn", "INATIVO");
        setMini(tab, "Nenhum torneio ativo");
        if (line) line.textContent = "Nenhum torneio ativo.";
        if (createCard) createCard.style.display = "";
        if (nextCard) nextCard.style.display = "none";
        renderTeamsGrid(tab, null, null);
        setWinners(winnersEl, []);
        setCmds(tab, []);
        renderHints(tab, { create: "—", next: "—" });
        applyButtons(tab, { canClose: false, canNext: false, canStart: true, canFinish: false });
        return;
      }

      const tor = data.torneio;
      const ph = data.phase;

      const phaseNumber = ph?.number ?? tor?.currentPhase ?? null;
      const phaseStatus = String(ph?.status || "").trim();
      const winnerTeam = String(ph?.winnerTeam || "").trim();

      if (createCard) createCard.style.display = "none";
      if (nextCard) nextCard.style.display = "";

      setBadge(tab, "ok", "ATIVO");
      setMini(tab, tor?.name ? `Torneio: ${tor.name}` : "Torneio ativo");

      if (!ph) {
        if (line) line.textContent = `Ativo: ${tor?.name || "Torneio"} • fase: ${tor?.currentPhase || "—"}`;
        renderTeamsGrid(tab, tor, null);
        setWinners(winnersEl, data.alive || []);
        setCmds(tab, []);
        renderHints(tab, { create: "—", next: "Abra uma fase para aparecer os times." });
        applyButtons(tab, { canClose: false, canNext: false, canStart: false, canFinish: true });
        return;
      }

      const teams = teamsFromPhase(ph);
      setCmds(tab, teams);

      const wtxt = winnerTeam ? ` • vencedor: ${winnerTeam}` : "";
      if (line) line.textContent = `Ativo: ${tor?.name || "Torneio"} • fase ${phaseNumber} (${phaseStatus || "—"})${wtxt}`;

      renderTeamsGrid(tab, tor, ph);
      setWinners(winnersEl, data.alive || []);

      const canClose = phaseStatus === "ABERTA";
      const canNext = phaseStatus === "DECIDIDA";
      const canFinish = true;
      const canStart = false;

      applyButtons(tab, { canClose, canNext, canStart, canFinish });

      renderHints(tab, {
        create: "—",
        next: phaseStatus === "DECIDIDA" ? "Agora você pode abrir a próxima fase." : "Dica: feche a fase e depois defina o vencedor."
      });
    } catch (e) {
      window.notify(`Erro: ${e.message}`, "error");
    }
  }

  async function startTournament(tab) {
    const name = (qs("#trName", tab)?.value || "Torneio").trim() || "Torneio";
    const teams = readTeamInputs(qs("#trTeamsCreate", tab));
    const teamA = teams[0] || "Time A";
    const teamB = teams[1] || "Time B";
    const teamC = teams[2] || "Time C";
    await apiFetch("/api/torneio/admin/start", {
      method: "POST",
      body: JSON.stringify({ name, teamA, teamB, teamC, teams })
    });
    window.notify("Torneio iniciado.", "ok");
    await refresh();
  }

  async function closePhase() {
    await apiFetch("/api/torneio/admin/close", { method: "POST", body: "{}" });
    window.notify("Fase fechada.", "ok");
    await refresh();
  }

  async function decideWinner(teamId) {
    await apiFetch("/api/torneio/admin/decide", {
      method: "POST",
      body: JSON.stringify({ winnerTeam: String(teamId || "").trim() })
    });
    window.notify(`Vencedor: ${String(teamId || "").trim()}`, "ok");
    await refresh();
  }

  async function openNext(tab) {
    const teams = readTeamInputs(qs("#trTeamsNext", tab));
    const teamA = teams[0] || "Time A";
    const teamB = teams[1] || "Time B";
    const teamC = teams[2] || "Time C";
    await apiFetch("/api/torneio/admin/open-next", {
      method: "POST",
      body: JSON.stringify({ teamA, teamB, teamC, teams })
    });
    window.notify("Próxima fase aberta.", "ok");
    await refresh();
  }

  async function finishTournament() {
    await apiFetch("/api/torneio/admin/finish", { method: "POST", body: "{}" });
    window.notify("Torneio finalizado.", "ok");
    await refresh();
  }

  async function copyWinners() {
    const data = await apiFetch("/api/torneio/admin/winners?limit=2000", { method: "GET" });
    const rows = data?.rows || [];
    const text = rows.map((r) => `@${r.twitchName}`).join(" ");
    await navigator.clipboard.writeText(text || "");
    window.notify("Lista copiada.", "ok");
  }

  async function copyCmds(tab) {
    const cmds = qsa(".tr-pill", qs("#trCmds", tab) || tab).map((x) => x.textContent || "").filter(Boolean);
    const text = cmds.join(" ");
    await navigator.clipboard.writeText(text || "");
    window.notify("Comandos copiados.", "ok");
  }

  function bind() {
    const tab = ensureUI();
    if (!tab) return;

    tab.addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      const id = btn.id || "";
      const action = btn.dataset?.action || "";

      try {
        if (id === "trRefresh") return await refresh();
        if (id === "trStart") return await startTournament(tab);
        if (id === "trClosePhase") return await closePhase();
        if (id === "trOpenNext") return await openNext(tab);
        if (id === "trFinish") return await finishTournament();
        if (id === "trCopyWinners") return await copyWinners();
        if (id === "trCopyCmds") return await copyCmds(tab);

        if (id === "trAddTeamCreate") {
          const box = qs("#trTeamsCreate", tab);
          if (!box) return;
          if (qsa('[data-team-input="1"]', box).length >= 12) return window.notify("Limite de 12 times.", "info");
          addTeamInputRow(box, "");
          return;
        }

        if (id === "trAddTeamNext") {
          const box = qs("#trTeamsNext", tab);
          if (!box) return;
          if (qsa('[data-team-input="1"]', box).length >= 12) return window.notify("Limite de 12 times.", "info");
          addTeamInputRow(box, "");
          return;
        }

        if (btn.dataset?.teamRemove === "1") {
          const row = btn.closest(".tr-team-row");
          const box = row?.parentElement;
          if (row && box) {
            row.remove();
            if (qsa('[data-team-input="1"]', box).length < 2) addTeamInputRow(box, "");
          }
          return;
        }

        if (action === "win") {
          const team = btn.dataset.team;
          if (!team) return;
          return await decideWinner(team);
        }
      } catch (err) {
        window.notify(`Erro: ${err.message}`, "error");
      }
    });

    tab.addEventListener("input", (e) => {
      const inp = e.target.closest('input[data-role="points"]');
      if (!inp) return;
      const card = inp.closest('[data-team-card="1"]');
      const teamId = card?.dataset?.teamId || "";
      const torId = lastData?.torneio?.id || "";
      const phNum = lastData?.phase?.number || "";
      if (!teamId || !torId || !phNum) return;

      let v = String(inp.value || "").replace(/[^\d]/g, "");
      if (v.length > 6) v = v.slice(0, 6);
      inp.value = v;

      const obj = loadPoints(torId, phNum);
      obj[teamId] = v;
      savePoints(torId, phNum, obj);
    });
  }

  function init() {
    if (inited) return;
    const tab = ensureUI();
    if (!tab) return;
    inited = true;
    bind();
    refresh();
  }

  function onTabShown() {
    refresh();
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (qs("#tab-torneio")) init();
  });

  window.TorneioAdmin = { init, refresh, onTabShown };
})();

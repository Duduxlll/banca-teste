/* assets/js/cashback-admin.js */
(() => {
  const API = window.location.origin;

  const qs  = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => [...r.querySelectorAll(s)];

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\\^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Tenta usar apiFetch global, se existir. Se não existir, cria um fallback.
  async function apiFetch(path, opts = {}) {
    if (typeof window.apiFetch === 'function') return window.apiFetch(path, opts);

    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const method = (opts.method || 'GET').toUpperCase();

    if (['POST','PUT','PATCH','DELETE'].includes(method)) {
      const csrf = getCookie('csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(`${API}${path}`, { credentials: 'include', ...opts, headers });
    if (!res.ok) {
      let err;
      try { err = await res.json(); } catch {}
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  const esc = (s='') => String(s).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  const fmtBRL = (cents) => (Number(cents||0)/100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  const fmtDT  = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleString('pt-BR');
  };

  function notify(msg, type='ok') {
    if (typeof window.notify === 'function') return window.notify(msg, type);
    alert(msg);
  }

  function debounce(fn, wait=250){
    let t;
    return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), wait); };
  }

  function maskPixKey(key='') {
    const k = String(key || '').trim();
    if (!k) return '—';
    if (k.length <= 10) return k;
    return `${k.slice(0, 3)}…${k.slice(-4)}`;
  }

  function statusMeta(status='pendente'){
    const s = String(status||'').toLowerCase();
    if (s === 'aprovado') return { label:'✅ APROVADO', cls:'cb-badge cb-badge--ok' };
    if (s === 'reprovado') return { label:'❌ REPROVADO', cls:'cb-badge cb-badge--no' };
    return { label:'⏳ PENDENTE', cls:'cb-badge cb-badge--pend' };
  }

  // ---------- DOM / UI base ----------
  function ensureBaseUI() {
    // precisa existir a tab
    const tab = qs('#tab-cashbacks');
    if (!tab) return null;

    // se já tem tabela, não mexe
    if (qs('#tblCashbacks', tab)) return tab;

    tab.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="cb-head">
          <div>
            <h2 style="margin:0">💸 Cashbacks</h2>
            <p class="muted" style="margin:6px 0 0">
              Painel de revisão: aprovar/reprovar e ver comprovante.
            </p>
          </div>

          <div class="cb-actions">
            <select id="cbFilterStatus" class="input">
              <option value="all">Todos</option>
              <option value="pendente" selected>Pendentes</option>
              <option value="aprovado">Aprovados</option>
              <option value="reprovado">Reprovados</option>
            </select>

            <input id="cbSearch" class="input" placeholder="Buscar por nick / pix / id…">
            <button id="cbReload" class="btn btn--ghost">Atualizar</button>
          </div>
        </div>

        <div class="cb-stats">
          <div class="cb-pill">Pendentes: <strong id="cbCountPendente">0</strong></div>
          <div class="cb-pill">Aprovados: <strong id="cbCountAprovado">0</strong></div>
          <div class="cb-pill">Reprovados: <strong id="cbCountReprovado">0</strong></div>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="table-wrap">
          <table class="table" id="tblCashbacks" aria-label="Tabela de Cashbacks">
            <thead>
              <tr>
                <th>Data</th>
                <th>Nick</th>
                <th>PIX</th>
                <th>Status</th>
                <th>Motivo / Prazo</th>
                <th>Comprovante</th>
                <th class="col-acoes">Ações</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="cb-rank-head">
          <h3 style="margin:0">🏆 Ranking (Aprovados)</h3>
          <button id="cbRankReload" class="btn btn--ghost">Atualizar ranking</button>
        </div>
        <div class="table-wrap">
          <table class="table" id="tblCashbackRanking" aria-label="Ranking de Cashbacks">
            <thead>
              <tr>
                <th>#</th>
                <th>Nick</th>
                <th>Aprovados</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <p class="muted" style="margin:10px 0 0">
          (O ranking soma 1 ponto por envio aprovado.)
        </p>
      </div>
    `;

    return tab;
  }

  // ---------- Modal (aprovar/reprovar) ----------
  let modalEl = null;

  function ensureDecisionModal() {
    if (modalEl) return modalEl;

    const dlg = document.createElement('dialog');
    dlg.id = 'cbDecisionModal';
    dlg.className = 'cb-modal';

    dlg.innerHTML = `
      <div class="cb-modal-card">
        <div class="cb-modal-head">
          <div>
            <h3 class="cb-modal-title" id="cbModalTitle">Decisão</h3>
            <p class="cb-modal-sub" id="cbModalSub">—</p>
          </div>
          <button type="button" class="cb-x" data-cb-close aria-label="Fechar">×</button>
        </div>

        <div class="cb-modal-body">
          <div class="cb-grid">
            <div>
              <label class="muted">Status</label>
              <select id="cbModalStatus" class="input">
                <option value="aprovado">✅ APROVADO</option>
                <option value="reprovado">❌ REPROVADO</option>
              </select>
            </div>

            <div id="cbPrazoWrap">
              <label class="muted">Prazo do Pix (horas)</label>
              <input id="cbModalPrazoHoras" class="input" type="number" min="1" value="24">
            </div>
          </div>

          <div style="margin-top:10px">
            <label class="muted">Motivo (se reprovado) / Observação (opcional)</label>
            <textarea id="cbModalMotivo" class="input" rows="3" placeholder="Ex: print ilegível / sem data / sem prova"></textarea>
          </div>

          <div class="cb-modal-actions">
            <button type="button" class="btn btn--ghost" data-cb-close>Cancelar</button>
            <button type="button" class="btn btn--primary" id="cbModalSave">Salvar</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(dlg);

    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-cb-close]')) dlg.close();
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); });

    const sel = dlg.querySelector('#cbModalStatus');
    const prazoWrap = dlg.querySelector('#cbPrazoWrap');
    const sync = () => {
      const v = sel.value;
      // prazo só faz sentido no aprovado
      prazoWrap.style.display = (v === 'aprovado') ? '' : 'none';
    };
    sel.addEventListener('change', sync);
    sync();

    modalEl = dlg;
    return dlg;
  }

  function openDecisionModal(item, mode='aprovado') {
    const dlg = ensureDecisionModal();

    dlg.dataset.id = item?.id || '';
    const title = dlg.querySelector('#cbModalTitle');
    const sub   = dlg.querySelector('#cbModalSub');
    const stSel = dlg.querySelector('#cbModalStatus');
    const prazo = dlg.querySelector('#cbModalPrazoHoras');
    const mot   = dlg.querySelector('#cbModalMotivo');

    title.textContent = 'Decidir Cashback';
    sub.textContent = `${item?.twitchNick || item?.nick || '—'} • ${item?.id || ''}`;

    stSel.value = mode === 'reprovado' ? 'reprovado' : 'aprovado';
    prazo.value = String(item?.payoutPrazoHoras || item?.payout_window_hours || 24);
    mot.value   = (mode === 'reprovado') ? '' : (item?.motivo || item?.reason || '');

    // dispara sync display
    stSel.dispatchEvent(new Event('change'));

    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open','');
  }

  async function saveDecisionFromModal() {
    const dlg = ensureDecisionModal();
    const id  = dlg.dataset.id;
    if (!id) return;

    const stSel = dlg.querySelector('#cbModalStatus');
    const prazo = dlg.querySelector('#cbModalPrazoHoras');
    const mot   = dlg.querySelector('#cbModalMotivo');
    const btn   = dlg.querySelector('#cbModalSave');

    const status = stSel.value;
    const motivo = String(mot.value || '').trim();
    const prazoHoras = Math.max(1, parseInt(prazo.value, 10) || 24);

    if (status === 'reprovado' && !motivo) {
      notify('Pra reprovado, informe um motivo.', 'error');
      return;
    }

    btn.disabled = true;
    try {
      // Endpoint pensado pro server.js (você vai criar depois):
      // PATCH /api/cashbacks/:id  { status, motivo, prazoHoras }
      await apiFetch(`/api/cashbacks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          motivo: motivo || null,
          prazoHoras: status === 'aprovado' ? prazoHoras : null
        })
      });

      dlg.close();
      notify('Cashback atualizado.', 'ok');
      await CashbackAdmin.refresh();
    } catch (e) {
      console.error(e);
      notify(`Erro: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Render ----------
  const STATE = {
    list: [],
    ranking: [],
    filterStatus: 'pendente',
    search: '',
    loading: false
  };

  function applyFilters(arr) {
    let out = [...(arr || [])];

    const fs = String(STATE.filterStatus || 'all').toLowerCase();
    if (fs !== 'all') out = out.filter(x => String(x.status||'pendente').toLowerCase() === fs);

    const q = String(STATE.search || '').trim().toLowerCase();
    if (q) {
      out = out.filter(x => {
        const nick = String(x.twitchNick || x.nick || '').toLowerCase();
        const pix  = String(x.pixKey || x.pix || '').toLowerCase();
        const id   = String(x.id || '').toLowerCase();
        return nick.includes(q) || pix.includes(q) || id.includes(q);
      });
    }

    // mais novos primeiro
    out.sort((a,b)=> new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
    return out;
  }

  function updateCounters(arrAll) {
    const pend = arrAll.filter(x => String(x.status||'pendente').toLowerCase() === 'pendente').length;
    const apr  = arrAll.filter(x => String(x.status||'pendente').toLowerCase() === 'aprovado').length;
    const rep  = arrAll.filter(x => String(x.status||'pendente').toLowerCase() === 'reprovado').length;

    const a = qs('#cbCountPendente'); if (a) a.textContent = String(pend);
    const b = qs('#cbCountAprovado'); if (b) b.textContent = String(apr);
    const c = qs('#cbCountReprovado'); if (c) c.textContent = String(rep);
  }

  function renderTable() {
    const tab = qs('#tab-cashbacks');
    if (!tab) return;

    const tbody = qs('#tblCashbacks tbody', tab);
    if (!tbody) return;

    updateCounters(STATE.list);

    const arr = applyFilters(STATE.list);

    if (STATE.loading) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:14px">Carregando…</td></tr>`;
      return;
    }

    if (!arr.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted" style="padding:14px">Sem registros.</td></tr>`;
      return;
    }

    tbody.innerHTML = arr.map(x => {
      const st = statusMeta(x.status);
      const pix = maskPixKey(x.pixKey || x.pix || '');
      const pixType = x.pixType ? ` (${esc(x.pixType)})` : '';
      const motivo = esc(x.motivo || x.reason || '');
      const prazoH = x.payoutPrazoHoras ?? x.prazoHoras ?? x.payout_window_hours ?? null;

      let info = '—';
      if (String(x.status||'').toLowerCase() === 'aprovado') {
        info = prazoH ? `Pix em até <strong>${esc(String(prazoH))}h</strong>` : 'Pix aprovado';
      } else if (String(x.status||'').toLowerCase() === 'reprovado') {
        info = motivo ? `Motivo: <strong>${motivo}</strong>` : 'Reprovado';
      } else if (motivo) {
        info = `Obs: <strong>${motivo}</strong>`;
      }

      const proofUrl = x.proofUrl || x.printUrl || x.screenshotUrl || x.comprovanteUrl || '';
      const proofBtn = proofUrl
        ? `<button class="btn btn--ghost cb-mini" data-action="cb-proof" data-id="${esc(x.id)}">Abrir</button>`
        : `<span class="muted">—</span>`;

      // ações
      const actions = `
        <div class="cb-actions-row">
          <button class="btn btn--primary cb-mini" data-action="cb-approve" data-id="${esc(x.id)}">Aprovar</button>
          <button class="btn btn--danger  cb-mini" data-action="cb-reject"  data-id="${esc(x.id)}">Reprovar</button>
          <button class="btn cb-mini" data-action="cb-copy-pix" data-id="${esc(x.id)}">Copiar PIX</button>
        </div>
      `;

      return `
        <tr data-id="${esc(x.id)}">
          <td>${fmtDT(x.createdAt || x.created_at)}</td>
          <td><strong>${esc(x.twitchNick || x.nick || '')}</strong></td>
          <td>
            <div class="cb-pix">
              <span class="cb-pix-key">${esc(pix)}</span>
              <span class="cb-pix-type">${pixType ? esc(pixType) : ''}</span>
            </div>
          </td>
          <td><span class="${st.cls}">${st.label}</span></td>
          <td>${info}</td>
          <td>${proofBtn}</td>
          <td class="col-acoes">${actions}</td>
        </tr>
      `;
    }).join('');
  }

  function renderRanking() {
    const tab = qs('#tab-cashbacks');
    if (!tab) return;

    const tbody = qs('#tblCashbackRanking tbody', tab);
    if (!tbody) return;

    const arr = Array.isArray(STATE.ranking) ? STATE.ranking : [];
    if (!arr.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted" style="padding:14px">Sem ranking ainda.</td></tr>`;
      return;
    }

    tbody.innerHTML = arr.slice(0, 15).map((x, i) => {
      const nick = x.nick || x.usuario || x.twitchNick || '';
      const pts  = x.aprovados ?? x.pontos ?? x.count ?? 0;
      return `
        <tr>
          <td>${i+1}</td>
          <td><strong>${esc(nick)}</strong></td>
          <td>${esc(String(pts))}</td>
        </tr>
      `;
    }).join('');
  }

  // ---------- Data load ----------
  async function loadList() {
    // Endpoint pensado pro server.js:
    // GET /api/cashbacks  -> retorna array
    STATE.loading = true;
    renderTable();
    try {
      const list = await apiFetch('/api/cashbacks');
      STATE.list = Array.isArray(list) ? list : (list?.rows || []);
    } finally {
      STATE.loading = false;
    }
  }

  async function loadRanking() {
    // Endpoint pensado pro server.js:
    // GET /api/cashbacks/ranking?limit=10 -> [{nick, aprovados}]
    try {
      const r = await apiFetch('/api/cashbacks/ranking?limit=10');
      STATE.ranking = Array.isArray(r) ? r : (r?.rows || []);
    } catch (e) {
      // se ainda não existir rota, não quebra o painel
      STATE.ranking = [];
    }
  }

  function findById(id) {
    return (STATE.list || []).find(x => String(x.id) === String(id));
  }

  // ---------- Events ----------
  function bindUI() {
    const tab = ensureBaseUI();
    if (!tab) return;

    const filterSel = qs('#cbFilterStatus', tab);
    const searchInp = qs('#cbSearch', tab);
    const reloadBtn = qs('#cbReload', tab);
    const rankBtn   = qs('#cbRankReload', tab);

    if (filterSel) {
      filterSel.value = STATE.filterStatus || 'pendente';
      filterSel.addEventListener('change', () => {
        STATE.filterStatus = filterSel.value;
        renderTable();
      });
    }

    if (searchInp) {
      searchInp.addEventListener('input', debounce(() => {
        STATE.search = searchInp.value || '';
        renderTable();
      }, 200));
    }

    if (reloadBtn) reloadBtn.addEventListener('click', () => CashbackAdmin.refresh());
    if (rankBtn) rankBtn.addEventListener('click', async () => {
      await loadRanking();
      renderRanking();
      notify('Ranking atualizado.', 'ok');
    });

    // ações da tabela
    tab.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const item = findById(id);
      if (!item) return;

      if (action === 'cb-approve') {
        openDecisionModal(item, 'aprovado');
        return;
      }

      if (action === 'cb-reject') {
        openDecisionModal(item, 'reprovado');
        return;
      }

      if (action === 'cb-copy-pix') {
        const raw = item.pixKey || item.pix || '';
        if (!raw) return notify('Esse envio não tem PIX.', 'error');
        try {
          await navigator.clipboard.writeText(String(raw));
          notify('PIX copiado!', 'ok');
        } catch {
          notify('Não consegui copiar automaticamente. Copie manualmente.', 'error');
        }
        return;
      }

      if (action === 'cb-proof') {
        const url = item.proofUrl || item.printUrl || item.screenshotUrl || item.comprovanteUrl || '';
        if (!url) return notify('Sem comprovante nesse envio.', 'error');
        // abre em nova aba
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
    });

    // salvar do modal
    const dlg = ensureDecisionModal();
    const saveBtn = dlg.querySelector('#cbModalSave');
    if (saveBtn) saveBtn.addEventListener('click', saveDecisionFromModal);
  }

  // ---------- Public API ----------
  const CashbackAdmin = {
    init() {
      ensureBaseUI();
      bindUI();
    },
    async refresh() {
      try {
        await loadList();
        renderTable();
        await loadRanking();
        renderRanking();
      } catch (e) {
        console.error(e);
        notify(`Erro ao carregar cashbacks: ${e.message}`, 'error');
        renderTable();
        renderRanking();
      }
    },
    onTabShown() {
      // quando clicar na aba, atualiza (leve)
      CashbackAdmin.refresh();
    }
  };

  window.CashbackAdmin = CashbackAdmin;

  // auto-init quando DOM pronto (não quebra se não tiver tab)
  document.addEventListener('DOMContentLoaded', () => {
    if (qs('#tab-cashbacks')) {
      CashbackAdmin.init();
      // não força refresh se você preferir carregar só quando abrir a aba,
      // mas vou carregar uma vez pra já aparecer.
      CashbackAdmin.refresh();
    }
  });
})();

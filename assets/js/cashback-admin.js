(() => {
  const API = window.location.origin;

  const qs  = (s, r=document) => r.querySelector(s);

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\\^])/g, '\\$1') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

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

  function statusMeta(status='PENDENTE'){
    const s = String(status||'PENDENTE').toUpperCase();
    if (s === 'APROVADO') return { label:'✅ APROVADO', cls:'cb-badge cb-badge--ok' };
    if (s === 'REPROVADO') return { label:'❌ REPROVADO', cls:'cb-badge cb-badge--no' };
    return { label:'⏳ PENDENTE', cls:'cb-badge cb-badge--pend' };
  }

  function ensureBaseUI() {
    const tab = qs('#tab-cashbacks');
    if (!tab) return null;
    if (qs('#tblCashbacks', tab)) return tab;

    tab.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div class="cb-head">
          <div>
            <h2 style="margin:0">💸 Cashbacks</h2>
            <p class="muted" style="margin:6px 0 0">Painel de revisão: aprovar/reprovar e ver comprovante.</p>
          </div>

          <div class="cb-actions">
            <select id="cbFilterStatus" class="input">
              <option value="all">Todos</option>
              <option value="PENDENTE" selected>Pendentes</option>
              <option value="APROVADO">Aprovados</option>
              <option value="REPROVADO">Reprovados</option>
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
        <p class="muted" style="margin:10px 0 0">(O ranking soma 1 ponto por envio aprovado.)</p>
      </div>
    `;

    return tab;
  }

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
                <option value="APROVADO">✅ APROVADO</option>
                <option value="REPROVADO">❌ REPROVADO</option>
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
      prazoWrap.style.display = (v === 'APROVADO') ? '' : 'none';
    };
    sel.addEventListener('change', sync);
    sync();

    modalEl = dlg;
    return dlg;
  }

  function parsePrazoHoras(payoutWindow) {
    const s = String(payoutWindow || '');
    const m = s.match(/(\d+)/);
    return m ? Math.max(1, parseInt(m[1], 10) || 24) : 24;
  }

  function openDecisionModal(item, mode='APROVADO') {
    const dlg = ensureDecisionModal();

    dlg.dataset.id = item?.id || '';
    const title = dlg.querySelector('#cbModalTitle');
    const sub   = dlg.querySelector('#cbModalSub');
    const stSel = dlg.querySelector('#cbModalStatus');
    const prazo = dlg.querySelector('#cbModalPrazoHoras');
    const mot   = dlg.querySelector('#cbModalMotivo');

    title.textContent = 'Decidir Cashback';
    sub.textContent = `${item?.twitchName || '—'} • ${item?.id || ''}`;

    stSel.value = (mode === 'REPROVADO') ? 'REPROVADO' : 'APROVADO';
    prazo.value = String(parsePrazoHoras(item?.payoutWindow));
    mot.value   = (mode === 'REPROVADO') ? '' : (item?.reason || '');

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
    const reason = String(mot.value || '').trim();
    const prazoHoras = Math.max(1, parseInt(prazo.value, 10) || 24);

    if (status === 'REPROVADO' && !reason) {
      notify('Pra reprovado, informe um motivo.', 'error');
      return;
    }

    btn.disabled = true;
    try {
      await apiFetch(`/api/cashback/admin/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          reason: reason || null,
          payoutWindow: status === 'APROVADO' ? `${prazoHoras}h` : null
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

  const STATE = {
    list: [],
    ranking: [],
    filterStatus: 'PENDENTE',
    search: '',
    loading: false
  };

  function applyFilters(arr) {
    let out = [...(arr || [])];

    const fs = String(STATE.filterStatus || 'all').toUpperCase();
    if (fs !== 'ALL') out = out.filter(x => String(x.status||'PENDENTE').toUpperCase() === fs);

    const q = String(STATE.search || '').trim().toLowerCase();
    if (q) {
      out = out.filter(x => {
        const nick = String(x.twitchName || '').toLowerCase();
        const pix  = String(x.pixKey || '').toLowerCase();
        const id   = String(x.id || '').toLowerCase();
        return nick.includes(q) || pix.includes(q) || id.includes(q);
      });
    }

    out.sort((a,b)=> new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    return out;
  }

  function updateCounters(arrAll) {
    const pend = arrAll.filter(x => String(x.status||'PENDENTE').toUpperCase() === 'PENDENTE').length;
    const apr  = arrAll.filter(x => String(x.status||'PENDENTE').toUpperCase() === 'APROVADO').length;
    const rep  = arrAll.filter(x => String(x.status||'PENDENTE').toUpperCase() === 'REPROVADO').length;

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
      const pix = maskPixKey(x.pixKey || '');
      const pixType = x.pixType ? ` (${esc(x.pixType)})` : '';
      const reason = esc(x.reason || '');
      const payoutWindow = esc(x.payoutWindow || '');

      let info = '—';
      if (String(x.status||'').toUpperCase() === 'APROVADO') {
        info = payoutWindow ? `Pix em até <strong>${payoutWindow}</strong>` : 'Pix aprovado';
      } else if (String(x.status||'').toUpperCase() === 'REPROVADO') {
        info = reason ? `Motivo: <strong>${reason}</strong>` : 'Reprovado';
      } else if (reason) {
        info = `Obs: <strong>${reason}</strong>`;
      }

      const proofBtn = x.hasScreenshot
        ? `<button class="btn btn--ghost cb-mini" data-action="cb-proof" data-id="${esc(x.id)}">Abrir</button>`
        : `<span class="muted">—</span>`;

      const actions = `
        <div class="cb-actions-row">
          <button class="btn btn--primary cb-mini" data-action="cb-approve" data-id="${esc(x.id)}">Aprovar</button>
          <button class="btn btn--danger  cb-mini" data-action="cb-reject"  data-id="${esc(x.id)}">Reprovar</button>
          <button class="btn cb-mini" data-action="cb-copy-pix" data-id="${esc(x.id)}">Copiar PIX</button>
        </div>
      `;

      return `
        <tr data-id="${esc(x.id)}">
          <td>${fmtDT(x.createdAt)}</td>
          <td><strong>${esc(x.twitchName || '')}</strong></td>
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

  function computeRankingFromList(list) {
    const map = new Map();
    for (const x of (list || [])) {
      if (String(x.status || '').toUpperCase() !== 'APROVADO') continue;
      const nick = String(x.twitchName || '').trim();
      if (!nick) continue;
      const k = nick.toLowerCase();
      const cur = map.get(k) || { nick, aprovados: 0 };
      cur.aprovados += 1;
      map.set(k, cur);
    }
    return [...map.values()].sort((a,b)=> (b.aprovados - a.aprovados) || a.nick.localeCompare(b.nick, 'pt-BR'));
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

    tbody.innerHTML = arr.slice(0, 15).map((x, i) => `
      <tr>
        <td>${i+1}</td>
        <td><strong>${esc(x.nick)}</strong></td>
        <td>${esc(String(x.aprovados))}</td>
      </tr>
    `).join('');
  }

  async function loadList() {
    STATE.loading = true;
    renderTable();
    try {
      const data = await apiFetch('/api/cashback/admin/list?limit=1000');
      STATE.list = Array.isArray(data?.rows) ? data.rows : [];
    } finally {
      STATE.loading = false;
    }
  }

  function findById(id) {
    return (STATE.list || []).find(x => String(x.id) === String(id));
  }

  function bindUI() {
    const tab = ensureBaseUI();
    if (!tab) return;

    const filterSel = qs('#cbFilterStatus', tab);
    const searchInp = qs('#cbSearch', tab);
    const reloadBtn = qs('#cbReload', tab);
    const rankBtn   = qs('#cbRankReload', tab);

    if (filterSel) {
      filterSel.value = STATE.filterStatus || 'PENDENTE';
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
      STATE.ranking = computeRankingFromList(STATE.list);
      renderRanking();
      notify('Ranking atualizado.', 'ok');
    });

    tab.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const item = findById(id);
      if (!item) return;

      if (action === 'cb-approve') return openDecisionModal(item, 'APROVADO');
      if (action === 'cb-reject')  return openDecisionModal(item, 'REPROVADO');

      if (action === 'cb-copy-pix') {
        const raw = item.pixKey || '';
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
        try {
          const data = await apiFetch(`/api/cashback/admin/${encodeURIComponent(id)}`, { method: 'GET' });
          const url = data?.row?.screenshotDataUrl || '';
          if (!url) return notify('Sem comprovante nesse envio.', 'error');
          const w = window.open();
          if (w) w.location.href = url;
          else window.open(url, '_blank', 'noopener,noreferrer');
        } catch (err) {
          notify(`Erro ao abrir comprovante: ${err.message}`, 'error');
        }
        return;
      }
    });

    const dlg = ensureDecisionModal();
    const saveBtn = dlg.querySelector('#cbModalSave');
    if (saveBtn) saveBtn.addEventListener('click', saveDecisionFromModal);
  }

  const CashbackAdmin = {
    init() {
      ensureBaseUI();
      bindUI();
    },
    async refresh() {
      try {
        await loadList();
        renderTable();
        STATE.ranking = computeRankingFromList(STATE.list);
        renderRanking();
      } catch (e) {
        console.error(e);
        notify(`Erro ao carregar cashbacks: ${e.message}`, 'error');
        renderTable();
        renderRanking();
      }
    },
    onTabShown() {
      CashbackAdmin.refresh();
    }
  };

  window.CashbackAdmin = CashbackAdmin;

  document.addEventListener('DOMContentLoaded', () => {
    if (qs('#tab-cashbacks')) {
      CashbackAdmin.init();
      CashbackAdmin.refresh();
    }
  });
})();

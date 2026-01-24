const API = window.location.origin;
const qs  = (s, r=document) => r.querySelector(s);
const qsa = (s, r=document) => [...r.querySelectorAll(s)];

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([$?*|{}\\^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers||{}) };
  if (['POST','PUT','PATCH','DELETE'].includes((opts.method||'GET').toUpperCase())) {
    const csrf = getCookie('csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const res = await fetch(`${API}${path}`, { credentials:'include', ...opts, headers });
  if (!res.ok) {
    let err;
    try { err = await res.json(); } catch {}
    throw new Error(err?.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const fmtBRL  = (c)=> (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const toCents = (s)=> { const d = (s||'').toString().replace(/\D/g,''); return d ? parseInt(d,10) : 0; };
const esc     = (s='') => s.replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

function formatMoneyInputEl(inp){
  if (!inp) return;
  let v = String(inp.value || '').replace(/\D/g,'');
  if (!v) {
    inp.value = '';
    return;
  }
  v = v.replace(/^0+/, '');
  if (v.length < 3) v = v.padStart(3,'0');
  inp.value = fmtBRL(parseInt(v,10));
}

function normalizePixKeyByType(type, raw){
  let v = String(raw || '').trim();
  if (!v) return '';
  if (type === 'cpf' || type === 'phone') {
    v = v.replace(/\D/g,'');
  } else if (type === 'email') {
    v = v.toLowerCase();
  }
  return v;
}

function formatCPF(raw){
  const d = String(raw || '').replace(/\D/g,'').slice(0,11);
  const p1 = d.slice(0,3);
  const p2 = d.slice(3,6);
  const p3 = d.slice(6,9);
  const p4 = d.slice(9,11);
  let out = '';
  if (p1) out = p1;
  if (p2) out += '.' + p2;
  if (p3) out += '.' + p3;
  if (p4) out += '-' + p4;
  return out;
}

function formatPhoneBR(raw){
  let d = String(raw || '').replace(/\D/g,'').slice(-11);
  const has9 = d.length === 11;
  const ddd  = d.slice(0,2);
  const meio = has9 ? d.slice(2,7) : d.slice(2,6);
  const fim  = has9 ? d.slice(7)   : d.slice(6);
  let out = '';
  if (ddd) out = `(${ddd}`;
  if (ddd && (meio || fim)) out += ') ';
  if (meio) out += meio;
  if (fim) out += '-' + fim;
  return out;
}

function debounce(fn, wait = 300){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function toASCIIUpper(s = '') {
  const noMarks = s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return noMarks
    .replace(/[^A-Za-z0-9 .,_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function cleanPixKey(raw = '') {
  let k = String(raw || '').trim();
  if (/^\+?\d[\d\s().-]*$/.test(k)) k = k.replace(/\D/g, '');
  return k;
}

function TLV(id, value) {
  const v = String(value ?? '');
  const len = String(v.length).padStart(2, '0');
  return `${id}${len}${v}`;
}

function crc16_ccitt(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatPixPhoneForPayload(raw){
  let d = String(raw || '').replace(/\D/g,'');
  if (!d) return '';
  if (!d.startsWith('55')) {
    if (d.length >= 10 && d.length <= 11) {
      d = '55' + d;
    }
  }
  return '+' + d;
}

function buildPixBRCode({ chave, valorCents, nome, cidade = 'BRASILIA', txid = '***', tipo = null }) {
  let chaveOK;

  if (tipo === 'phone') {
    chaveOK = formatPixPhoneForPayload(chave);
  } else if (tipo === 'cpf') {
    chaveOK = String(chave || '').replace(/\D/g,'');
  } else {
    chaveOK = cleanPixKey(chave);
  }

  const nomeOK   = toASCIIUpper((nome || 'RECEBEDOR')).slice(0, 25) || 'RECEBEDOR';
  const cidadeOK = toASCIIUpper(cidade || 'BRASILIA').slice(0, 15) || 'BRASILIA';

  const txidOK   = txid === '***'
    ? '***'
    : String(txid)
        .replace(/[^A-Za-z0-9.-]/g, '')
        .slice(0, 25) || '***';

  const mai = TLV('26',
    TLV('00', 'br.gov.bcb.pix') +
    TLV('01', String(chaveOK))
  );

  const payloadSemCRC =
      TLV('00','01') +
      TLV('01','11') +
      mai +
      TLV('52','0000') +
      TLV('53','986') +
      TLV('54', (Number(valorCents||0)/100).toFixed(2)) +
      TLV('58', 'BR') +
      TLV('59', nomeOK) +
      TLV('60', cidadeOK) +
      TLV('62', TLV('05', txidOK)) +
      '6304';

  const crc = crc16_ccitt(payloadSemCRC);
  return payloadSemCRC + crc;
}



const tabBancasEl     = qs('#tab-bancas');
const tabPagamentosEl = qs('#tab-pagamentos');
const tabExtratosEl   = qs('#tab-extratos');
const tabCuponsEl     = qs('#tab-cupons');
const tabSorteioEl    = qs('#tab-sorteio');
const tabPalpiteEl    = qs('#tab-palpite'); 

const tbodyBancas     = qs('#tblBancas tbody');
const tbodyPags       = qs('#tblPagamentos tbody');

const tbodyExtDeps    = qs('#tblExtratosDepositos tbody');
const tbodyExtPags    = qs('#tblExtratosPagamentos tbody');

const tbodyCupons     = qs('#tblCupons tbody');

const buscaInput        = qs('#busca');
const buscaExtratoInput = qs('#busca-extrato');
const buscaCupomInput   = qs('#busca-cupom');

const filtroTipo        = qs('#filtro-tipo');
const filtroRange       = qs('#filtro-range');
const filtroFrom        = qs('#filtro-from');
const filtroTo          = qs('#filtro-to');
const btnFiltrar        = qs('#btn-filtrar');
const btnLimpar         = qs('#btn-limpar');

const filtroCupomStatus = qs('#filtro-cupom-status');

const formAddBanca = qs('#formAddBanca');

let TAB = localStorage.getItem('area_tab') || 'bancas';
const STATE = {
  bancas: [],
  pagamentos: [],
  extratos: { depositos: [], pagamentos: [] },
  cupons: [],
  timers: new Map(),
  filtrosExtratos: { tipo:'all', range:'last30', from:null, to:null },
  editingBancaId: null
};

let cuponsAutoTimer = null;

function startCuponsAutoRefresh(){
  if (cuponsAutoTimer) return;
  cuponsAutoTimer = setInterval(async () => {
    try{
      await loadCupons();
      if (TAB === 'cupons') renderCupons();
    }catch(err){
      console.error('Erro ao atualizar cupons automaticamente', err);
    }
  }, 4000);
}

function getTotalDepEl(){
  return qs('#totalDepositos') || qs('#openTotalDepositos');
}
function getTotalBanEl(){
  return qs('#totalBancas') || qs('#openTotalBancas');
}

function updateTotals() {
  const totalDepositos = STATE.bancas.reduce((acc, b) => acc + (b.depositoCents || 0), 0);
  const totalBancas    = STATE.bancas.reduce((acc, b) => acc + (b.bancaCents || 0), 0);

  const elDep = qs('#totalDepositos');
  const elBan = qs('#totalBancas');

  if (elDep) elDep.dataset.total = fmtBRL(totalDepositos);
  if (elBan) elBan.dataset.total = fmtBRL(totalBancas);
}

let totaisPopupEl = null;

function ensureTotaisPopup(){
  if (totaisPopupEl) return totaisPopupEl;

  injectOnce('totaisPopupCSS', `
    .totais-popup{
      position:fixed;
      z-index:9999;
      background:linear-gradient(180deg, rgba(255,255,255,.12), rgba(255,255,255,.06));
      border-radius:14px;
      border:1px solid rgba(255,255,255,.25);
      box-shadow:0 22px 60px rgba(40,20,5,.65);
      padding:12px 14px 14px;
      min-width:220px;
      max-width:260px;
      opacity:0;
      transform:translateY(6px) scale(.97);
      pointer-events:none;
    }
    .totais-popup.show{
      opacity:1;
      transform:translateY(0) scale(1);
      pointer-events:auto;
      animation:totaisPopupIn .16s ease-out;
    }
    @keyframes totaisPopupIn{
      from{ opacity:0; transform:translateY(6px) scale(0.97); }
      to  { opacity:1; transform:translateY(0)    scale(1);    }
    }
    .totais-popup-header{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:8px;
      margin-bottom:6px;
    }
    .totais-popup-title{ font-size:14px; font-weight:800; }
    .totais-popup-value{ font-size:16px; font-weight:800; margin:0; color:#fff; font-variant-numeric:tabular-nums; }
    .totais-popup-close{ border:0; background:transparent; color:#fff; cursor:pointer; font-size:16px; line-height:1; padding:2px 4px; }
  `);

  const el = document.createElement('div');
  el.id = 'totaisPopup';
  el.className = 'totais-popup';
  el.innerHTML = `
    <div class="totais-popup-header">
      <span class="totais-popup-title"></span>
      <button type="button" class="totais-popup-close" aria-label="Fechar">×</button>
    </div>
    <p class="totais-popup-value"></p>
  `;
  document.body.appendChild(el);

  const closeBtn = el.querySelector('.totais-popup-close');
  if (closeBtn) closeBtn.addEventListener('click', hideTotaisPopup);

  totaisPopupEl = el;
  return el;
}

function showTotaisPopup(kind, anchorEl){
  if (!anchorEl) return;
  const popup = ensureTotaisPopup();
  const titleEl = popup.querySelector('.totais-popup-title');
  const valueEl = popup.querySelector('.totais-popup-value');
  if (!titleEl || !valueEl) return;

  const totalDepositos = STATE.bancas.reduce((acc, b) => acc + (b.depositoCents || 0), 0);
  const totalBancas    = STATE.bancas.reduce((acc, b) => acc + (b.bancaCents || 0), 0);

  if (kind === 'depositos') {
    titleEl.textContent = 'Soma dos Depósitos';
    valueEl.textContent = fmtBRL(totalDepositos);
  } else {
    titleEl.textContent = 'Soma das Bancas';
    valueEl.textContent = fmtBRL(totalBancas);
  }

  popup.style.display = 'block';
  popup.classList.remove('show');

  requestAnimationFrame(() => {
    const r  = anchorEl.getBoundingClientRect();
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;

    let top  = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;

    let left = r.left + (r.width/2) - (pw/2);
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) {
      left = window.innerWidth - pw - 8;
    }

    popup.style.top  = `${Math.round(top)}px`;
    popup.style.left = `${Math.round(left)}px`;

    popup.classList.add('show');
  });
}

function hideTotaisPopup(){
  if (!totaisPopupEl) return;
  totaisPopupEl.classList.remove('show');
  totaisPopupEl.style.display = 'none';
}

async function loadBancas() {
  const list = await apiFetch(`/api/bancas`);
  STATE.bancas = list.sort((a,b)=> (a.createdAt||'') < (b.createdAt||'') ? 1 : -1);
  updateTotals();
  return STATE.bancas;
}

async function loadPagamentos() {
  const list = await apiFetch(`/api/pagamentos`);
  STATE.pagamentos = list.sort((a,b)=> (a.createdAt||'') < (b.createdAt||'') ? 1 : -1);
  return STATE.pagamentos;
}

function buildExtratosQuery(tipoOverride = null){
  const f = STATE.filtrosExtratos || {};
  const params = new URLSearchParams();

  const tipo = tipoOverride || f.tipo || 'all';
  if (tipo && tipo !== 'all') {
    params.set('tipo', tipo);
  }

  const range = f.range || 'last30';
  if (range === 'custom') {
    if (f.from) params.set('from', f.from);
    if (f.to)   params.set('to',   f.to);
  } else {
    params.set('range', range);
  }

  params.set('limit', '500');
  return params.toString();
}

async function loadExtratos(){
  if (!tabExtratosEl) return STATE.extratos;

  const f = STATE.filtrosExtratos || {};

  if (!f.tipo || f.tipo === 'all') {
    const qsDeps = buildExtratosQuery('deposito');
    const qsPags = buildExtratosQuery('pagamento');

    const [deps, pags] = await Promise.all([
      apiFetch(`/api/extratos?${qsDeps}`),
      apiFetch(`/api/extratos?${qsPags}`)
    ]);

    STATE.extratos.depositos  = deps;
    STATE.extratos.pagamentos = pags;

  } else if (f.tipo === 'deposito') {
    const qsDeps = buildExtratosQuery('deposito');
    STATE.extratos.depositos  = await apiFetch(`/api/extratos?${qsDeps}`);
    STATE.extratos.pagamentos = [];

  } else if (f.tipo === 'pagamento') {
    const qsPags = buildExtratosQuery('pagamento');
    STATE.extratos.depositos  = [];
    STATE.extratos.pagamentos = await apiFetch(`/api/extratos?${qsPags}`);
  }

  return STATE.extratos;
}

async function loadCupons(){
  if (!tabCuponsEl && !tbodyCupons) return STATE.cupons;
  const list = await apiFetch('/api/cupons');
  const nowMs = Date.now();

  STATE.cupons = (list || []).map(raw => {
    const c = { ...raw };

    const created = c.createdAt || c.created_at || null;
    if (!c.createdAt && created) c.createdAt = created;

    const expRaw = c.expiraEm || c.expira_em || null;
    const usadoEm = c.usadoEm || c.usado_em || null;

    let status = 'ativo';
    const expMs = expRaw ? new Date(expRaw).getTime() : null;

    if (usadoEm) {
      status = 'resgatado';
    } else if (expMs && expMs < nowMs) {
      status = 'expirado';
    } else if (c.ativo === false) {
      status = 'inativo';
    }

    c.status = status;

    if (typeof c.valorCentavos !== 'number') {
      if (typeof c.valorCents === 'number') c.valorCentavos = c.valorCents;
      else if (typeof c.valor_cents === 'number') c.valorCentavos = c.valor_cents;
    }

    if (!c.resgatadoPor) {
      c.resgatadoPor =
        c.usadoPorNome ||
        c.usado_por_nome ||
        c.resgatado_por ||
        '';
    }

    return c;
  }).sort((a,b)=>{
    const da = new Date(a.createdAt || a.criadoEm || 0).getTime();
    const db = new Date(b.createdAt || b.criadoEm || 0).getTime();
    return db - da;
  });

  return STATE.cupons;
}



async function render(){
  if (TAB === 'bancas') {
    tabBancasEl?.classList.add('show');
    tabPagamentosEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    tabCuponsEl?.classList.remove('show');
    tabSorteioEl?.classList.remove('show');
    tabPalpiteEl?.classList.remove('show'); 
    renderBancas();
    updateTotals();

  } else if (TAB === 'pagamentos') {
    tabPagamentosEl?.classList.add('show');
    tabBancasEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    tabCuponsEl?.classList.remove('show');
    tabSorteioEl?.classList.remove('show');
    tabPalpiteEl?.classList.remove('show'); 
    renderPagamentos();

  } else if (TAB === 'extratos') {
    tabExtratosEl?.classList.add('show');
    tabBancasEl?.classList.remove('show');
    tabPagamentosEl?.classList.remove('show');
    tabCuponsEl?.classList.remove('show');
    tabSorteioEl?.classList.remove('show');
    tabPalpiteEl?.classList.remove('show'); 
    renderExtratos();

  } else if (TAB === 'cupons') {
    tabCuponsEl?.classList.add('show');
    tabBancasEl?.classList.remove('show');
    tabPagamentosEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    tabSorteioEl?.classList.remove('show');
    tabPalpiteEl?.classList.remove('show'); 
    renderCupons();

  } else if (TAB === 'sorteio') {
    tabSorteioEl?.classList.add('show');
    tabBancasEl?.classList.remove('show');
    tabPagamentosEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    tabCuponsEl?.classList.remove('show');
    tabPalpiteEl?.classList.remove('show'); 

  } else if (TAB === 'palpite') {
    tabPalpiteEl?.classList.add('show'); 
    tabBancasEl?.classList.remove('show');
    tabPagamentosEl?.classList.remove('show');
    tabExtratosEl?.classList.remove('show');
    tabCuponsEl?.classList.remove('show');
    tabSorteioEl?.classList.remove('show');

    
    if (window.PalpiteAdmin && typeof window.PalpiteAdmin.onTabShown === 'function') {
      try { window.PalpiteAdmin.onTabShown(); } catch(e){ console.error(e); }
    }
  }
}

function renderBancas(){
  if (!tbodyBancas) return;

  const focused = document.activeElement;
  const isEditing = !!focused?.matches?.('input[data-role="banca"]');
  if (isEditing) return;

  const lista = STATE.bancas;
  tbodyBancas.innerHTML = lista.length ? lista.map(b => {
    const bancaTxt = typeof b.bancaCents === 'number' ? fmtBRL(b.bancaCents) : '';
    const hasMsg = !!(b.message && String(b.message).trim());
    return `
      <tr data-id="${b.id}">
        <td>${esc(b.nome)}</td>
        <td>${fmtBRL(b.depositoCents||0)}</td>
        <td>
          <input type="text"
                 class="input input-money"
                 data-role="banca"
                 data-id="${b.id}"
                 placeholder="R$ 0,00"
                 value="${bancaTxt}">
        </td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn--primary" data-action="to-pagamento" data-id="${b.id}">Pagamento</button>
            <button class="btn" data-action="ver-msg" data-id="${b.id}" ${hasMsg?'':'disabled'}>Ver mensagem</button>
            <button class="btn btn--danger"  data-action="del-banca"    data-id="${b.id}">Excluir</button>
          </div>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="4" class="muted" style="padding:14px">Sem registros ainda.</td></tr>`;

  filtrarTabela(tbodyBancas, buscaInput?.value || '');
  updateTotals();
}

function renderPagamentos(){
  if (!tbodyPags) return;
  const lista = STATE.pagamentos;

  tbodyPags.innerHTML = lista.length ? lista.map(p => {
    const isPago = p.status === 'pago';
    const statusTxt = isPago ? 'Pago' : 'Não pago';
    const statusCls = isPago ? 'status--pago' : 'status--nao';

    return `
      <tr data-id="${p.id}">
        <td>${esc(p.nome)}</td>
        <td>${fmtBRL(p.pagamentoCents||0)}</td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px;align-items:center">
            <button type="button"
                    class="status-btn ${statusCls}"
                    data-action="status-open"
                    data-id="${p.id}"
                    data-status="${p.status}">
              ${statusTxt} <span class="caret"></span>
            </button>

            <button class="btn btn--primary" data-action="to-banca" data-id="${p.id}">Bancas</button>

            <button class="btn btn--primary" data-action="fazer-pix" data-id="${p.id}">Fazer PIX</button>
            <button class="btn btn--danger"  data-action="del-pag"   data-id="${p.id}">Excluir</button>
          </div>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem pagamentos ainda.</td></tr>`;

  filtrarTabela(tbodyPags, buscaInput?.value || '');
}

function renderExtratos(){
  if (!tabExtratosEl) return;

  if (tbodyExtDeps) {
    const L1 = STATE.extratos.depositos;
    tbodyExtDeps.innerHTML = L1.length ? L1.map(x => `
      <tr>
        <td>${esc(x.nome)}</td>
        <td>${fmtBRL(x.valorCents||0)}</td>
        <td>${new Date(x.createdAt).toLocaleString('pt-BR')}</td>
      </tr>
    `).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem depósitos ainda.</td></tr>`;
  }

  if (tbodyExtPags) {
    const L2 = STATE.extratos.pagamentos;
    tbodyExtPags.innerHTML = L2.length ? L2.map(x => `
      <tr>
        <td>${esc(x.nome)}</td>
        <td>${fmtBRL(x.valorCents||0)}</td>
        <td>${new Date(x.createdAt).toLocaleString('pt-BR')}</td>
      </tr>
    `).join('') : `<tr><td colspan="3" class="muted" style="padding:14px">Sem pagamentos ainda.</td></tr>`;
  }

  const q = (buscaExtratoInput?.value || '').trim().toLowerCase();
  if (q) {
    if (tbodyExtDeps) filtrarTabela(tbodyExtDeps, q);
    if (tbodyExtPags) filtrarTabela(tbodyExtPags, q);
  }

  if (filtroTipo && tabExtratosEl) {
    const t = (filtroTipo.value||'all');
    const cardDeps = tabExtratosEl.querySelector('[data-card="deps"]') || tabExtratosEl.querySelector('#tblExtratosDepositos')?.closest('.card');
    const cardPags = tabExtratosEl.querySelector('[data-card="pags"]') || tabExtratosEl.querySelector('#tblExtratosPagamentos')?.closest('.card');
    if (cardDeps && cardPags) {
      cardDeps.style.display = (t==='all' || t==='deposito') ? '' : 'none';
      cardPags.style.display = (t==='all' || t==='pagamento') ? '' : 'none';
    }
  }
}

function renderCupons(){
  if (!tbodyCupons) return;
  let arr = STATE.cupons || [];
  const q  = (buscaCupomInput?.value || '').trim().toLowerCase();
  const fs = (filtroCupomStatus?.value || 'todos');

  if (fs === 'ativos') {
    arr = arr.filter(c => c.status === 'ativo');
  } else if (fs === 'usados') {
    arr = arr.filter(c => c.status === 'usado' || c.status === 'resgatado');
  } else if (fs === 'expirados') {
    arr = arr.filter(c => c.status === 'expirado');
  }

  if (q) {
    arr = arr.filter(c =>
      (c.codigo && c.codigo.toLowerCase().includes(q)) ||
      (c.resgatadoPor && c.resgatadoPor.toLowerCase().includes(q))
    );
  }

  if (!arr.length) {
    tbodyCupons.innerHTML = `<tr><td colspan="6" class="muted" style="padding:14px">Sem cupons ainda.</td></tr>`;
    return;
  }

  tbodyCupons.innerHTML = arr.map(c => {
    const valTxt = typeof c.valorCentavos === 'number'
      ? fmtBRL(c.valorCentavos)
      : (typeof c.valorCents === 'number' ? fmtBRL(c.valorCents) : '');
    const exp = c.expiraEm || c.expira_em || null;
    const expTxt = exp ? new Date(exp).toLocaleString('pt-BR') : '—';
    const resgPor = c.resgatadoPor || c.resgatado_por || '';

    let status = c.status || 'ativo';
    let statusLabel = 'Ativo';
    let statusCls = 'badge';
    if (status === 'ativo') {
      statusLabel = 'Ativo';
      statusCls = 'badge badge--ativo';
    } else if (status === 'expirado') {
      statusLabel = 'Expirado';
      statusCls = 'badge badge--expirado';
    } else if (status === 'usado' || status === 'resgatado') {
      statusLabel = 'Resgatado';
      statusCls = 'badge badge--usado';
    } else {
      statusLabel = esc(status);
    }

    const actions = status === 'ativo'
      ? `
        <button class="btn btn--ghost" data-action="cupom-copy" data-id="${c.id}">Copiar</button>
        <button class="btn btn--danger" data-action="cupom-del" data-id="${c.id}">Excluir</button>`
      : `
        <button class="btn btn--danger" data-action="cupom-del" data-id="${c.id}">Excluir</button>`;

    return `
      <tr data-id="${c.id}">
        <td>${esc(c.codigo || '')}</td>
        <td>${valTxt}</td>
        <td><span class="${statusCls}">${statusLabel}</span></td>
        <td>${expTxt}</td>
        <td>${resgPor ? esc(resgPor) : '—'}</td>
        <td class="col-acoes">
          <div style="display:flex;gap:8px;align-items:center">${actions}</div>
        </td>
      </tr>`;
  }).join('');
}

async function setTab(tab){
  TAB = tab;
  localStorage.setItem('area_tab', tab);
  qsa('.nav-btn').forEach(btn=> btn.classList.toggle('active', btn.dataset.tab === tab));
  await refresh();
  if (TAB !== 'bancas') hideTotaisPopup();
}

async function refresh(){
  if (TAB==='bancas'){
    await loadBancas();
  } else if (TAB==='pagamentos'){
    await loadPagamentos();
  } else if (TAB==='extratos'){
    await loadExtratos();
  } else if (TAB==='cupons'){
    await loadCupons();
  } else if (TAB==='sorteio') {
    
  } else if (TAB==='palpite') {
    
    if (window.PalpiteAdmin && typeof window.PalpiteAdmin.refresh === 'function') {
      try { await window.PalpiteAdmin.refresh(); } catch(e){ console.error(e); }
    }
  }
  render();
}

function getBancaInputById(id){
  return document.querySelector(`input[data-role="banca"][data-id="${CSS.escape(id)}"]`);
}

async function toPagamento(id){
  const inp = getBancaInputById(id);
  if (inp) {
    const cents = toCents(inp.value);
    await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
      method:'PATCH',
      body: JSON.stringify({ bancaCents: cents })
    });
  }
  await apiFetch(`/api/bancas/${encodeURIComponent(id)}/to-pagamento`, { method:'POST' });
  await Promise.all([loadBancas(), loadPagamentos()]);
  render();
  setupAutoDeleteTimers();
}

async function toBanca(id){
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}/to-banca`, { method:'POST' });
  await Promise.all([loadPagamentos(), loadBancas()]);
  render();
  const t = STATE.timers.get(id);
  if (t){ clearTimeout(t); STATE.timers.delete(id); }
}

async function deleteBanca(id){
  await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, { method:'DELETE' });
  await loadBancas();
  render();
}

async function deleteAllBancas(){
  if (!STATE.bancas.length) {
    if (typeof notify === 'function') notify('Não há bancas para excluir.', 'error');
    else alert('Não há bancas para excluir.');
    return;
  }

  const total = STATE.bancas.length;
  const ok = confirm(`Tem certeza que deseja excluir todas as ${total} bancas? Essa ação não pode ser desfeita.`);
  if (!ok) return;

  try {
    const ids = STATE.bancas.map(b => b.id);

    await Promise.all(
      ids.map(id =>
        apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
          method:'DELETE'
        })
      )
    );

    await loadBancas();
    render();

    if (typeof notify === 'function') {
      notify('Todas as bancas foram excluídas.', 'ok');
    }
  } catch (err) {
    console.error(err);
    if (typeof notify === 'function') notify('Erro ao excluir todas as bancas.', 'error');
    else alert('Erro ao excluir todas as bancas.');
  }
}

async function deletePagamento(id){
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}`, { method:'DELETE' });
  await loadPagamentos();
  render();
  const t = STATE.timers.get(id);
  if (t){ clearTimeout(t); STATE.timers.delete(id); }
}

async function deleteCupom(id){
  await apiFetch(`/api/cupons/${encodeURIComponent(id)}`, { method:'DELETE' });
  await loadCupons();
  if (TAB === 'cupons') renderCupons();
}

async function setStatus(id, value){
  const body = JSON.stringify({ status: value });
  await apiFetch(`/api/pagamentos/${encodeURIComponent(id)}`, { method:'PATCH', body });
  await loadPagamentos();
  render();

  const item = STATE.pagamentos.find(x=>x.id===id);
  if (!item) return;
  if (value === 'pago') {
    scheduleAutoDelete(item);
  } else {
    const t = STATE.timers.get(id);
    if (t){ clearTimeout(t); STATE.timers.delete(id); }
  }
}

function scheduleAutoDelete(item){
  const { id, paidAt } = item;
  if (!paidAt) return;
  const left = (new Date(paidAt).getTime() + 3*60*1000) - Date.now();
  const prev = STATE.timers.get(id);
  if (prev) clearTimeout(prev);
  if (left <= 0) { deletePagamento(id).catch(()=>{}); return; }
  const tid = setTimeout(()=> deletePagamento(id).catch(()=>{}), left);
  STATE.timers.set(id, tid);
}

function setupAutoDeleteTimers(){
  STATE.timers.forEach(t=> clearTimeout(t));
  STATE.timers.clear();
  STATE.pagamentos.forEach(p=>{
    if (p.status === 'pago' && p.paidAt) scheduleAutoDelete(p);
  });
}

let payPixModalEl = null;

function ensurePayPixModal() {
  if (payPixModalEl) return payPixModalEl;

  const dlg = document.createElement('dialog');
  dlg.id = 'payPixModal';
  dlg.className = 'pix-modal';

  injectOnce('payPixBackdropCSS', `
    dialog.pix-modal::backdrop{ background: rgba(8,12,26,.65); backdrop-filter: blur(6px) saturate(.9); }
    .pix-card{ width:min(94vw,520px); color:#e7e9f3; background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
      border:1px solid rgba(255,255,255,.12); border-radius:14px; box-shadow:0 28px 80px rgba(0,0,0,.55); padding:16px; }
    .pix-title{ margin:0 0 8px; font-weight:800 }
    .pix-qr-wrap{ display:flex; justify-content:center; margin:8px 0 12px }
    .pix-qr{ display:block; width:240px; height:240px }
    .pix-code{ display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center }
    .pix-emv{ width:100% }
    .pix-status{ margin:10px 0 0; color:#b3b8cc }
    .pix-actions{ display:flex; gap:8px; justify-content:flex-end; margin-top:12px }
  `);

  const card = document.createElement('div');
  card.className = 'pix-card';
  card.innerHTML = `
    <h3 class="pix-title">Escaneie para pagar</h3>
    <div class="pix-qr-wrap"><img id="payPixQr" class="pix-qr" alt="QR Code Pix"></div>
    <div class="pix-code">
      <input id="payPixEmv" class="pix-emv" readonly>
      <button id="payPixCopy" class="btn btn--primary">Copiar</button>
    </div>
    <p class="pix-status" id="payPixHint">O valor já está preenchido. Após enviar, feche e marque como <strong>Pago</strong>.</p>
    <div class="pix-actions">
      <button id="payPixClose" class="btn btn--ghost">Fechar</button>
    </div>
  `;
  dlg.appendChild(card);
  document.body.appendChild(dlg);

  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); dlg.close(); });

  dlg.querySelector('#payPixCopy').onclick = async () => {
    const emv = dlg.querySelector('#payPixEmv')?.value || '';
    if (!emv) return;
    await navigator.clipboard.writeText(emv);
    if (typeof notify === 'function') notify('Código copia-e-cola copiado!');
  };
  dlg.querySelector('#payPixClose').onclick = () => dlg.close();

  payPixModalEl = dlg;
  return dlg;
}

function abrirPixModal(id){
  const p = STATE.pagamentos.find(x=>x.id===id);
  if(!p) return;

  const emv = buildPixBRCode({
    chave: p.pixKey || '',
    valorCents: Number(p.pagamentoCents || 0),
    nome: p.nome || 'RECEBEDOR',
    cidade: 'BRASILIA',
    txid: '***',
    tipo: p.pixType || null
  });

  const dlg = ensurePayPixModal();
  const img = dlg.querySelector('#payPixQr');
  const emvEl = dlg.querySelector('#payPixEmv');

  emvEl.value = emv;

  const size = 240;
  const url  = `${API}/qr?size=${size}&data=${encodeURIComponent(emv)}`;
  img.style.display = '';
  img.removeAttribute('src');
  img.onerror = () => { img.style.display = 'none'; };
  img.src = url;

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open','');
}

let msgModalEl = null;
function injectOnce(id, css){
  if (document.getElementById(id)) return;
  const st = document.createElement('style');
  st.id = id;
  st.textContent = css;
  document.head.appendChild(st);
}
function ensureMsgModal(){
  if (msgModalEl) return msgModalEl;

  injectOnce('msgModalBackdropCSS', `
    #msgModal::backdrop{ background: rgba(8,12,26,.65); backdrop-filter: blur(6px) saturate(.9); }
    #msgModal .box h3{ margin:0 0 8px; font-weight:800 }
    #msgModal .box p{ margin:0 0 12px; color:#cfd2e8; white-space:pre-wrap; line-height:1.5 }
  `);

  const dlg = document.createElement('dialog');
  dlg.id = 'msgModal';
  dlg.style.border='0';
  dlg.style.padding='0';
  dlg.style.background='transparent';

  const box = document.createElement('div');
  box.className = 'box';
  box.style.width='min(94vw,560px)';
  box.style.background='linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.05))';
  box.style.border='1px solid rgba(255,255,255,.18)';
  box.style.borderRadius='16px';
  box.style.boxShadow='0 30px 90px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.04)';
  box.style.padding='18px';
  box.style.color='#e7e9f3';
  box.innerHTML = `
    <h3>Mensagem</h3>
    <p id="msgText"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn--ghost" data-action="close-msg">Fechar</button>
    </div>
  `;
  dlg.appendChild(box);
  document.body.appendChild(dlg);

  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="close-msg"]');
    if (b) dlg.close();
  });

  msgModalEl = dlg;
  return dlg;
}
function abrirMensagem(texto){
  const dlg = ensureMsgModal();
  const p = dlg.querySelector('#msgText');
  p.textContent = (texto && String(texto).trim()) ? String(texto) : '(sem mensagem)';
  dlg.showModal();
}

let addBancaModalEl = null;

function ensureAddBancaModal(){
  if (addBancaModalEl) return addBancaModalEl;

  injectOnce('addBancaModalCSS', `
    #addBancaModal::backdrop{
      background: rgba(8,12,26,.65);
      backdrop-filter: blur(6px) saturate(.9);
    }
    #addBancaModal{
      border:0;
      padding:0;
      background:transparent;
    }
    .add-banca-card{
      width:min(96vw,640px);
      background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04));
      border-radius:16px;
      border:1px solid rgba(255,255,255,.15);
      box-shadow:0 30px 90px rgba(0,0,0,.7);
      padding:18px 18px 16px;
      color:#e7e9f3;
    }
    .add-banca-header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:8px;
      margin-bottom:10px;
    }
    .add-banca-title{
      margin:0;
      font-size:1.1rem;
      font-weight:800;
    }
    .add-banca-sub{
      margin:2px 0 0;
      font-size:0.8rem;
      opacity:0.8;
    }
    .add-banca-close{
      border:0;
      background:transparent;
      color:#f5f5f5;
      font-size:20px;
      line-height:1;
      cursor:pointer;
    }
    .add-banca-form{
      display:grid;
      gap:10px;
    }
    .add-banca-row{
      display:grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr);
      gap:10px;
    }
    .add-banca-field{
      display:grid;
      gap:4px;
      font-size:0.85rem;
    }
    .add-banca-pix-row{
      display:grid;
      grid-template-columns:minmax(120px, .8fr) minmax(0, 1.4fr);
      gap:8px;
    }
    .add-banca-actions{
      margin-top:4px;
      display:flex;
      justify-content:flex-end;
      gap:8px;
    }
    @media (max-width: 600px){
      .add-banca-row{ grid-template-columns: minmax(0,1fr); }
      .add-banca-pix-row{ grid-template-columns:minmax(0,1fr); }
    }
  `);

  const dlg = document.createElement('dialog');
  dlg.id = 'addBancaModal';
  dlg.innerHTML = `
    <div class="add-banca-card">
      <div class="add-banca-header">
        <div>
          <h3 class="add-banca-title">Adicionar banca</h3>
          <p class="add-banca-sub">Crie uma banca manual informando depósito e PIX da pessoa.</p>
        </div>
        <button type="button" class="add-banca-close" data-add-banca-close>&times;</button>
      </div>

      <form id="addBancaForm" class="add-banca-form">
        <div class="add-banca-row">
          <div class="add-banca-field">
            <label class="muted" for="addBancaNome">Nome</label>
            <input id="addBancaNome" class="input" autocomplete="off" placeholder="ex: dudufpss">
          </div>
          <div class="add-banca-field">
            <label class="muted" for="addBancaDeposito">Depósito (R$)</label>
            <input id="addBancaDeposito" class="input" autocomplete="off" placeholder="ex: 50,00">
          </div>
        </div>

        <div class="add-banca-field">
          <label class="muted" for="addPixType">PIX da pessoa</label>
          <div class="add-banca-pix-row">
            <select id="addPixType" class="input">
              <option value="">Tipo de chave</option>
              <option value="email">E-mail</option>
              <option value="cpf">CPF</option>
              <option value="phone">Telefone</option>
              <option value="random">Chave aleatória</option>
            </select>
            <input id="addPixKey" class="input" autocomplete="off" placeholder="chave PIX (e-mail, CPF, tel.)">
          </div>
        </div>

        <div class="add-banca-actions">
          <button type="button" class="btn btn--ghost" data-add-banca-close>Cancelar</button>
          <button type="submit" class="btn btn--primary">Salvar banca</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(dlg);

  dlg.addEventListener('click', (e)=>{
    if (e.target === dlg || e.target.closest('[data-add-banca-close]')) {
      dlg.close();
    }
  });
  dlg.addEventListener('cancel', (e)=>{ e.preventDefault(); dlg.close(); });

  const form      = dlg.querySelector('#addBancaForm');
  const depInput  = dlg.querySelector('#addBancaDeposito');
  const pixTypeEl = dlg.querySelector('#addPixType');
  const pixKeyEl  = dlg.querySelector('#addPixKey');

  if (depInput) {
    depInput.addEventListener('input', ()=> formatMoneyInputEl(depInput));
  }

  if (pixTypeEl && pixKeyEl) {
    const updatePlaceholder = ()=>{
      const t = pixTypeEl.value;
      if (t === 'email') pixKeyEl.placeholder = 'e-mail da pessoa';
      else if (t === 'cpf') pixKeyEl.placeholder = 'CPF (somente números)';
      else if (t === 'phone') pixKeyEl.placeholder = 'Telefone com DDD (somente números)';
      else pixKeyEl.placeholder = 'chave PIX (e-mail, CPF, tel.)';
    };
    pixTypeEl.addEventListener('change', ()=>{
      const t = pixTypeEl.value;
      const digits = pixKeyEl.value.replace(/\D/g,'');
      if (t === 'cpf')      pixKeyEl.value = formatCPF(digits);
      else if (t === 'phone') pixKeyEl.value = formatPhoneBR(digits);
      updatePlaceholder();
    });

    pixKeyEl.addEventListener('input', ()=>{
      const t = pixTypeEl.value;
      const digits = pixKeyEl.value.replace(/\D/g,'');
      if (t === 'cpf')      pixKeyEl.value = formatCPF(digits);
      else if (t === 'phone') pixKeyEl.value = formatPhoneBR(digits);
    });

    pixKeyEl.addEventListener('blur', ()=>{
      const t = pixTypeEl.value;
      const digits = pixKeyEl.value.replace(/\D/g,'');
      if (t === 'cpf')      pixKeyEl.value = formatCPF(digits);
      else if (t === 'phone') pixKeyEl.value = formatPhoneBR(digits);
    });

    updatePlaceholder();
  }

  form.addEventListener('submit', handleAddBancaSubmit);

  addBancaModalEl = dlg;
  return dlg;
}

async function handleAddBancaSubmit(e){
  e.preventDefault();
  const dlg = ensureAddBancaModal();
  const nomeEl    = dlg.querySelector('#addBancaNome');
  const depEl     = dlg.querySelector('#addBancaDeposito');
  const pixTypeEl = dlg.querySelector('#addPixType');
  const pixKeyEl  = dlg.querySelector('#addPixKey');

  const nome     = String(nomeEl.value || '').trim();
  const depositoCents = toCents(depEl.value);
  const pixType  = pixTypeEl.value || '';
  const pixKey   = normalizePixKeyByType(pixType, pixKeyEl.value);

  if (!nome || !depositoCents) {
    if (typeof notify === 'function') notify('Preencha nome e depósito.', 'error');
    else alert('Preencha nome e depósito.');
    return;
  }

  const submitBtn = dlg.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.disabled = true;

  try{
    await apiFetch('/api/bancas/manual', {
      method:'POST',
      body: JSON.stringify({ nome, depositoCents, pixKey, pixType })
    });

    nomeEl.value    = '';
    depEl.value     = '';
    pixTypeEl.value = '';
    pixKeyEl.value  = '';

    dlg.close();

    await loadBancas();
    render();
    setupAutoDeleteTimers();
    if (typeof notify === 'function') notify('Banca adicionada com sucesso.', 'ok');
  }catch(err){
    console.error(err);
    if (typeof notify === 'function') notify('Erro ao criar banca manual.', 'error');
    else alert('Erro ao criar banca manual.');
  }finally{
    if (submitBtn) submitBtn.disabled = false;
  }
}

let cupomModalEl = null;

function ensureCupomModal(){
  if (cupomModalEl) return cupomModalEl;

  injectOnce('cupomModalCSS', `
    #cupomModal::backdrop{
      background: rgba(8,12,26,.65);
      backdrop-filter: blur(6px) saturate(.9);
    }
    #cupomModal{
      border:0;
      padding:0;
      background:transparent;
    }
    .cupom-card{
      width:min(96vw,520px);
      background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04));
      border-radius:16px;
      border:1px solid rgba(255,255,255,.15);
      box-shadow:0 30px 90px rgba(0,0,0,.7);
      padding:18px 18px 16px;
      color:#e7e9f3;
    }
    .cupom-header{
      display:flex;
      justify-content:space-between;
      align-items:flex-start;
      gap:8px;
      margin-bottom:10px;
    }
    .cupom-title{
      margin:0;
      font-size:1.1rem;
      font-weight:800;
    }
    .cupom-sub{
      margin:2px 0 0;
      font-size:0.8rem;
      opacity:0.8;
    }
    .cupom-close{
      border:0;
      background:transparent;
      color:#f5f5f5;
      font-size:20px;
      line-height:1;
      cursor:pointer;
    }
    .cupom-form{
      display:grid;
      gap:10px;
    }
    .cupom-field{
      display:grid;
      gap:4px;
      font-size:0.85rem;
    }
    .cupom-actions{
      margin-top:4px;
      display:flex;
      justify-content:flex-end;
      gap:8px;
    }
  `);

  const dlg = document.createElement('dialog');
  dlg.id = 'cupomModal';
  dlg.innerHTML = `
    <div class="cupom-card">
      <div class="cupom-header">
        <div>
          <h3 class="cupom-title">Gerar cupom</h3>
          <p class="cupom-sub">Cupom válido para um único resgate.</p>
        </div>
        <button type="button" class="cupom-close" data-cupom-close>&times;</button>
      </div>

      <form id="cupomForm" class="cupom-form">
        <div class="cupom-field">
          <label class="muted" for="cupomValor">Valor do cupom (R$)</label>
          <input id="cupomValor" class="input" autocomplete="off" placeholder="ex: 200,00">
        </div>

        <div class="cupom-field">
          <label class="muted" for="cupomCodigo">Código (opcional)</label>
          <input id="cupomCodigo" class="input" autocomplete="off" placeholder="se vazio, gera automático">
        </div>

        <div class="cupom-field">
          <label class="muted" for="cupomDias">Validade em dias</label>
          <input id="cupomDias" class="input" type="number" min="1" value="3">
        </div>

        <div class="cupom-actions">
          <button type="button" class="btn btn--ghost" data-cupom-close>Cancelar</button>
          <button type="submit" class="btn btn--primary">Criar cupom</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(dlg);

  dlg.addEventListener('click', (e)=>{
    if (e.target === dlg || e.target.closest('[data-cupom-close]')) {
      dlg.close();
    }
  });
  dlg.addEventListener('cancel', (e)=>{ e.preventDefault(); dlg.close(); });

  const form    = dlg.querySelector('#cupomForm');
  const valorEl = dlg.querySelector('#cupomValor');
  if (valorEl) {
    valorEl.addEventListener('input', ()=> formatMoneyInputEl(valorEl));
  }
  form.addEventListener('submit', handleCupomSubmit);

  cupomModalEl = dlg;
  return dlg;
}

async function handleCupomSubmit(e){
  e.preventDefault();
  const dlg      = ensureCupomModal();
  const valorEl  = dlg.querySelector('#cupomValor');
  const codigoEl = dlg.querySelector('#cupomCodigo');
  const diasEl   = dlg.querySelector('#cupomDias');

  const valorCents = toCents(valorEl.value);
  const codigo     = (codigoEl.value || '').trim();
  let dias         = parseInt(diasEl.value,10);
  if (!Number.isFinite(dias) || dias <= 0) dias = 3;

  if (!valorCents){
    if (typeof notify === 'function') notify('Informe o valor do cupom.', 'error');
    else alert('Informe o valor do cupom.');
    return;
  }

  const btn = dlg.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;

  try{
    const created = await apiFetch('/api/cupons', {
      method:'POST',
      body: JSON.stringify({
        valorCentavos: valorCents,
        diasValidade: dias,
        codigo: codigo || undefined
      })
    });

    valorEl.value  = '';
    codigoEl.value = '';
    diasEl.value   = '3';

    dlg.close();

    await loadCupons();
    renderCupons();

    const codeShown = created?.codigo || created?.code || codigo;
    if (typeof notify === 'function' && codeShown) {
      notify(`Cupom criado: ${codeShown}`, 'ok');
    }
  }catch(err){
    console.error(err);
    if (typeof notify === 'function') notify('Erro ao criar cupom.', 'error');
    else alert('Erro ao criar cupom.');
  }finally{
    if (btn) btn.disabled = false;
  }
}

async function copyCupomCodigo(id){
  const c = STATE.cupons.find(x=>x.id===id);
  if (!c || !c.codigo) return;
  try{
    await navigator.clipboard.writeText(c.codigo);
    if (typeof notify === 'function') notify('Código do cupom copiado!', 'ok');
  }catch(err){
    console.error(err);
  }
}

let statusMenuEl = null;
let statusMenuId = null;

function ensureStatusMenu(){
  if(statusMenuEl) return statusMenuEl;
  const el = document.createElement('div');
  el.className = 'status-float';
  el.innerHTML = `
    <button class="status-item pago" data-value="pago">Pago</button>
    <button class="status-item nao"  data-value="nao_pago">Não pago</button>
  `;
  document.body.appendChild(el);

  el.addEventListener('click', (e)=>{
    const btn = e.target.closest('button.status-item');
    if(!btn) return;
    if(statusMenuId){
      setStatus(statusMenuId, btn.dataset.value).catch(console.error);
    }
    hideStatusMenu();
  });

  statusMenuEl = el;
  return el;
}

function showStatusMenu(anchorBtn, id, current){
  const m = ensureStatusMenu();
  statusMenuId = id;

  qsa('.status-item', m).forEach(b=> b.classList.toggle('active', b.dataset.value === current));

  const r = anchorBtn.getBoundingClientRect();
  m.style.display = 'block';
  m.style.visibility = 'hidden';
  const mh = m.getBoundingClientRect().height;
  const mw = m.getBoundingClientRect().width;
  m.style.visibility = '';

  const spaceBelow = window.innerHeight - r.bottom;
  let top = r.bottom + 6;
  if(spaceBelow < mh + 8){ top = r.top - mh - 6; }
  const left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);

  m.style.top  = `${Math.round(top)}px`;
  m.style.left = `${Math.round(left)}px`;
  m.classList.add('show');
}

function hideStatusMenu(){
  if(statusMenuEl){
    statusMenuEl.classList.remove('show');
    statusMenuEl.style.display = 'none';
  }
  statusMenuId = null;
}

document.addEventListener('click', (e)=>{
  const openBtn = e.target.closest('button[data-action="status-open"]');
  if(openBtn){
    const id = openBtn.dataset.id;
    const current = openBtn.dataset.status || 'nao_pago';
    hideStatusMenu();
    showStatusMenu(openBtn, id, current);
    e.stopPropagation();
    return;
  }
  if(!e.target.closest('.status-float')) hideStatusMenu();
});

document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action="ver-msg"]');
  if(!btn) return;
  const id = btn.dataset.id;
  const b = STATE.bancas.find(x=>x.id===id);
  const p = STATE.pagamentos.find(x=>x.id===id);
  const msg = (b?.message ?? p?.message) || '';
  abrirMensagem(msg);
});

document.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;
  const {action, id} = btn.dataset;
  if(action==='to-pagamento') return toPagamento(id).catch(console.error);
  if(action==='del-banca')    return deleteBanca(id).catch(console.error);
  if(action==='fazer-pix')    return abrirPixModal(id);
  if(action==='del-pag')      return deletePagamento(id).catch(console.error);
  if(action==='to-banca')     return toBanca(id).catch(console.error);
  if(action==='cupom-del')    return deleteCupom(id).catch(console.error);
  if(action==='cupom-copy')   return copyCupomCodigo(id).catch(console.error);
});

document.addEventListener('click', (e)=>{
  if (e.target.closest('#totaisPopup')) return;
  if (e.target.closest('.totais')) return;
  hideTotaisPopup();
});

document.addEventListener('focusin', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  STATE.editingBancaId = inp.dataset.id || null;
});
document.addEventListener('focusout', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  saveBancaInline(inp).catch(console.error).finally(()=>{
    const still = document.activeElement?.closest?.('input[data-role="banca"]');
    STATE.editingBancaId = still ? still.dataset.id : null;
  });
}, true);

async function saveBancaInline(inp){
  const id = inp.dataset.id;
  const cents = toCents(inp.value);
  const item = STATE.bancas.find(x=>x.id===id);
  if (item) item.bancaCents = cents;

  try{
    await apiFetch(`/api/bancas/${encodeURIComponent(id)}`, {
      method:'PATCH',
      body: JSON.stringify({ bancaCents: cents })
    });
  }catch(err){ console.error(err); }
  updateTotals();
}

document.addEventListener('input', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  formatMoneyInputEl(inp);
});

document.addEventListener('keydown', (e)=>{
  const inp = e.target.closest('input[data-role="banca"]');
  if(!inp) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    inp.blur();
  }
});

function filtrarTabela(tbody, q){
  if(!tbody) return;
  const query = (q||'').trim().toLowerCase();
  [...tbody.querySelectorAll('tr')].forEach(tr=>{
    tr.style.display = tr.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

buscaInput?.addEventListener('input', ()=>{
  const q = buscaInput.value || '';
  if (TAB==='bancas') filtrarTabela(tbodyBancas, q);
  else if (TAB==='pagamentos') filtrarTabela(tbodyPags,   q);
});

buscaCupomInput?.addEventListener('input', ()=>{
  if (TAB === 'cupons') renderCupons();
});
filtroCupomStatus?.addEventListener('change', ()=>{
  if (TAB === 'cupons') renderCupons();
});

function readExtratoFiltersFromDOM(){
  const f = STATE.filtrosExtratos;
  if (filtroTipo)  f.tipo  = filtroTipo.value || 'all';
  if (filtroRange) f.range = filtroRange.value || 'last30';
  if (filtroFrom)  f.from  = filtroFrom.value || null;
  if (filtroTo)    f.to    = filtroTo.value   || null;
}
function applyExtratoFiltersUIRules(){
  if (!filtroRange) return;
  const isCustom = filtroRange.value === 'custom';
  if (filtroFrom) filtroFrom.disabled = !isCustom;
  if (filtroTo)   filtroTo.disabled   = !isCustom;
}

buscaExtratoInput?.addEventListener('input', ()=>{ if (TAB==='extratos') renderExtratos(); });
filtroTipo?.addEventListener('change',  async ()=>{ readExtratoFiltersFromDOM(); await loadExtratos(); renderExtratos(); });
filtroRange?.addEventListener('change', async ()=>{ applyExtratoFiltersUIRules(); readExtratoFiltersFromDOM(); await loadExtratos(); renderExtratos(); });
btnFiltrar?.addEventListener('click',   async ()=>{ readExtratoFiltersFromDOM(); await loadExtratos(); renderExtratos(); });
btnLimpar?.addEventListener('click',    async ()=>{
  if (filtroTipo)  filtroTipo.value  = 'all';
  if (filtroRange) filtroRange.value = 'last30';
  if (filtroFrom)  filtroFrom.value  = '';
  if (filtroTo)    filtroTo.value    = '';
  applyExtratoFiltersUIRules();
  readExtratoFiltersFromDOM();
  await loadExtratos();
  renderExtratos();
});

let es = null;
function startStream(){
  if (es) try { es.close(); } catch {}
  es = new EventSource(`${API}/api/stream`);

  const softRefreshBancas = debounce(async () => {
    const focused = document.activeElement;
    const isEditing = !!focused?.matches?.('input[data-role="banca"]');
    if (isEditing) return;
    await loadBancas();
    if (TAB === 'bancas') render();
  }, 200);

  const softRefreshPags = debounce(async () => {
    await loadPagamentos();
    if (TAB === 'pagamentos') {
      render();
      setupAutoDeleteTimers();
    }
  }, 200);

  const softRefreshExt = debounce(async () => {
    await loadExtratos();
    if (TAB === 'extratos') renderExtratos();
  }, 200);

  const softRefreshCupons = debounce(async () => {
    await loadCupons();
    if (TAB === 'cupons') renderCupons();
  }, 200);

  es.addEventListener('bancas-changed',     softRefreshBancas);
  es.addEventListener('pagamentos-changed', softRefreshPags);
  es.addEventListener('extratos-changed',   softRefreshExt);
  es.addEventListener('cupons-changed',     softRefreshCupons);
  es.addEventListener('ping', () => {});

  es.onerror = () => {
    try { es.close(); } catch {}
    setTimeout(startStream, 3000);
  };
}

document.addEventListener('DOMContentLoaded', async ()=>{
  qsa('.nav-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === TAB);
    btn.addEventListener('click', ()=> setTab(btn.dataset.tab));
  });

  const btnAddBanca = qs('#btnAddBanca');
  if (btnAddBanca) {
    btnAddBanca.addEventListener('click', ()=>{
      const dlg = ensureAddBancaModal();
      const nomeEl    = dlg.querySelector('#addBancaNome');
      const depEl     = dlg.querySelector('#addBancaDeposito');
      const pixTypeEl = dlg.querySelector('#addPixType');
      const pixKeyEl  = dlg.querySelector('#addPixKey');

      if (nomeEl)    nomeEl.value = '';
      if (depEl)     depEl.value  = '';
      if (pixTypeEl) pixTypeEl.value = '';
      if (pixKeyEl)  pixKeyEl.value  = '';

      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open','');

      nomeEl?.focus();
    });
  }

  const btnDelAllBancas = qs('#btnDelAllBancas');
  if (btnDelAllBancas) {
    btnDelAllBancas.addEventListener('click', deleteAllBancas);
  }

  const btnCupomNovo = qs('#btnCupomNovo');
  if (btnCupomNovo) {
    btnCupomNovo.addEventListener('click', ()=>{
      const dlg = ensureCupomModal();
      const valorEl  = dlg.querySelector('#cupomValor');
      const codigoEl = dlg.querySelector('#cupomCodigo');
      const diasEl   = dlg.querySelector('#cupomDias');

      if (valorEl)  valorEl.value  = '';
      if (codigoEl) codigoEl.value = '';
      if (diasEl)   diasEl.value   = '3';

      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open','');

      valorEl?.focus();
    });
  }

  applyExtratoFiltersUIRules();
  readExtratoFiltersFromDOM();

  const loaders = [loadBancas(), loadPagamentos()];
  if (tabExtratosEl) loaders.push(loadExtratos());
  if (tabCuponsEl)   loaders.push(loadCupons());
  await Promise.all(loaders);

  setupAutoDeleteTimers();
  render();

  const totalDepEl = getTotalDepEl();
  const totalBanEl = getTotalBanEl();
  if (totalDepEl) {
    totalDepEl.style.cursor = 'pointer';
    totalDepEl.classList.add('totais-pill');
    totalDepEl.addEventListener('click', ()=> showTotaisPopup('depositos', totalDepEl));
  }
  if (totalBanEl) {
    totalBanEl.style.cursor = 'pointer';
    totalBanEl.classList.add('totais-pill');
    totalBanEl.addEventListener('click', ()=> showTotaisPopup('bancas', totalBanEl));
  }

  
  if (window.PalpiteAdmin && typeof window.PalpiteAdmin.init === 'function') {
    try { window.PalpiteAdmin.init(); } catch(e){ console.error(e); }
  }

  startStream();
  startCuponsAutoRefresh();
});

const qs = (s) => document.querySelector(s);

const form = qs('#cashbackForm');
const twitchName = qs('#twitchName');
const pixType = qs('#pixType');
const pixKey = qs('#pixKey');
const screenshot = qs('#screenshot');
const pickBtn = qs('#pickBtn');
const previewImg = qs('#previewImg');
const previewEmpty = qs('#previewEmpty');
const submitResult = qs('#submitResult');
const sendBtn = qs('#sendBtn');
const submitBadge = qs('#submitBadge');

const statusUser = qs('#statusUser');
const checkBtn = qs('#checkBtn');
const statusResult = qs('#statusResult');
const statusBadge = qs('#statusBadge');

const rankList = qs('#rankList');
const apiStatus = qs('#apiStatus');
const keyChip = qs('#keyChip');

const params = new URLSearchParams(location.search);
const key = params.get('key') || '';

function setApiStatus(text) {
  apiStatus.textContent = text;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function pill(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'APROVADO') return `<span class="pill good"><span class="dot"></span>APROVADO</span>`;
  if (s === 'REPROVADO') return `<span class="pill bad"><span class="dot"></span>REPROVADO</span>`;
  return `<span class="pill warn"><span class="dot"></span>PENDENTE</span>`;
}

function setBadge(el, text, cls) {
  el.textContent = text;
  el.classList.remove('live', 'soft');
  if (cls) el.classList.add(cls);
}

function formatDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR');
}

async function apiFetch(url, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  headers['X-APP-KEY'] = key;
  const res = await fetch(url, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = data?.error || `http_${res.status}`;
    throw new Error(msg);
  }
  return data;
}

let screenshotDataUrl = null;

pickBtn.addEventListener('click', () => screenshot.click());

screenshot.addEventListener('change', async () => {
  const file = screenshot.files?.[0] || null;
  screenshotDataUrl = null;

  if (!file) {
    previewImg.style.display = 'none';
    previewEmpty.style.display = 'grid';
    return;
  }

  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    screenshot.value = '';
    previewImg.style.display = 'none';
    previewEmpty.style.display = 'grid';
    submitResult.innerHTML = `<div class="msgTitle">Formato inválido</div><div class="msgLine">Use PNG, JPG ou WEBP.</div>`;
    return;
  }

  if (file.size > 4.5 * 1024 * 1024) {
    screenshot.value = '';
    previewImg.style.display = 'none';
    previewEmpty.style.display = 'grid';
    submitResult.innerHTML = `<div class="msgTitle">Imagem muito grande</div><div class="msgLine">Reduza o tamanho (até ~4,5MB).</div>`;
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('read_error'));
    fr.readAsDataURL(file);
  });

  screenshotDataUrl = dataUrl;
  previewImg.src = dataUrl;
  previewImg.style.display = 'block';
  previewEmpty.style.display = 'none';
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();

  if (!key) {
    submitResult.innerHTML = `<div class="msgTitle">Link inválido</div><div class="msgLine">Falta o parâmetro <strong>?key=</strong>.</div>`;
    return;
  }

  const body = {
    twitchName: twitchName.value.trim(),
    pixType: pixType.value,
    pixKey: pixKey.value.trim(),
    screenshotDataUrl: screenshotDataUrl
  };

  if (!body.twitchName || !body.pixKey) {
    submitResult.innerHTML = `<div class="msgTitle">Preencha os campos</div><div class="msgLine">Nick da Twitch e chave Pix são obrigatórios.</div>`;
    return;
  }

  sendBtn.disabled = true;
  setBadge(submitBadge, 'Enviando…', 'soft');
  submitResult.innerHTML = `<div class="msgTitle">Enviando…</div><div class="msgLine">Aguarde só um instante.</div>`;

  try {
    const data = await apiFetch('/api/cashback/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    setBadge(submitBadge, 'Enviado', 'live');
    submitResult.innerHTML =
      `<div class="msgTitle">Pedido enviado ✅</div>
       <div class="msgLine">Protocolo: <strong>${esc(data.id)}</strong></div>
       <div class="msgLine">Use <strong>!status</strong> no chat ou consulte abaixo com seu nick.</div>`;

    statusUser.value = twitchName.value.trim();
    await checkStatus(statusUser.value.trim());
  } catch (e) {
    setBadge(submitBadge, 'Falhou', '');
    const msg = String(e.message || 'erro');
    let nice = msg;

    if (msg === 'screenshot_grande') nice = 'Imagem grande demais.';
    if (msg === 'screenshot_invalida') nice = 'Screenshot inválida.';
    if (msg === 'dados_invalidos') nice = 'Dados inválidos. Verifique os campos.';
    if (msg.startsWith('http_413')) nice = 'Imagem grande demais.';

    submitResult.innerHTML =
      `<div class="msgTitle">Não foi possível enviar</div>
       <div class="msgLine">${esc(nice)}</div>`;
  } finally {
    sendBtn.disabled = false;
    setTimeout(() => setBadge(submitBadge, 'Formulário', 'live'), 1300);
  }
});

async function checkStatus(user) {
  const u = String(user || '').trim();
  if (!u) {
    statusResult.innerHTML = `<div class="msgLine">Digite seu nick da Twitch.</div>`;
    setBadge(statusBadge, 'Aguardando', '');
    return;
  }

  if (!key) {
    statusResult.innerHTML = `<div class="msgLine">Link sem <strong>?key=</strong>.</div>`;
    setBadge(statusBadge, 'Bloqueado', '');
    return;
  }

  checkBtn.disabled = true;
  setBadge(statusBadge, 'Consultando…', 'soft');
  statusResult.innerHTML = `<div class="msgLine">Buscando seu status…</div>`;

  try {
    const st = await apiFetch(`/api/cashback/status/${encodeURIComponent(u)}`, { method: 'GET' });

    const html =
      `<div>${pill(st.status)}</div>
       <div class="kv">
         <div class="kvRow"><span>Nick</span><strong>${esc(st.twitchName || u)}</strong></div>
         <div class="kvRow"><span>Atualizado</span><strong>${esc(formatDate(st.updatedAt))}</strong></div>
         <div class="kvRow"><span>Prazo</span><strong>${esc(st.payoutWindow || '—')}</strong></div>
         <div class="kvRow"><span>Motivo</span><strong>${esc(st.reason || '—')}</strong></div>
       </div>`;

    statusResult.innerHTML = html;

    const s = String(st.status || '').toUpperCase();
    if (s === 'APROVADO') setBadge(statusBadge, 'Aprovado', 'live');
    else if (s === 'REPROVADO') setBadge(statusBadge, 'Reprovado', '');
    else setBadge(statusBadge, 'Pendente', 'soft');
  } catch (e) {
    const msg = String(e.message || '');
    if (msg === 'not_found') {
      statusResult.innerHTML = `<div class="msgLine">Nenhum pedido encontrado pra <strong>${esc(u)}</strong>.</div>`;
      setBadge(statusBadge, 'Sem registro', '');
    } else {
      statusResult.innerHTML = `<div class="msgLine">Erro ao consultar.</div>`;
      setBadge(statusBadge, 'Falha', '');
    }
  } finally {
    checkBtn.disabled = false;
  }
}

checkBtn.addEventListener('click', () => checkStatus(statusUser.value));
statusUser.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') checkStatus(statusUser.value);
});

async function loadRanking() {
  if (!key) {
    rankList.innerHTML = `<div class="muted">Falta <strong>?key=</strong> no link.</div>`;
    return;
  }

  try {
    const data = await apiFetch('/api/cashback/ranking?limit=10', { method: 'GET' });
    const rows = data?.rows || [];

    if (!rows.length) {
      rankList.innerHTML = `<div class="muted">Ainda não há aprovados.</div>`;
      return;
    }

    rankList.innerHTML = rows.map((r, idx) => {
      const pos = idx + 1;
      return `
        <div class="rankItem" style="animation-delay:${Math.min(idx * 0.04, 0.3)}s">
          <div class="rankLeft">
            <div class="rankPos">${pos}</div>
            <div class="rankName">${esc(r.user || '')}</div>
          </div>
          <div class="rankRight">${esc(String(r.approved || 0))}</div>
        </div>
      `;
    }).join('');
  } catch {
    rankList.innerHTML = `<div class="muted">Não foi possível carregar o ranking.</div>`;
  }
}

function init() {
  keyChip.textContent = key ? `Chave pública: ${key.slice(0, 6)}…${key.slice(-4)}` : 'Chave pública: ausente';
  setApiStatus('ok');
  loadRanking();
}

init();

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

function getMeta(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.content : '';
}

const APP_KEY = window.APP_PUBLIC_KEY || getMeta('app-key') || '';

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

function setBadge(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.classList.remove('live', 'soft');
  if (cls) el.classList.add(cls);
}

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function maskCPF(raw) {
  let v = digits(raw).slice(0, 11);
  v = v.replace(/(\d{3})(\d)/, '$1.$2')
       .replace(/(\d{3})(\d)/, '$1.$2')
       .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  return v;
}

function isCPFValid(cpf) {
  cpf = digits(cpf);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;

  let s = 0;
  for (let i = 1; i <= 9; i++) s += parseInt(cpf.substring(i - 1, i), 10) * (11 - i);
  let r = (s * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== parseInt(cpf.substring(9, 10), 10)) return false;

  s = 0;
  for (let i = 1; i <= 10; i++) s += parseInt(cpf.substring(i - 1, i), 10) * (12 - i);
  r = (s * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === parseInt(cpf.substring(10, 11), 10);
}

function maskPhone(raw) {
  let v = digits(raw).slice(0, 11);
  if (v.length > 2) v = `(${v.slice(0, 2)}) ${v.slice(2)}`;
  if (v.length > 10) v = `${v.slice(0, 10)}-${v.slice(10)}`;
  return v;
}

function isEmail(v) {
  return /.+@.+\..+/.test(String(v || '').trim());
}

async function apiFetch(url, opts = {}) {
  if (!APP_KEY) throw new Error('app_key_ausente');

  const headers = Object.assign({}, opts.headers || {});
  headers['X-APP-KEY'] = APP_KEY;

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

function setPixPlaceholder() {
  const t = String(pixType?.value || 'random');
  if (!pixKey) return;

  if (t === 'cpf') pixKey.placeholder = '000.000.000-00';
  else if (t === 'phone') pixKey.placeholder = '(00) 90000-0000';
  else if (t === 'email') pixKey.placeholder = 'seu@email.com';
  else pixKey.placeholder = 'Ex.: 2e1a-...';
}

function normalizePixKeyForSend() {
  const t = String(pixType?.value || 'random');
  const v = String(pixKey?.value || '').trim();

  if (t === 'cpf') return digits(v);
  if (t === 'phone') return digits(v).slice(-11);
  return v;
}

function validatePixKey() {
  const t = String(pixType?.value || 'random');
  const v = String(pixKey?.value || '').trim();

  if (!v) return { ok: false, msg: 'Chave Pix é obrigatória.' };

  if (t === 'cpf') {
    if (!isCPFValid(v)) return { ok: false, msg: 'CPF inválido.' };
    return { ok: true };
  }

  if (t === 'email') {
    if (!isEmail(v)) return { ok: false, msg: 'E-mail inválido.' };
    return { ok: true };
  }

  if (t === 'phone') {
    const d = digits(v);
    if (d.length !== 11) return { ok: false, msg: 'Telefone inválido (11 dígitos).' };
    return { ok: true };
  }

  if (String(v).length < 10) return { ok: false, msg: 'Chave aleatória inválida.' };
  return { ok: true };
}

pickBtn?.addEventListener('click', () => screenshot?.click());

pixType?.addEventListener('change', () => {
  setPixPlaceholder();
  const t = String(pixType.value || 'random');
  if (t === 'cpf') pixKey.value = maskCPF(pixKey.value);
  if (t === 'phone') pixKey.value = maskPhone(pixKey.value);
});

pixKey?.addEventListener('input', () => {
  const t = String(pixType?.value || 'random');
  if (t === 'cpf') pixKey.value = maskCPF(pixKey.value);
  if (t === 'phone') pixKey.value = maskPhone(pixKey.value);
});

screenshot?.addEventListener('change', async () => {
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

form?.addEventListener('submit', async (ev) => {
  ev.preventDefault();

  const nick = String(twitchName?.value || '').trim();
  if (!nick) {
    submitResult.innerHTML = `<div class="msgTitle">Preencha os campos</div><div class="msgLine">Nick da Twitch é obrigatório.</div>`;
    return;
  }

  const pixCheck = validatePixKey();
  if (!pixCheck.ok) {
    submitResult.innerHTML = `<div class="msgTitle">Verifique a chave</div><div class="msgLine">${esc(pixCheck.msg || 'Chave inválida.')}</div>`;
    return;
  }

  if (!screenshotDataUrl) {
    submitResult.innerHTML = `<div class="msgTitle">Falta o print</div><div class="msgLine">Selecione print para enviar.</div>`;
    return;
  }

  sendBtn.disabled = true;
  setBadge(submitBadge, 'Enviando…', 'soft');
  submitResult.innerHTML = `<div class="msgTitle">Enviando…</div><div class="msgLine">Aguarde só um instante.</div>`;

  try {
    const body = {
      twitchName: nick,
      pixType: pixType?.value || 'random',
      pixKey: normalizePixKeyForSend(),
      screenshotDataUrl
    };

    const data = await apiFetch('/api/cashback/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    setBadge(submitBadge, 'Enviado', 'live');
    submitResult.innerHTML =
      `<div class="msgTitle">Pedido enviado ✅</div>
       <div class="msgLine">Protocolo: <strong>${esc(data.id)}</strong></div>
       <div class="msgLine">Acompanhe pelo chat se foi aprovado para receber seu cashback com <strong>!status</strong>.</div>`;

    form.reset();
    screenshotDataUrl = null;
    previewImg.style.display = 'none';
    previewEmpty.style.display = 'grid';
    setPixPlaceholder();
  } catch (e) {
    setBadge(submitBadge, 'Falhou', '');
    const msg = String(e.message || 'erro');
    let nice = msg;

    if (msg === 'screenshot_grande') nice = 'Imagem grande demais.';
    if (msg === 'screenshot_invalida') nice = 'Screenshot inválida.';
    if (msg === 'screenshot_obrigatoria') nice = 'O print é obrigatório.';
    if (msg === 'dados_invalidos') nice = 'Dados inválidos. Verifique os campos.';
    if (msg === 'pix_invalido') nice = 'Chave Pix inválida.';
    if (msg === 'app_key_ausente') nice = 'Página sem chave pública configurada.';
    if (msg.startsWith('http_413')) nice = 'Imagem grande demais.';

    submitResult.innerHTML =
      `<div class="msgTitle">Não foi possível enviar</div>
       <div class="msgLine">${esc(nice)}</div>`;
  } finally {
    sendBtn.disabled = false;
    setTimeout(() => setBadge(submitBadge, 'Formulário', 'live'), 1300);
  }
});

setPixPlaceholder();
if (!APP_KEY) {
  submitResult.innerHTML = `<div class="msgTitle">Configuração</div><div class="msgLine">Falta a chave pública no HTML (meta app-key).</div>`;
}

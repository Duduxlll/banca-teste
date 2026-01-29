(function () { 
  const API = window.location.origin;

  let inscritos = [];
  let spinning = false;
  let startAngle = 0;
  let animId = null;
  let ultimoVencedor = null;

  const canvas = document.getElementById('sorteioWheel');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');

  const colors = [
    '#ffd76b', '#ffb366', '#ff8a80', '#ff9ecd',
    '#b39fff', '#7ecbff', '#80e8c2', '#c6ff8f'
  ];

  async function carregarInscritosSorteio(silent){
    try {
      const res = await fetch(`${API}/api/sorteio/inscricoes`);
      inscritos = await res.json();
      if (!Array.isArray(inscritos)) inscritos = [];

      atualizarTabelaSorteio();
      desenharRoletaSorteio();

      if (!silent && typeof notify === 'function') {
        notify('Lista de inscritos do sorteio atualizada.', 'ok');
      }
    } catch (err) {
      console.error('Erro ao carregar inscritos do sorteio', err);
      if (!silent && typeof notify === 'function') {
        notify('Erro ao carregar inscritos do sorteio.', 'error');
      } else if (!silent) {
        window.alert('Erro ao carregar inscritos do sorteio.');
      }
    }
  }

  function atualizarTabelaSorteio(){
    const tbody = document.getElementById('tbodySorteio');
    const totalEl = document.getElementById('sorteioTotalInscritos');
    if (!tbody || !totalEl) return;

    tbody.innerHTML = '';

    totalEl.textContent =
      `${inscritos.length} inscrito${inscritos.length === 1 ? '' : 's'}`;

    for (const ins of inscritos) {
      const tr = document.createElement('tr');

      const tdNome = document.createElement('td');
      tdNome.textContent = ins.nome_twitch;
      tr.appendChild(tdNome);

      const tdData = document.createElement('td');
      const d = new Date(ins.criado_em);
      tdData.textContent =
        `${d.toLocaleDateString('pt-BR')} ` +
        d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      tr.appendChild(tdData);

      const tdAcoes = document.createElement('td');
      const btnDel = document.createElement('button');
      btnDel.textContent = 'Excluir';
      btnDel.className = 'btn-mini-del';
      btnDel.onclick = () => excluirInscritoSorteio(ins.id);
      tdAcoes.appendChild(btnDel);
      tr.appendChild(tdAcoes);

      tbody.appendChild(tr);
    }
  }

  async function excluirInscritoSorteio(id){
    if (!id) return;
    try {
      const res = await fetch(`${API}/api/sorteio/inscricoes/${id}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!data || data.ok !== true) throw new Error('Resposta inválida da API');

      inscritos = inscritos.filter(i => i.id !== id);
      atualizarTabelaSorteio();
      desenharRoletaSorteio();

      if (typeof notify === 'function') {
        notify('Inscrito removido do sorteio.', 'ok');
      }
    } catch (err) {
      console.error('Erro ao excluir inscrito do sorteio', err);
      if (typeof notify === 'function') {
        notify('Erro ao excluir inscrito do sorteio.', 'error');
      } else {
        window.alert('Erro ao excluir inscrito do sorteio.');
      }
    }
  }

  let confirmModalEl = null;
  let confirmResolve = null;

  function ensureSorteioConfirmModal(){
    if (confirmModalEl) return confirmModalEl;

    if (typeof injectOnce === 'function') {
      injectOnce('sorteioConfirmCSS',
        'dialog#sorteioConfirmModal::backdrop{' +
          'background:rgba(8,12,26,0.7);' +
          'backdrop-filter:blur(6px) saturate(0.9);' +
        '}' +
        '.sorteio-confirm-box{' +
          'width:min(94vw,420px);' +
          'background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.04));' +
          'border:1px solid rgba(255,255,255,.18);' +
          'border-radius:16px;' +
          'box-shadow:0 30px 90px rgba(0,0,0,.65),0 0 0 1px rgba(255,255,255,.04);' +
          'padding:18px;' +
          'color:#e7e9f3;' +
        '}' +
        '.sorteio-confirm-title{' +
          'margin:0 0 6px;' +
          'font-weight:800;' +
          'font-size:1rem;' +
        '}' +
        '.sorteio-confirm-text{' +
          'margin:0 0 12px;' +
          'font-size:0.9rem;' +
          'color:#cfd2e8;' +
        '}' +
        '.sorteio-confirm-actions{' +
          'display:flex;' +
          'gap:8px;' +
          'justify-content:flex-end;' +
          'margin-top:4px;' +
        '}'
      );
    }

    const dlg = document.createElement('dialog');
    dlg.id = 'sorteioConfirmModal';
    dlg.style.border = '0';
    dlg.style.padding = '0';
    dlg.style.background = 'transparent';

    const box = document.createElement('div');
    box.className = 'sorteio-confirm-box';
    box.innerHTML =
      '<h3 class="sorteio-confirm-title">Confirmar ação</h3>' +
      '<p class="sorteio-confirm-text" data-confirm-msg></p>' +
      '<div class="sorteio-confirm-actions">' +
        '<button type="button" class="btn btn--ghost" data-action="cancel">Cancelar</button>' +
        '<button type="button" class="btn btn--danger" data-action="confirm">Apagar tudo</button>' +
      '</div>';

    dlg.appendChild(box);
    document.body.appendChild(dlg);

    dlg.addEventListener('click', function(e){
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const act = btn.getAttribute('data-action');
      dlg.close();
      if (confirmResolve) {
        confirmResolve(act === 'confirm');
        confirmResolve = null;
      }
    });

    dlg.addEventListener('cancel', function(e){
      e.preventDefault();
      dlg.close();
      if (confirmResolve) {
        confirmResolve(false);
        confirmResolve = null;
      }
    });

    confirmModalEl = dlg;
    return dlg;
  }

  function showSorteioConfirm(message){
    return new Promise(function(resolve){
      const dlg = ensureSorteioConfirmModal();
      const msgEl = dlg.querySelector('[data-confirm-msg]');
      if (msgEl) msgEl.textContent = message || '';
      confirmResolve = resolve;
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    });
  }

  async function limparTodosSorteio(){
    if (!inscritos.length) {
      if (typeof notify === 'function') {
        notify('Não há inscrições para limpar.', 'error');
      }
      return;
    }

    const ok = await showSorteioConfirm(
      'Tem certeza que deseja apagar TODAS as inscrições do sorteio? Essa ação não pode ser desfeita.'
    );
    if (!ok) return;

    try {
      const res = await fetch(`${API}/api/sorteio/inscricoes`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!data || data.ok !== true) throw new Error('Resposta inválida da API');

      inscritos = [];
      atualizarTabelaSorteio();
      desenharRoletaSorteio();

      if (typeof notify === 'function') {
        notify('Todas as inscrições do sorteio foram removidas.', 'ok');
      }
    } catch (err) {
      console.error('Erro ao limpar inscrições do sorteio', err);
      if (typeof notify === 'function') {
        notify('Erro ao limpar inscrições do sorteio.', 'error');
      } else {
        window.alert('Erro ao limpar inscrições do sorteio.');
      }
    }
  }

  function desenharRoletaSorteio(){
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const outsideRadius = Math.min(w, h) / 2 - 10;
  const textRadius = outsideRadius - 24;

  ctx.clearRect(0, 0, w, h);

  const n = inscritos.length || 1;
  const arc = (Math.PI * 2) / n;

  for (let i = 0; i < n; i++) {
    const angle = startAngle + i * arc;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outsideRadius, angle, angle + arc, false);
    ctx.closePath();
    ctx.fillStyle = inscritos.length ? colors[i % colors.length] : '#333';
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle + arc / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#111';
    ctx.font = '12px system-ui';
    const label = inscritos.length ? (inscritos[i].nome_twitch || '') : 'Sem inscritos';
    ctx.fillText(label, textRadius, 4);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, 55, 0, Math.PI * 2);
  ctx.fillStyle = '#061b10';
  ctx.fill();
  ctx.strokeStyle = 'rgba(34,224,122,.55)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#7CFFB3';
  ctx.font = 'bold 16px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('SORTEIO', cx, cy + 6);
}


  function calcularIndiceVencedorPeloAngulo(angleFinal){
    if (!inscritos.length) return -1;
    const n = inscritos.length;
    const arc = (Math.PI * 2) / n;
    const pointerAngle = (3 * Math.PI) / 2;
    const twoPi = Math.PI * 2;

    let diff = pointerAngle - angleFinal;
    diff = ((diff % twoPi) + twoPi) % twoPi;

    const idx = Math.floor(diff / arc);
    return idx % n;
  }

  function girarRoletaSorteio(){
    if (spinning || !inscritos.length) return;
    spinning = true;

    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }

    const twoPi = Math.PI * 2;
    const initialAngle = ((startAngle % twoPi) + twoPi) % twoPi;
    const voltasExtras = 5 + Math.random() * 3;
    const offsetAleatorio = Math.random() * twoPi;
    const finalAngle = initialAngle + voltasExtras * twoPi + offsetAleatorio;

    const duration = 3500;
    const startTime = performance.now();

    const winnerLabel = document.getElementById('sorteioWinnerLabel');
    const btnGirar = document.getElementById('btnSorteioGirar');
    const btnVerCodigo = document.getElementById('btnSorteioVerCodigo');
    const winnerBox = document.getElementById('sorteioWinnerBox');

    if (winnerLabel) winnerLabel.textContent = 'Girando…';
    if (btnVerCodigo) btnVerCodigo.style.display = 'none';

    if (btnGirar) {
      btnGirar.disabled = true;
      btnGirar.classList.add('is-spinning');
    }

    function easeOutCubic(t){
      return 1 - Math.pow(1 - t, 3);
    }

    function step(now){
      const t = Math.min(1, (now - startTime) / duration);
      const eased = easeOutCubic(t);
      startAngle = initialAngle + (finalAngle - initialAngle) * eased;
      desenharRoletaSorteio();

      if (t < 1) {
        animId = requestAnimationFrame(step);
      } else {
        animId = null;
        spinning = false;

        const normalized = ((startAngle % twoPi) + twoPi) % twoPi;
        startAngle = normalized;

        const winnerIndex = calcularIndiceVencedorPeloAngulo(normalized);
        const vencedor = inscritos[winnerIndex] || null;
        ultimoVencedor = vencedor || null;

        if (winnerLabel) {
          if (vencedor && vencedor.nome_twitch) {
            winnerLabel.innerHTML = 'Vencedor: <strong>' + vencedor.nome_twitch + '</strong>';
          } else {
            winnerLabel.textContent = 'Vencedor: —';
          }
        }

        if (btnVerCodigo) {
          if (vencedor && vencedor.mensagem) {
            btnVerCodigo.style.display = 'inline-block';
          } else {
            btnVerCodigo.style.display = 'none';
          }
        }

        if (btnGirar) {
          btnGirar.disabled = false;
          btnGirar.classList.remove('is-spinning');
        }

        if (winnerBox) {
          winnerBox.classList.remove('flash');
          void winnerBox.offsetWidth;
          winnerBox.classList.add('flash');
        }

        if (vencedor && typeof notify === 'function') {
          notify('Vencedor: ' + vencedor.nome_twitch, 'ok');
        }
      }
    }

    animId = requestAnimationFrame(step);
  }

  let idModalEl = null;

  function ensureIdModal(){
    if (idModalEl) return idModalEl;

    if (typeof injectOnce === 'function') {
      injectOnce('idModalBackdropCSS',
        'dialog#idModal::backdrop{' +
        'background:rgba(8,12,26,0.65);' +
        'backdrop-filter:blur(6px) saturate(0.9);' +
        '}'
      );
    }

    const dlg = document.createElement('dialog');
    dlg.id = 'idModal';
    dlg.style.border = '0';
    dlg.style.padding = '0';
    dlg.style.background = 'transparent';

    const box = document.createElement('div');
    box.style.width = 'min(94vw,420px)';
    box.style.background = 'linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04))';
    box.style.border = '1px solid rgba(255,255,255,.18)';
    box.style.borderRadius = '16px';
    box.style.boxShadow = '0 30px 90px rgba(0,0,0,.65), 0 0 0 1px rgba(255,255,255,.04)';
    box.style.padding = '18px';
    box.style.color = '#e7e9f3';
    box.innerHTML =
        '<h3 style="margin:0 0 6px;font-weight:800">ID do vencedor</h3>'
      + '<p style="margin:0 0 4px;font-size:0.9rem;color:#cfd2e8">'
      + 'Use esse ID para confirmar com a pessoa na live.'
      + '</p>'
      + '<div class="id-modal-code">'
      + '  <div>'
      + '    <div class="id-modal-label">Nome Twitch</div>'
      + '    <div class="id-modal-value" data-id-nome>—</div>'
      + '  </div>'
      + '  <div>'
      + '    <div class="id-modal-label">ID</div>'
      + '    <div class="id-modal-value id-modal-value--code" data-id-valor>—</div>'
      + '  </div>'
      + '</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">'
      + '  <button type="button" class="btn btn--ghost" data-action="close-id">Fechar</button>'
      + '  <button type="button" class="btn btn--primary" data-action="copy-id">Copiar ID</button>'
      + '</div>';

    dlg.appendChild(box);
    document.body.appendChild(dlg);

    dlg.addEventListener('click', function(e){
      const closeBtn = e.target.closest('[data-action="close-id"]');
      const copyBtn  = e.target.closest('[data-action="copy-id"]');
      if (closeBtn) dlg.close();
      if (copyBtn) {
        const valEl = dlg.querySelector('[data-id-valor]');
        const text = (valEl && valEl.textContent || '').trim();
        if (text) {
          navigator.clipboard.writeText(text).then(function(){
            if (typeof notify === 'function') {
              notify('ID copiado para a área de transferência.', 'ok');
            }
          }).catch(function(){});
        }
      }
    });

    idModalEl = dlg;
    return dlg;
  }

  function abrirIdModal(vencedor){
    if (!vencedor) return;
    const dlg = ensureIdModal();
    const nomeEl  = dlg.querySelector('[data-id-nome]');
    const valorEl = dlg.querySelector('[data-id-valor]');
    if (nomeEl)  nomeEl.textContent = vencedor.nome_twitch || '—';
    if (valorEl) valorEl.textContent = vencedor.mensagem || '—';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  const btnGirarEl     = document.getElementById('btnSorteioGirar');
  const btnAtualizarEl = document.getElementById('btnSorteioAtualizar');
  const btnLimparEl    = document.getElementById('btnSorteioLimpar');
  const btnVerCodigoEl = document.getElementById('btnSorteioVerCodigo');

  if (btnGirarEl) btnGirarEl.addEventListener('click', girarRoletaSorteio);

  if (btnAtualizarEl) {
    btnAtualizarEl.addEventListener('click', async function(){
      btnAtualizarEl.classList.add('is-loading');
      await carregarInscritosSorteio(false);
      btnAtualizarEl.classList.remove('is-loading');
    });
  }

  if (btnLimparEl) btnLimparEl.addEventListener('click', limparTodosSorteio);

  if (btnVerCodigoEl) {
    btnVerCodigoEl.addEventListener('click', function(){
      if (!ultimoVencedor || !ultimoVencedor.mensagem) {
        if (typeof notify === 'function') {
          notify('Nenhum ID disponível para este vencedor.', 'error');
        } else {
          window.alert('Nenhum ID disponível para este vencedor.');
        }
        return;
      }
      abrirIdModal(ultimoVencedor);
    });
  }

  carregarInscritosSorteio(true);
})();

(function () {
  const API = window.location.origin;

  const form      = document.getElementById('sp-form');
  const nomeInput = document.getElementById('sp-nomeTwitch');
  const idInput   = document.getElementById('sp-id');
  const btn       = document.getElementById('sp-btn-enviar');
  const statusEl  = document.getElementById('sp-status');
  const anoEl     = document.getElementById('sp-ano');
  const toastEl   = document.getElementById('toast');

  if (!form) return;

  if (anoEl) anoEl.textContent = new Date().getFullYear();

  let toastTimer = null;

  function notify(msg, type){
    if (!toastEl) return;
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastEl.textContent = msg || '';
    toastEl.className = 'toast';
    if (type === 'ok') toastEl.classList.add('toast--ok');
    if (type === 'error') toastEl.classList.add('toast--error');
    toastEl.classList.add('toast--show');
    toastTimer = setTimeout(function(){
      toastEl.classList.remove('toast--show');
    }, 3500);
  }

  function setStatus(msg, type){
    if (statusEl) {
      statusEl.textContent = msg || '';
      statusEl.className = 'sp-status';
      if (type === 'ok') statusEl.classList.add('sp-status--ok');
      if (type === 'error') statusEl.classList.add('sp-status--error');
    }
    if (msg) notify(msg, type);
  }

  async function handleSubmit(e){
    e.preventDefault();

    const nome = (nomeInput.value || '').trim();
    const id   = (idInput.value   || '').trim();

    if (!nome || !id) {
      setStatus('Preencha seu nome da Twitch e o ID.', 'error');
      return;
    }

    if (id.length < 3) {
      setStatus('O ID precisa ter pelo menos 3 caracteres.', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando...';
    setStatus('', null);

    try{
      const res = await fetch(`${API}/api/sorteio/inscrever`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({
          nome_twitch: nome,
          mensagem: id
        })
      });

      const data = await res.json().catch(function(){ return null; });

      if (!res.ok) {
        if (res.status === 409 || (data && data.code === 'ID_DUPLICADO')) {
          setStatus('Esse ID já está cadastrado no sorteio. Use seu id certo.', 'error');
        } else {
          setStatus((data && data.error) || 'Erro ao enviar sua inscrição. Tente novamente.', 'error');
        }
        return;
      }

      if (!data || data.ok !== true) {
        setStatus('Não foi possível confirmar a inscrição. Tente novamente.', 'error');
        return;
      }

      setStatus('Inscrição enviada! Aguarde o sorteio.', 'ok');
      nomeInput.value = '';
    } catch (err){
      console.error(err);
      setStatus('Falha de conexão. Verifique sua internet e tente de novo.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar no sorteio';
    }
  }

  form.addEventListener('submit', handleSubmit);
})();

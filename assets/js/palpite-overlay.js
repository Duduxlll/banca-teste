(() => {
  const API = window.location.origin;
  const qs = (s, r=document) => r.querySelector(s);

  const key = new URLSearchParams(location.search).get("key") || "";
  const elList = qs("#ovList");
  const elSub = qs("#ovSub");
  const elStatus = qs("#ovStatus");

  function esc(s=""){ return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));}

  function setStatus(isOpen){
    if (!elStatus) return;
    elStatus.textContent = isOpen ? "ABERTO" : "FECHADO";
    elStatus.classList.toggle("open", !!isOpen);
  }

  function renderList(lastGuesses){
    if (!elList) return;
    const arr = Array.isArray(lastGuesses) ? lastGuesses : [];
    elList.innerHTML = arr.map((g, i) => `
      <div class="ov-row">
        <span class="ov-i">#${i+1}</span>
        <span class="ov-name">${esc(g.name)}</span>
        <span class="ov-val">R$ ${Number(g.value).toFixed(2)}</span>
      </div>
    `).join("");
  }

  if (!key) {
    if (elSub) elSub.textContent = "Faltou a key na URL (?key=...)";
    return;
  }

  const es = new EventSource(`${API}/api/palpite/stream?key=${encodeURIComponent(key)}`);

  es.addEventListener("state", (e) => {
    const st = JSON.parse(e.data || "{}");
    setStatus(st.isOpen);
    if (elSub) {
      const buy = st.buyValue ? `Compra: R$ ${Number(st.buyValue).toFixed(2)} • ` : "";
      elSub.textContent = `${buy}Digite no chat: !231 (somente valor)`;
    }
    renderList(st.lastGuesses || []);
  });

  es.addEventListener("guess", (e) => {
    const st = JSON.parse(e.data || "{}");
    
  });

  es.onerror = () => {
    try { es.close(); } catch {}
    setTimeout(() => location.reload(), 1500);
  };
})();

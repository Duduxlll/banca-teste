import tmiPkg from "tmi.js";

export function initTwitchBot({
  port,
  apiKey,
  botUsername,
  oauthToken,
  channel,
  enabled = true,
  onLog = console,
  cashbackPublicUrl
}) {
  const log = onLog || console;

  if (!enabled) {
    log.log("[twitch-bot] desativado por config.");
    return { enabled: false, say: async () => {}, client: null };
  }

  if (!port || !apiKey || !botUsername || !oauthToken || !channel) {
    log.log("[twitch-bot] faltam envs (TWITCH_* e APP_PUBLIC_KEY). Bot não iniciado.");
    return { enabled: false, say: async () => {}, client: null };
  }

  const tmi = tmiPkg?.default ?? tmiPkg;
  const chan = channel.startsWith("#") ? channel : `#${channel}`;
  const pass = oauthToken.startsWith("oauth:") ? oauthToken : `oauth:${oauthToken}`;

  const publicUrl =
    cashbackPublicUrl ||
    process.env.CASHBACK_PUBLIC_URL ||
    "https://banca-teste.onrender.com/cashback-publico.html";

  const client = new tmi.Client({
    options: { debug: false },
    connection: { reconnect: true, secure: true },
    identity: { username: botUsername, password: pass },
    channels: [chan],
  });

  let queue = Promise.resolve();
  const enqueue = (fn) => {
    queue = queue.then(fn).catch((e) => log.error("[twitch-bot] erro:", e));
  };

  function parseCommand(msg) {
    const text = String(msg || "").trim();
    if (!text.startsWith("!")) return null;

    let m = text.match(/^!palpite\b\s*(.+)$/i) || text.match(/^!p\b\s*(.+)$/i);
    if (m && m[1]) return { type: "guess", payload: m[1].trim() };

    if (/^!cashback\b/i.test(text)) return { type: "cashback" };

    if (/^!status\b/i.test(text)) return { type: "status" };

    return null;
  }

  async function submitGuessToServer(user, rawGuess) {
    const url = `http://127.0.0.1:${port}/api/palpite/guess?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ user, guess: rawGuess, source: "twitch" }),
    });

    return res.ok;
  }

  async function getCashbackStatus(user) {
    const url = `http://127.0.0.1:${port}/api/cashback/status/${encodeURIComponent(user)}?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });

    if (res.status === 404) return { notFound: true };
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) return { error: data?.error || `http_${res.status}` };

    return { ok: true, data };
  }

  client.on("connected", () => {
    log.log(`[twitch-bot] conectado em ${chan} como ${botUsername}`);
  });

  client.on("message", (channelName, tags, message, self) => {
    if (self) return;

    const userTag = (tags.username || "").trim();
    const display = (tags["display-name"] || tags.username || "").trim();
    const user = display || userTag;
    if (!user) return;

    const cmd = parseCommand(message);
    if (!cmd) return;

    enqueue(async () => {
      if (cmd.type === "guess") {
        await submitGuessToServer(user, cmd.payload);
        return;
      }

      if (cmd.type === "cashback") {
        await say(`Cashback: envie aqui 👉 ${publicUrl}`);
        return;
      }

      if (cmd.type === "status") {
        const st = await getCashbackStatus(userTag || user);
        if (st.notFound) {
          await say(`@${userTag || user} você ainda não tem pedido. Use !cashback`);
          return;
        }
        if (st.error) {
          await say(`@${userTag || user} não consegui consultar agora. Tenta de novo já já.`);
          return;
        }

        const s = String(st.data?.status || "").toUpperCase();
        const reason = String(st.data?.reason || "").trim();
        const prazo = String(st.data?.payoutWindow || "").trim();

        if (s === "APROVADO") {
          await say(`@${userTag || user} APROVADO ✅ ${prazo ? `• ${prazo}` : ""}`.trim());
        } else if (s === "REPROVADO") {
          await say(`@${userTag || user} REPROVADO ❌ ${reason ? `• ${reason}` : ""}`.trim());
        } else {
          await say(`@${userTag || user} PENDENTE ⏳ Aguarde a análise.`);
        }
        return;
      }
    });
  });

  client.connect().catch((e) => log.error("[twitch-bot] falha ao conectar:", e));

  async function say(msg) {
    try {
      await client.say(chan, msg);
    } catch (e) {
      log.error("[twitch-bot] falha ao enviar msg:", e);
    }
  }

  return { enabled: true, say, client };
}

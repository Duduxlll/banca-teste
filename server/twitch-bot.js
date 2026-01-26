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

  if (globalThis.__TWITCH_BOT_SINGLETON__) {
    return globalThis.__TWITCH_BOT_SINGLETON__;
  }

  if (!enabled) {
    log.log("[twitch-bot] desativado por config.");
    const api = { enabled: false, say: async () => {}, client: null };
    globalThis.__TWITCH_BOT_SINGLETON__ = api;
    return api;
  }

  if (!port || !apiKey || !botUsername || !oauthToken || !channel) {
    log.log("[twitch-bot] faltam envs (TWITCH_* e APP_PUBLIC_KEY). Bot não iniciado.");
    const api = { enabled: false, say: async () => {}, client: null };
    globalThis.__TWITCH_BOT_SINGLETON__ = api;
    return api;
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

  async function say(msg) {
    try {
      await client.say(chan, msg);
    } catch (e) {
      log.error("[twitch-bot] falha ao enviar msg:", e);
    }
  }

  const recent = new Map();
  function isDuplicate(userKey, cmdKey) {
    const key = `${userKey}|${cmdKey}`;
    const now = Date.now();
    const last = recent.get(key) || 0;
    if (now - last < 1500) return true;
    recent.set(key, now);
    if (recent.size > 500) {
      const cutoff = now - 60000;
      for (const [k, t] of recent.entries()) if (t < cutoff) recent.delete(k);
    }
    return false;
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

    const userKey = userTag || user;
    const cmdKey = cmd.type === "guess" ? `guess:${cmd.payload || ""}` : cmd.type;

    if (isDuplicate(userKey, cmdKey)) return;

    enqueue(async () => {
      if (cmd.type === "guess") {
        await submitGuessToServer(user, cmd.payload);
        return;
      }

      if (cmd.type === "cashback") {
        const mention = userTag ? `@${userTag}` : `@${user}`;
        await say(`${mention} Cadastre-se na !melbet !borawin e envie o print do cadastro/depósito ${publicUrl} • Pra ver se foi aprovado: !status`);
        return;
      }

      if (cmd.type === "status") {
        const mention = userTag ? `@${userTag}` : `@${user}`;
        const st = await getCashbackStatus(userTag || user);
        if (st.notFound) {
          await say(`${mention} você ainda não pediu seu cashback. Use !cashback`);
          return;
        }
        if (st.error) {
          await say(`${mention} não consegui consultar agora. Tenta de novo já já.`);
          return;
        }

        const s = String(st.data?.status || "").toUpperCase();
        const reason = String(st.data?.reason || "").trim();
        const prazo = String(st.data?.payoutWindow || "").trim();

        if (s === "APROVADO") {
          await say(`${mention} APROVADO ✅${prazo ? ` • ${prazo}` : ""}`.trim());
        } else if (s === "REPROVADO") {
          await say(`${mention} REPROVADO ❌${reason ? ` • ${reason}` : ""}`.trim());
        } else {
          await say(`${mention} PENDENTE ⏳ aguarde a análise.`);
        }
        return;
      }
    });
  });

  client.connect().catch((e) => log.error("[twitch-bot] falha ao conectar:", e));

  const api = { enabled: true, say, client };
  globalThis.__TWITCH_BOT_SINGLETON__ = api;

  return api;
}

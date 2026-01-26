import tmiPkg from "tmi.js";

export function initTwitchBot({
  port,
  apiKey,
  botUsername,
  oauthToken,
  channel,
  cashbackUrl = "",
  enabled = true,
  onLog = console,
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
    if (m && m[1]) return { cmd: "palpite", arg: m[1].trim() };

    if (/^!cashback\b/i.test(text)) return { cmd: "cashback" };
    if (/^!status\b/i.test(text)) return { cmd: "status" };

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
    const url = `http://127.0.0.1:${port}/api/cashback/status/${encodeURIComponent(user)}`;

    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-APP-KEY": apiKey },
    });

    let data = null;
    try { data = await res.json(); } catch {}

    if (!res.ok) {
      const msg = data?.error || `http_${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  const statusCooldown = new Map();
  function canCheckStatus(user) {
    const now = Date.now();
    const last = statusCooldown.get(user) || 0;
    if (now - last < 8000) return false;
    statusCooldown.set(user, now);
    return true;
  }

  client.on("connected", () => {
    log.log(`[twitch-bot] conectado em ${chan} como ${botUsername}`);
  });

  client.on("message", (channelName, tags, message, self) => {
    if (self) return;

    const user = (tags.username || tags["display-name"] || "").trim();
    if (!user) return;

    const cmd = parseCommand(message);
    if (!cmd) return;

    enqueue(async () => {
      if (cmd.cmd === "palpite") {
        await submitGuessToServer(user, cmd.arg);
        return;
      }

      if (cmd.cmd === "cashback") {
        const link = String(cashbackUrl || "").trim();
        if (!link) {
          await client.say(chan, `@${user} cashback: link não configurado no bot.`);
        } else {
          await client.say(chan, `@${user} para pedir cashback: ${link}`);
        }
        return;
      }

      if (cmd.cmd === "status") {
        if (!canCheckStatus(user)) return;

        try {
          const st = await getCashbackStatus(user);
          const s = String(st.status || "PENDENTE").toUpperCase();
          const prazo = st.payoutWindow ? ` | prazo: ${st.payoutWindow}` : "";
          const motivo = st.reason ? ` | motivo: ${st.reason}` : "";

          if (s === "APROVADO") {
            await client.say(chan, `@${user} seu cashback está APROVADO ✅${prazo}`);
          } else if (s === "REPROVADO") {
            await client.say(chan, `@${user} seu cashback foi REPROVADO ❌${motivo}`);
          } else {
            await client.say(chan, `@${user} seu cashback está PENDENTE ⏳`);
          }
        } catch (e) {
          if (String(e.message) === "not_found") {
            await client.say(chan, `@${user} não achei nenhum cashback seu ainda. Use !cashback pra enviar.`);
          } else {
            await client.say(chan, `@${user} não consegui consultar agora. Tenta de novo jájá.`);
          }
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

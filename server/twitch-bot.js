import tmiPkg from "tmi.js";

export function initTwitchBot({
  port,
  apiKey,
  botUsername,
  oauthToken,
  channel,
  enabled = true,
  onLog = console,
  cashbackPublicUrl,
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

  const sayOnJoin =
    String(process.env.TOURNEY_SAY_JOIN || "").trim().toLowerCase() === "true";

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

  function normalizeKey(s) {
    return String(s || "")
      .trim()
      .replace(/^@+/, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function parseCommand(msg) {
    const text = String(msg || "").trim();
    if (!text.startsWith("!")) return null;

    let m = text.match(/^!palpite\b\s*(.+)$/i) || text.match(/^!p\b\s*(.+)$/i);
    if (m && m[1]) return { type: "guess", payload: m[1].trim() };

    if (/^!cashback\b/i.test(text)) return { type: "cashback" };
    if (/^!status\b/i.test(text)) return { type: "status" };

    const t = text.match(/^!time\b\s*(.+)$/i);
    if (t) return { type: "time", payload: String(t[1] || "").trim() };

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

  async function getTorneioState() {
    const url = `http://127.0.0.1:${port}/api/torneio/state?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) return { error: data?.error || `http_${res.status}` };
    return { ok: true, data };
  }

  function resolveTeamLetter(input, phaseTeams) {
    const raw = String(input || "").trim();
    if (!raw) return null;

    const up = raw.toUpperCase();
    if (up === "A" || up === "B" || up === "C") return up;

    const want = normalizeKey(raw);
    const a = normalizeKey(phaseTeams?.A || "");
    const b = normalizeKey(phaseTeams?.B || "");
    const c = normalizeKey(phaseTeams?.C || "");

    if (want && a && want === a) return "A";
    if (want && b && want === b) return "B";
    if (want && c && want === c) return "C";

    return null;
  }

  async function joinTeam(userTag, displayName, teamLetter) {
    const url = `http://127.0.0.1:${port}/api/torneio/join?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ user: userTag, displayName, team: teamLetter }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {}

    if (!res.ok) return { error: data?.error || `http_${res.status}` };
    return { ok: true, data };
  }

  async function getCashbackStatus(user) {
    const url = `http://127.0.0.1:${port}/api/cashback/status/${encodeURIComponent(user)}?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });

    if (res.status === 404) return { notFound: true };
    let data = null;
    try {
      data = await res.json();
    } catch {}
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

  const lastJoinPhase = new Map();
  function shouldConfirmJoin(userKey, phaseNumber, teamLetter) {
    if (!sayOnJoin) return false;
    const k = `${userKey}`;
    const v = lastJoinPhase.get(k);
    const nowSig = `${phaseNumber}:${teamLetter}`;
    if (v === nowSig) return false;
    lastJoinPhase.set(k, nowSig);
    if (lastJoinPhase.size > 2000) {
      const keys = Array.from(lastJoinPhase.keys()).slice(0, 200);
      for (const kk of keys) lastJoinPhase.delete(kk);
    }
    return true;
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
    const cmdKey =
      cmd.type === "guess"
        ? `guess:${cmd.payload || ""}`
        : cmd.type === "time"
          ? `time:${cmd.payload || ""}`
          : cmd.type;

    if (isDuplicate(userKey, cmdKey)) return;

    enqueue(async () => {
      if (cmd.type === "guess") {
        await submitGuessToServer(user, cmd.payload);
        return;
      }

      if (cmd.type === "time") {
        const mention = userTag ? `@${userTag}` : `@${user}`;

        const st = await getTorneioState();
        if (st.error) {
          await say(`${mention} não consegui verificar o torneio agora. Tenta de novo já já.`);
          return;
        }

        if (!st.data?.active) {
          await say(`${mention} torneio não está ativo agora.`);
          return;
        }

        const phase = st.data?.phase;
        if (!phase) {
          await say(`${mention} torneio ativo, mas a fase não está disponível agora.`);
          return;
        }

        const status = String(phase.status || "").toUpperCase();
        if (status !== "ABERTA") {
          await say(`${mention} entradas fechadas.`);
          return;
        }

        const teamLetter = resolveTeamLetter(cmd.payload, phase.teams);
        if (!teamLetter) {
          const a = phase.teams?.A || "A";
          const b = phase.teams?.B || "B";
          const c = phase.teams?.C || "C";
          await say(`${mention} time inválido. Use: !time ${a} | !time ${b} | !time ${c}`);
          return;
        }

        const r = await joinTeam(userTag || user, display || user, teamLetter);
        if (r.error === "torneio_inativo") {
          await say(`${mention} torneio não está ativo agora.`);
          return;
        }
        if (r.error === "fase_fechada") {
          await say(`${mention} entradas fechadas.`);
          return;
        }
        if (r.error === "nao_classificado") {
          await say(`${mention} você não está classificado para esta fase.`);
          return;
        }
        if (r.error === "time_invalido") {
          const a = phase.teams?.A || "A";
          const b = phase.teams?.B || "B";
          const c = phase.teams?.C || "C";
          await say(`${mention} time inválido. Use: !time ${a} | !time ${b} | !time ${c}`);
          return;
        }
        if (r.error) {
          await say(`${mention} não consegui entrar agora. Tenta de novo já já.`);
          return;
        }

        const phaseNum = Number(r.data?.phase || phase.number || 1);
        if (shouldConfirmJoin(userKey, phaseNum, teamLetter)) {
          const name = r.data?.teamName || phase.teams?.[teamLetter] || "";
          const label = name ? `${teamLetter} (${name})` : teamLetter;
          await say(`${mention} entrou no time ${label}.`);
        }
        return;
      }

      if (cmd.type === "cashback") {
        const mention = userTag ? `@${userTag}` : `@${user}`;
        await say(`${mention} envie o print do cadastro/depósito 👉 ${publicUrl} • depois use !status`);
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

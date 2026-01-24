
import tmiPkg from "tmi.js";


export function initTwitchBot({
  port,
  apiKey,
  botUsername,
  oauthToken,
  channel,
  enabled = true,
  onLog = console,
}) {
  const log = onLog || console;

  if (!enabled) {
    log.log("[twitch-bot] desativado por config.");
    return { enabled: false, say: async () => {}, client: null };
  }

  if (!port || !apiKey || !botUsername || !oauthToken || !channel) {
    log.log("[twitch-bot] faltam envs (TWITCH_* e PALPITE_PUBLIC_KEY). Bot não iniciado.");
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

  function parseGuessFromMessage(msg) {
    const text = String(msg || "").trim();
    if (!text.startsWith("!")) return null;

    
    let m = text.match(/^!palpite\b\s*(.+)$/i) || text.match(/^!p\b\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();

    

    return null;
  }

  async function submitGuessToServer(user, rawGuess) {
    
    const url = `http://127.0.0.1:${port}/api/palpite/guess?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        user,          
        guess: rawGuess, 
        source: "twitch",
      }),
    });

  
    return res.ok;
  }

  client.on("connected", () => {
    log.log(`[twitch-bot] conectado em ${chan} como ${botUsername}`);
  });

  client.on("message", (channelName, tags, message, self) => {
    if (self) return;

    const user = (tags["display-name"] || tags.username || "").trim();
    if (!user) return;

    const rawGuess = parseGuessFromMessage(message);
    if (!rawGuess) return;

    enqueue(async () => {
      await submitGuessToServer(user, rawGuess);
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

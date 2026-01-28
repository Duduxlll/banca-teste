import rateLimit from "express-rate-limit";

const T_STATUS = { ATIVO: "ATIVO", FINALIZADO: "FINALIZADO" };
const P_STATUS = { ABERTA: "ABERTA", FECHADA: "FECHADA", DECIDIDA: "DECIDIDA" };

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function safeText(v, max = 120) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  return s.slice(0, max);
}

function toAsciiLower(s = "") {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function normalizeTeamKey(name) {
  const s = toAsciiLower(name)
    .replace(/[^a-z0-9 _-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "");
  return s || null;
}

function asInt(v, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.trunc(n);
}

function pickTeamsFromBody(body) {
  const arr = Array.isArray(body?.teams) ? body.teams : null;
  if (arr && arr.length) return arr.map((x) => safeText(x, 40)).filter(Boolean);

  const a = safeText(body?.teamA, 40);
  const b = safeText(body?.teamB, 40);
  const c = safeText(body?.teamC, 40);
  const out = [a, b, c].filter(Boolean);
  return out.length ? out : ["Time A", "Time B", "Time C"];
}

function buildTeams(names) {
  const raw = (names || []).map((x) => safeText(x, 40)).filter(Boolean);
  const limited = raw.slice(0, 20);
  const out = [];
  const used = new Set();

  for (const name of limited) {
    let key = normalizeTeamKey(name);
    if (!key) continue;
    if (used.has(key)) {
      let i = 2;
      while (used.has(`${key}${i}`)) i++;
      key = `${key}${i}`;
    }
    used.add(key);
    out.push({ key, name });
  }

  if (out.length < 2) {
    return [
      { key: "timea", name: "Time A" },
      { key: "timeb", name: "Time B" },
      { key: "timec", name: "Time C" }
    ];
  }

  return out;
}

function getTeamByIndex(teams, idx) {
  if (!Array.isArray(teams)) return null;
  const t = teams[idx];
  if (!t) return null;
  return { key: String(t.key), name: String(t.name) };
}

function resolveTeamInput(teams, inputRaw) {
  const input = String(inputRaw || "").trim();
  if (!input) return null;

  

  const num = parseInt(input.replace(/[^\d]/g, ""), 10);
  if (Number.isFinite(num) && num >= 1 && num <= (teams?.length || 0)) {
    return getTeamByIndex(teams, num - 1);
  }

  const k = normalizeTeamKey(input);
  if (!k) return null;

  for (const t of teams || []) {
    const tk = String(t.key || "");
    const tn = String(t.name || "");
    if (tk && tk === k) return { key: tk, name: tn || tk };
    if (normalizeTeamKey(tn) === k) return { key: tk || k, name: tn || input };
  }

  return null;
}

function teamsToLegacyMap(teams) {
  return {
    A: teams?.[0]?.name || "Time A",
    B: teams?.[1]?.name || "Time B",
    C: teams?.[2]?.name || "Time C"
  };
}

function countsToLegacyABC(teams, countsByKey) {
  const a = teams?.[0]?.key ? (countsByKey[String(teams[0].key)] || 0) : 0;
  const b = teams?.[1]?.key ? (countsByKey[String(teams[1].key)] || 0) : 0;
  const c = teams?.[2]?.key ? (countsByKey[String(teams[2].key)] || 0) : 0;
  return { A: a, B: b, C: c };
}

function listsToLegacyABC(teams, listsByKey) {
  const a = teams?.[0]?.key ? (listsByKey[String(teams[0].key)] || []) : [];
  const b = teams?.[1]?.key ? (listsByKey[String(teams[1].key)] || []) : [];
  const c = teams?.[2]?.key ? (listsByKey[String(teams[2].key)] || []) : [];
  return { A: a, B: b, C: c };
}

export async function ensureTorneioTables(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS torneios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ATIVO',
      current_phase INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS torneio_phases (
      id TEXT PRIMARY KEY,
      torneio_id TEXT NOT NULL REFERENCES torneios(id) ON DELETE CASCADE,
      phase_number INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ABERTA',
      team_a_name TEXT NOT NULL DEFAULT 'Time A',
      team_b_name TEXT NOT NULL DEFAULT 'Time B',
      team_c_name TEXT NOT NULL DEFAULT 'Time C',
      teams_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      points_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      winner_team TEXT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at TIMESTAMPTZ,
      decided_at TIMESTAMPTZ,
      UNIQUE (torneio_id, phase_number)
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS torneio_participants (
      id TEXT PRIMARY KEY,
      torneio_id TEXT NOT NULL REFERENCES torneios(id) ON DELETE CASCADE,
      twitch_name TEXT NOT NULL,
      twitch_name_lc TEXT NOT NULL,
      display_name TEXT,
      alive BOOLEAN NOT NULL DEFAULT true,
      eliminated_phase INT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (torneio_id, twitch_name_lc)
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS torneio_choices (
      id TEXT PRIMARY KEY,
      torneio_id TEXT NOT NULL REFERENCES torneios(id) ON DELETE CASCADE,
      phase_number INT NOT NULL,
      twitch_name_lc TEXT NOT NULL,
      team TEXT NOT NULL,
      chosen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (torneio_id, phase_number, twitch_name_lc)
    )
  `);

  await q(`ALTER TABLE torneio_phases ADD COLUMN IF NOT EXISTS teams_json JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await q(`ALTER TABLE torneio_phases ADD COLUMN IF NOT EXISTS points_json JSONB NOT NULL DEFAULT '{}'::jsonb`);

  await q(`CREATE INDEX IF NOT EXISTS torneios_status_idx ON torneios(status, created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS torneio_phases_idx ON torneio_phases(torneio_id, phase_number)`);
  await q(`CREATE INDEX IF NOT EXISTS torneio_participants_idx ON torneio_participants(torneio_id, alive, updated_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS torneio_choices_idx ON torneio_choices(torneio_id, phase_number, team)`);
}

async function getActiveTorneio(q) {
  const { rows } = await q(
    `SELECT id, name, status, current_phase AS "currentPhase", created_at AS "createdAt"
     FROM torneios
     WHERE status = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [T_STATUS.ATIVO]
  );
  return rows[0] || null;
}

function parseTeamsFromPhaseRow(r) {
  let teams = [];
  if (r?.teamsJson) {
    const tj = r.teamsJson;
    if (Array.isArray(tj)) {
      teams = tj
        .map((x) => {
          const key = safeText(x?.key ?? x?.id ?? x?.k, 60);
          const name = safeText(x?.name ?? x?.n ?? "", 60) || key;
          if (!key) return null;
          return { key, name };
        })
        .filter(Boolean);
    }
  }
  if (!teams.length) {
    const a = safeText(r?.teamAName, 40) || "Time A";
    const b = safeText(r?.teamBName, 40) || "Time B";
    const c = safeText(r?.teamCName, 40) || "Time C";
    teams = buildTeams([a, b, c]);
  }
  return teams;
}

async function getPhase(q, torneioId, phaseNumber) {
  const { rows } = await q(
    `SELECT
       id,
       torneio_id AS "torneioId",
       phase_number AS "phaseNumber",
       status,
       team_a_name AS "teamAName",
       team_b_name AS "teamBName",
       team_c_name AS "teamCName",
       teams_json AS "teamsJson",
       points_json AS "pointsJson",
       winner_team AS "winnerTeam",
       opened_at AS "openedAt",
       closed_at AS "closedAt",
       decided_at AS "decidedAt"
     FROM torneio_phases
     WHERE torneio_id = $1 AND phase_number = $2
     LIMIT 1`,
    [torneioId, phaseNumber]
  );
  if (!rows[0]) return null;

  const r = rows[0];
  const teams = parseTeamsFromPhaseRow(r);
  const points = r.pointsJson && typeof r.pointsJson === "object" ? r.pointsJson : {};

  return {
    id: r.id,
    torneioId: r.torneioId,
    phaseNumber: r.phaseNumber,
    status: r.status,
    teams,
    legacyTeams: { A: r.teamAName, B: r.teamBName, C: r.teamCName },
    winnerTeam: r.winnerTeam,
    points,
    openedAt: r.openedAt,
    closedAt: r.closedAt,
    decidedAt: r.decidedAt
  };
}

async function getCountsByKey(q, torneioId, phaseNumber) {
  const { rows } = await q(
    `SELECT team, COUNT(*)::int AS c
     FROM torneio_choices
     WHERE torneio_id = $1 AND phase_number = $2
     GROUP BY team`,
    [torneioId, phaseNumber]
  );
  const out = {};
  for (const r of rows || []) {
    const k = String(r.team || "");
    out[k] = Number(r.c) || 0;
  }
  return out;
}

async function getTeamListsByKey(q, torneioId, phaseNumber) {
  const { rows } = await q(
    `SELECT
       c.team,
       p.twitch_name AS "twitchName",
       COALESCE(p.display_name, p.twitch_name) AS "displayName"
     FROM torneio_choices c
     JOIN torneio_participants p
       ON p.torneio_id = c.torneio_id AND p.twitch_name_lc = c.twitch_name_lc
     WHERE c.torneio_id = $1 AND c.phase_number = $2
     ORDER BY p.updated_at DESC`,
    [torneioId, phaseNumber]
  );

  const out = {};
  for (const r of rows || []) {
    const k = String(r.team || "");
    if (!out[k]) out[k] = [];
    out[k].push({ twitchName: r.twitchName, displayName: r.displayName });
  }
  return out;
}

async function isAlive(q, torneioId, userLc) {
  const { rows } = await q(
    `SELECT alive FROM torneio_participants
     WHERE torneio_id = $1 AND twitch_name_lc = $2
     LIMIT 1`,
    [torneioId, userLc]
  );
  return rows[0]?.alive === true;
}

async function upsertParticipant(q, uid, torneioId, twitchName, twitchLc, displayName) {
  const { rows } = await q(
    `INSERT INTO torneio_participants
      (id, torneio_id, twitch_name, twitch_name_lc, display_name, alive, joined_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, now(), now())
     ON CONFLICT (torneio_id, twitch_name_lc)
     DO UPDATE SET
       twitch_name = EXCLUDED.twitch_name,
       display_name = COALESCE(EXCLUDED.display_name, torneio_participants.display_name),
       updated_at = now()
     RETURNING id`,
    [uid(), torneioId, twitchName, twitchLc, displayName || null]
  );
  return rows[0]?.id || null;
}

async function upsertChoice(q, uid, torneioId, phaseNumber, twitchLc, teamKey) {
  const { rows } = await q(
    `INSERT INTO torneio_choices
      (id, torneio_id, phase_number, twitch_name_lc, team, chosen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (torneio_id, phase_number, twitch_name_lc)
     DO UPDATE SET
       team = EXCLUDED.team,
       updated_at = now()
     RETURNING id`,
    [uid(), torneioId, phaseNumber, twitchLc, teamKey]
  );
  return rows[0]?.id || null;
}

async function eliminateNotInWinner(q, torneioId, phaseNumber, winnerTeamKey) {
  await q(
    `UPDATE torneio_participants p
     SET alive = false,
         eliminated_phase = $2,
         updated_at = now()
     WHERE p.torneio_id = $1
       AND p.alive = true
       AND p.twitch_name_lc NOT IN (
         SELECT c.twitch_name_lc
         FROM torneio_choices c
         WHERE c.torneio_id = $1
           AND c.phase_number = $2
           AND c.team = $3
       )`,
    [torneioId, phaseNumber, winnerTeamKey]
  );
}

async function writePhaseTeams(q, torneioId, phaseNumber, teams) {
  const legacy = teamsToLegacyMap(teams);
  await q(
    `UPDATE torneio_phases
     SET teams_json = $3::jsonb,
         team_a_name = $4,
         team_b_name = $5,
         team_c_name = $6
     WHERE torneio_id = $1 AND phase_number = $2`,
    [torneioId, phaseNumber, JSON.stringify(teams), legacy.A, legacy.B, legacy.C]
  );
}

function buildTeamsList(phase, countsByKey) {
  const teams = phase?.teams || [];
  return teams.map((t) => ({
    key: String(t.key),
    name: String(t.name),
    count: countsByKey[String(t.key)] || 0,
    points: asInt(phase?.points?.[String(t.key)] ?? 0, 0)
  }));
}

function buildAnnounceTeamsPreview(teams, maxNames = 8) {
  const list = (teams || []).map((t) => String(t?.name || "").trim()).filter(Boolean);
  const shown = list.slice(0, maxNames);
  const more = list.length - shown.length;
  const base = shown.join(" | ");
  return more > 0 ? `${base} (+${more})` : base;
}

function formatPhaseOpenMsg(torneioName, phaseNumber, teams) {
  const preview = buildAnnounceTeamsPreview(teams, 8);
  const t = preview ? ` • Times: ${preview}` : "";
  return `🏆 ${torneioName} (fase ${phaseNumber} aberta)${t} • Digite: !time <nome do time>`;
}

function formatPhaseCloseMsg(torneioName, phaseNumber) {
  return `🏆 ${torneioName} (fase ${phaseNumber} fechada) • Entradas fechadas.`;
}

function formatPhaseDecideMsg(torneioName, phaseNumber, winnerName) {
  return `🏆 ${torneioName} (fase ${phaseNumber} decidida) • Vencedor: ${winnerName}`;
}

function formatFinishMsg(torneioName, winners) {
  const base = `🏆 ${torneioName} FINALIZADO!`;
  if (!winners || !winners.length) return base;
  const tags = winners.map((u) => `@${u}`).join(" ");
  const msg = `${base} • Ganhadores: ${tags}`;
  return msg;
}

function splitTwitchMessages(text, maxLen = 430) {
  const s = String(text || "").trim();
  if (s.length <= maxLen) return [s];

  const out = [];
  let cur = "";

  for (const part of s.split(" ")) {
    const next = cur ? `${cur} ${part}` : part;
    if (next.length > maxLen) {
      if (cur) out.push(cur);
      cur = part;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, 5);
}

export function registerTorneioRoutes({ app, q, uid, requireAppKey, requireAdmin, sseSendAll, announce }) {
  let ensured = false;
  async function ensureReady() {
    if (ensured) return;
    await ensureTorneioTables(q);
    ensured = true;
  }

  async function announceSafe(msg) {
    try {
      if (!announce) return;
      const parts = splitTwitchMessages(msg, 430);
      for (const p of parts) await announce(p);
    } catch {}
  }

  const joinLimiter = rateLimit({
    windowMs: 15 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false
  });

  app.get("/api/torneio/state", requireAppKey, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.json({ ok: true, active: false });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.json({ ok: true, active: true, torneio: tor, phase: null });

      const countsByKey = await getCountsByKey(q, tor.id, ph.phaseNumber);
      const teamsList = buildTeamsList(ph, countsByKey);

      return res.json({
        ok: true,
        active: true,
        torneio: tor,
        phase: {
          number: ph.phaseNumber,
          status: ph.status,
          winnerTeam: ph.winnerTeam || null,
          teamsList,
          teamsAll: teamsList.map((t) => ({ key: t.key, name: t.name })),
          teams: teamsToLegacyMap(ph.teams),
          countsByKey,
          counts: countsToLegacyABC(ph.teams, countsByKey),
          points: ph.points || {}
        }
      });
    } catch (e) {
      console.error("torneio/state:", e?.message || e);
      return res.status(500).json({ error: "falha_state" });
    }
  });

  app.post("/api/torneio/join", requireAppKey, joinLimiter, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.status(400).json({ error: "fase_invalida" });
      if (String(ph.status) !== P_STATUS.ABERTA) return res.status(400).json({ error: "fase_fechada" });

      const userRaw = req.body?.user ?? req.body?.twitchName ?? "";
      const displayRaw = req.body?.displayName ?? req.body?.display ?? "";
      const teamRaw = req.body?.team ?? req.body?.teamName ?? req.body?.time ?? "";

      const userLc = normalizeName(userRaw);
      const twitchName = safeText(String(userRaw).trim().replace(/^@+/, ""), 40);
      const displayName = safeText(displayRaw, 60);

      if (!userLc || !twitchName) return res.status(400).json({ error: "user_invalido" });

      if (ph.phaseNumber > 1) {
        const alive = await isAlive(q, tor.id, userLc);
        if (!alive) return res.status(403).json({ error: "nao_classificado" });
      }

      const resolved = resolveTeamInput(ph.teams, teamRaw);
      if (!resolved) return res.status(400).json({ error: "time_invalido" });

      await upsertParticipant(q, uid, tor.id, twitchName, userLc, displayName);
      await upsertChoice(q, uid, tor.id, ph.phaseNumber, userLc, resolved.key);

      sseSendAll?.("torneio-changed", { reason: "join", torneioId: tor.id, phase: ph.phaseNumber });

      const countsByKey = await getCountsByKey(q, tor.id, ph.phaseNumber);

      return res.json({
        ok: true,
        torneioId: tor.id,
        phase: ph.phaseNumber,
        teamKey: resolved.key,
        teamName: resolved.name,
        countsByKey,
        counts: countsToLegacyABC(ph.teams, countsByKey)
      });
    } catch (e) {
      console.error("torneio/join:", e?.message || e);
      return res.status(500).json({ error: "falha_join" });
    }
  });

  app.get("/api/torneio/admin/current", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) {
        return res.json({
          ok: true,
          active: false,
          torneio: null,
          phase: null,
          alive: []
        });
      }

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      const countsByKey = ph ? await getCountsByKey(q, tor.id, ph.phaseNumber) : {};
      const listsByKey = ph ? await getTeamListsByKey(q, tor.id, ph.phaseNumber) : {};

      const teamsList = ph
        ? (ph.teams || []).map((t) => ({
            key: String(t.key),
            name: String(t.name),
            count: countsByKey[String(t.key)] || 0,
            points: asInt(ph.points?.[String(t.key)] ?? 0, 0),
            list: listsByKey[String(t.key)] || []
          }))
        : [];

      const { rows: aliveRows } = await q(
        `SELECT COALESCE(display_name, twitch_name) AS name, twitch_name AS "twitchName"
         FROM torneio_participants
         WHERE torneio_id = $1 AND alive = true
         ORDER BY updated_at DESC
         LIMIT 2000`,
        [tor.id]
      );

      return res.json({
        ok: true,
        active: true,
        torneio: tor,
        phase: ph
          ? {
              number: ph.phaseNumber,
              status: ph.status,
              winnerTeam: ph.winnerTeam || null,
              teamsList,
              teamsAll: teamsList.map((t) => ({ key: t.key, name: t.name })),
              teams: teamsToLegacyMap(ph.teams),
              countsByKey,
              counts: countsToLegacyABC(ph.teams, countsByKey),
              lists: listsToLegacyABC(ph.teams, listsByKey),
              points: ph.points || {}
            }
          : null,
        alive: aliveRows || []
      });
    } catch (e) {
      console.error("torneio/admin/current:", e?.message || e);
      return res.status(500).json({ error: "falha_current" });
    }
  });

  app.post("/api/torneio/admin/start", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const exists = await getActiveTorneio(q);
      if (exists) return res.status(400).json({ error: "ja_ativo" });

      const name = safeText(req.body?.name, 80) || "Torneio";
      const teams = buildTeams(pickTeamsFromBody(req.body));
      const legacy = teamsToLegacyMap(teams);

      const torneioId = uid();
      const phaseId = uid();

      await q(
        `INSERT INTO torneios (id, name, status, current_phase, created_at)
         VALUES ($1, $2, $3, 1, now())`,
        [torneioId, name, T_STATUS.ATIVO]
      );

      await q(
        `INSERT INTO torneio_phases
          (id, torneio_id, phase_number, status, team_a_name, team_b_name, team_c_name, teams_json, points_json, opened_at)
         VALUES
          ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, '{}'::jsonb, now())`,
        [phaseId, torneioId, P_STATUS.ABERTA, legacy.A, legacy.B, legacy.C, JSON.stringify(teams)]
      );

      sseSendAll?.("torneio-changed", { reason: "start", torneioId });

      await announceSafe(formatPhaseOpenMsg(name, 1, teams));

      return res.json({ ok: true, torneioId });
    } catch (e) {
      console.error("torneio/admin/start:", e?.message || e);
      return res.status(500).json({ error: "falha_start" });
    }
  });

  app.post("/api/torneio/admin/close", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.status(400).json({ error: "fase_invalida" });

      await q(
        `UPDATE torneio_phases
         SET status = $3,
             closed_at = COALESCE(closed_at, now())
         WHERE torneio_id = $1 AND phase_number = $2`,
        [tor.id, ph.phaseNumber, P_STATUS.FECHADA]
      );

      sseSendAll?.("torneio-changed", { reason: "close", torneioId: tor.id, phase: ph.phaseNumber });

      await announceSafe(formatPhaseCloseMsg(tor.name, ph.phaseNumber));

      return res.json({ ok: true });
    } catch (e) {
      console.error("torneio/admin/close:", e?.message || e);
      return res.status(500).json({ error: "falha_close" });
    }
  });

  app.patch("/api/torneio/admin/teams", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.status(400).json({ error: "fase_invalida" });
      if (String(ph.status) !== P_STATUS.ABERTA) return res.status(400).json({ error: "fase_nao_aberta" });

      const teams = buildTeams(pickTeamsFromBody(req.body));
      await writePhaseTeams(q, tor.id, ph.phaseNumber, teams);

      sseSendAll?.("torneio-changed", { reason: "teams", torneioId: tor.id, phase: ph.phaseNumber });

      return res.json({ ok: true });
    } catch (e) {
      console.error("torneio/admin/teams:", e?.message || e);
      return res.status(500).json({ error: "falha_teams" });
    }
  });

  app.patch("/api/torneio/admin/points", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.status(400).json({ error: "fase_invalida" });

      const inPoints = req.body?.points;
      if (!inPoints || typeof inPoints !== "object") return res.status(400).json({ error: "points_invalidos" });

      const map = {};
      if (Array.isArray(inPoints)) {
        for (const row of inPoints) {
          const resolved = resolveTeamInput(ph.teams, row?.team ?? row?.teamName ?? row?.name ?? row?.key);
          if (!resolved) continue;
          map[String(resolved.key)] = asInt(row?.points ?? row?.pontos ?? row?.value ?? 0, 0);
        }
      } else {
        for (const [k, v] of Object.entries(inPoints)) {
          const resolved = resolveTeamInput(ph.teams, k);
          if (!resolved) continue;
          map[String(resolved.key)] = asInt(v, 0);
        }
      }

      await q(
        `UPDATE torneio_phases
         SET points_json = $3::jsonb
         WHERE torneio_id = $1 AND phase_number = $2`,
        [tor.id, ph.phaseNumber, JSON.stringify(map)]
      );

      sseSendAll?.("torneio-changed", { reason: "points", torneioId: tor.id, phase: ph.phaseNumber });

      return res.json({ ok: true });
    } catch (e) {
      console.error("torneio/admin/points:", e?.message || e);
      return res.status(500).json({ error: "falha_points" });
    }
  });

  app.post("/api/torneio/admin/decide", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.status(400).json({ error: "fase_invalida" });

      const resolved = resolveTeamInput(ph.teams, req.body?.winnerTeam ?? req.body?.winner ?? req.body?.team ?? "");
      if (!resolved) return res.status(400).json({ error: "winner_invalido" });

      await q(
        `UPDATE torneio_phases
         SET status = $4,
             winner_team = $3,
             closed_at = COALESCE(closed_at, now()),
             decided_at = now()
         WHERE torneio_id = $1 AND phase_number = $2`,
        [tor.id, ph.phaseNumber, resolved.key, P_STATUS.DECIDIDA]
      );

      await eliminateNotInWinner(q, tor.id, ph.phaseNumber, resolved.key);

      sseSendAll?.("torneio-changed", { reason: "decide", torneioId: tor.id, phase: ph.phaseNumber, winnerTeam: resolved.key });

      await announceSafe(formatPhaseDecideMsg(tor.name, ph.phaseNumber, resolved.name));

      return res.json({ ok: true });
    } catch (e) {
      console.error("torneio/admin/decide:", e?.message || e);
      return res.status(500).json({ error: "falha_decide" });
    }
  });

  app.post("/api/torneio/admin/open-next", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const cur = await getPhase(q, tor.id, tor.currentPhase);
      if (!cur) return res.status(400).json({ error: "fase_invalida" });
      if (String(cur.status) !== P_STATUS.DECIDIDA) return res.status(400).json({ error: "fase_nao_decidida" });

      const nextNum = Number(tor.currentPhase) + 1;

      const teams = buildTeams(pickTeamsFromBody(req.body));
      const legacy = teamsToLegacyMap(teams);

      await q(`UPDATE torneios SET current_phase = $2 WHERE id = $1`, [tor.id, nextNum]);

      await q(
        `INSERT INTO torneio_phases
          (id, torneio_id, phase_number, status, team_a_name, team_b_name, team_c_name, teams_json, points_json, opened_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, '{}'::jsonb, now())`,
        [uid(), tor.id, nextNum, P_STATUS.ABERTA, legacy.A, legacy.B, legacy.C, JSON.stringify(teams)]
      );

      sseSendAll?.("torneio-changed", { reason: "open-next", torneioId: tor.id, phase: nextNum });

      await announceSafe(formatPhaseOpenMsg(tor.name, nextNum, teams));

      return res.json({ ok: true, phase: nextNum });
    } catch (e) {
      console.error("torneio/admin/open-next:", e?.message || e);
      return res.status(500).json({ error: "falha_open_next" });
    }
  });

  app.post("/api/torneio/admin/finish", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      await q(
        `UPDATE torneios
         SET status = $2, ended_at = now()
         WHERE id = $1`,
        [tor.id, T_STATUS.FINALIZADO]
      );

      const limit = Math.min(Math.max(parseInt(req.body?.limit || "80", 10) || 80, 1), 2000);
      const { rows } = await q(
        `SELECT twitch_name AS "twitchName"
         FROM torneio_participants
         WHERE torneio_id = $1 AND alive = true
         ORDER BY updated_at DESC
         LIMIT ${limit}`,
        [tor.id]
      );

      const winners = (rows || [])
        .map((r) => String(r.twitchName || "").trim().replace(/^@+/, ""))
        .filter(Boolean);

      sseSendAll?.("torneio-changed", { reason: "finish", torneioId: tor.id });

      await announceSafe(formatFinishMsg(tor.name, winners.slice(0, 25)));

      return res.json({ ok: true });
    } catch (e) {
      console.error("torneio/admin/finish:", e?.message || e);
      return res.status(500).json({ error: "falha_finish" });
    }
  });

  app.get("/api/torneio/admin/winners", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.json({ ok: true, active: false, rows: [] });

      const limit = Math.min(Math.max(parseInt(req.query?.limit || "50", 10) || 50, 1), 2000);

      const { rows } = await q(
        `SELECT
           twitch_name AS "twitchName",
           COALESCE(display_name, twitch_name) AS "displayName",
           joined_at AS "joinedAt"
         FROM torneio_participants
         WHERE torneio_id = $1 AND alive = true
         ORDER BY updated_at DESC
         LIMIT ${limit}`,
        [tor.id]
      );

      return res.json({ ok: true, active: true, rows: rows || [] });
    } catch (e) {
      console.error("torneio/admin/winners:", e?.message || e);
      return res.status(500).json({ error: "falha_winners" });
    }
  });
}

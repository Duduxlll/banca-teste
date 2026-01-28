import rateLimit from "express-rate-limit";

const T_STATUS = { ATIVO: "ATIVO", FINALIZADO: "FINALIZADO" };
const P_STATUS = { ABERTA: "ABERTA", FECHADA: "FECHADA", DECIDIDA: "DECIDIDA" };
const TEAM = ["A", "B", "C"];

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

function isTeam(v) {
  const t = String(v || "").trim().toUpperCase();
  return TEAM.includes(t) ? t : null;
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
      team_a_name TEXT NOT NULL,
      team_b_name TEXT NOT NULL,
      team_c_name TEXT NOT NULL,
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
       winner_team AS "winnerTeam",
       opened_at AS "openedAt",
       closed_at AS "closedAt",
       decided_at AS "decidedAt"
     FROM torneio_phases
     WHERE torneio_id = $1 AND phase_number = $2
     LIMIT 1`,
    [torneioId, phaseNumber]
  );
  return rows[0] || null;
}

async function getCounts(q, torneioId, phaseNumber) {
  const { rows } = await q(
    `SELECT team, COUNT(*)::int AS c
     FROM torneio_choices
     WHERE torneio_id = $1 AND phase_number = $2
     GROUP BY team`,
    [torneioId, phaseNumber]
  );
  const m = new Map((rows || []).map((r) => [String(r.team || "").toUpperCase(), Number(r.c) || 0]));
  return { A: m.get("A") || 0, B: m.get("B") || 0, C: m.get("C") || 0 };
}

async function getTeamLists(q, torneioId, phaseNumber) {
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

  const out = { A: [], B: [], C: [] };
  for (const r of rows || []) {
    const t = String(r.team || "").toUpperCase();
    if (!out[t]) continue;
    out[t].push({ twitchName: r.twitchName, displayName: r.displayName });
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

async function upsertChoice(q, uid, torneioId, phaseNumber, twitchLc, team) {
  const { rows } = await q(
    `INSERT INTO torneio_choices
      (id, torneio_id, phase_number, twitch_name_lc, team, chosen_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (torneio_id, phase_number, twitch_name_lc)
     DO UPDATE SET
       team = EXCLUDED.team,
       updated_at = now()
     RETURNING id`,
    [uid(), torneioId, phaseNumber, twitchLc, team]
  );
  return rows[0]?.id || null;
}

async function eliminateNotInWinner(q, torneioId, phaseNumber, winnerTeam) {
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
    [torneioId, phaseNumber, winnerTeam]
  );
}

export function registerTorneioRoutes({ app, q, uid, requireAppKey, requireAdmin, sseSendAll }) {
  let ensured = false;
  async function ensureReady() {
    if (ensured) return;
    await ensureTorneioTables(q);
    ensured = true;
  }

  const joinLimiter = rateLimit({
    windowMs: 15 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
   
  });

  app.get("/api/torneio/state", requireAppKey, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.json({ ok: true, active: false });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.json({ ok: true, active: true, torneio: tor, phase: null });

      const counts = await getCounts(q, tor.id, ph.phaseNumber);

      return res.json({
        ok: true,
        active: true,
        torneio: tor,
        phase: {
          number: ph.phaseNumber,
          status: ph.status,
          teams: { A: ph.teamAName, B: ph.teamBName, C: ph.teamCName },
          winnerTeam: ph.winnerTeam || null,
          counts,
        },
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

      const team = isTeam(req.body?.team);
      if (!team) return res.status(400).json({ error: "time_invalido" });

      const userRaw = req.body?.user ?? req.body?.twitchName ?? "";
      const displayRaw = req.body?.displayName ?? req.body?.display ?? "";

      const userLc = normalizeName(userRaw);
      const twitchName = safeText(String(userRaw).trim().replace(/^@+/, ""), 40);
      const displayName = safeText(displayRaw, 60);

      if (!userLc || !twitchName) return res.status(400).json({ error: "user_invalido" });

      if (ph.phaseNumber > 1) {
        const alive = await isAlive(q, tor.id, userLc);
        if (!alive) return res.status(403).json({ error: "nao_classificado" });
      }

      await upsertParticipant(q, uid, tor.id, twitchName, userLc, displayName);
      await upsertChoice(q, uid, tor.id, ph.phaseNumber, userLc, team);

      sseSendAll?.("torneio-changed", { reason: "join", torneioId: tor.id, phase: ph.phaseNumber });

      const teamNames = { A: ph.teamAName, B: ph.teamBName, C: ph.teamCName };
      const counts = await getCounts(q, tor.id, ph.phaseNumber);

      return res.json({
        ok: true,
        torneioId: tor.id,
        phase: ph.phaseNumber,
        team,
        teamName: teamNames[team],
        counts,
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
          alive: [],
        });
      }

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      const counts = ph ? await getCounts(q, tor.id, ph.phaseNumber) : { A: 0, B: 0, C: 0 };
      const lists = ph ? await getTeamLists(q, tor.id, ph.phaseNumber) : { A: [], B: [], C: [] };

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
              teams: { A: ph.teamAName, B: ph.teamBName, C: ph.teamCName },
              winnerTeam: ph.winnerTeam || null,
              counts,
              lists,
            }
          : null,
        alive: aliveRows || [],
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
      const teamA = safeText(req.body?.teamA, 40) || "Time A";
      const teamB = safeText(req.body?.teamB, 40) || "Time B";
      const teamC = safeText(req.body?.teamC, 40) || "Time C";

      const torneioId = uid();
      const phaseId = uid();

      await q(
        `INSERT INTO torneios (id, name, status, current_phase, created_at)
         VALUES ($1, $2, $3, 1, now())`,
        [torneioId, name, T_STATUS.ATIVO]
      );

      await q(
        `INSERT INTO torneio_phases
          (id, torneio_id, phase_number, status, team_a_name, team_b_name, team_c_name, opened_at)
         VALUES
          ($1, $2, 1, $3, $4, $5, $6, now())`,
        [phaseId, torneioId, P_STATUS.ABERTA, teamA, teamB, teamC]
      );

      sseSendAll?.("torneio-changed", { reason: "start", torneioId });

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

      return res.json({ ok: true });
    } catch (e) {
      console.error("torneio/admin/close:", e?.message || e);
      return res.status(500).json({ error: "falha_close" });
    }
  });

  app.post("/api/torneio/admin/decide", requireAdmin, async (req, res) => {
    try {
      await ensureReady();

      const tor = await getActiveTorneio(q);
      if (!tor) return res.status(400).json({ error: "torneio_inativo" });

      const ph = await getPhase(q, tor.id, tor.currentPhase);
      if (!ph) return res.status(400).json({ error: "fase_invalida" });

      const winnerTeam = isTeam(req.body?.winnerTeam);
      if (!winnerTeam) return res.status(400).json({ error: "winner_invalido" });

      await q(
        `UPDATE torneio_phases
         SET status = $4,
             winner_team = $3,
             closed_at = COALESCE(closed_at, now()),
             decided_at = now()
         WHERE torneio_id = $1 AND phase_number = $2`,
        [tor.id, ph.phaseNumber, winnerTeam, P_STATUS.DECIDIDA]
      );

      await eliminateNotInWinner(q, tor.id, ph.phaseNumber, winnerTeam);

      sseSendAll?.("torneio-changed", { reason: "decide", torneioId: tor.id, phase: ph.phaseNumber, winnerTeam });

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

      const teamA = safeText(req.body?.teamA, 40) || "Time A";
      const teamB = safeText(req.body?.teamB, 40) || "Time B";
      const teamC = safeText(req.body?.teamC, 40) || "Time C";

      await q(`UPDATE torneios SET current_phase = $2 WHERE id = $1`, [tor.id, nextNum]);

      await q(
        `INSERT INTO torneio_phases
          (id, torneio_id, phase_number, status, team_a_name, team_b_name, team_c_name, opened_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, now())`,
        [uid(), tor.id, nextNum, P_STATUS.ABERTA, teamA, teamB, teamC]
      );

      sseSendAll?.("torneio-changed", { reason: "open-next", torneioId: tor.id, phase: nextNum });

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

      sseSendAll?.("torneio-changed", { reason: "finish", torneioId: tor.id });

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

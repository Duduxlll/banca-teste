import rateLimit from 'express-rate-limit';

const STATUS = {
  PENDENTE: 'PENDENTE',
  APROVADO: 'APROVADO',
  REPROVADO: 'REPROVADO'
};

function normalizeTwitchName(name) {
  return String(name || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function safeText(v, max = 300) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.slice(0, max);
}

function isValidPixType(v) {
  return ['email', 'cpf', 'phone', 'random'].includes(String(v || '').trim());
}

function isDataUrlImage(v) {
  const s = String(v || '');
  return /^data:image\/(png|jpeg|jpg|webp);base64,[a-z0-9+/=\s]+$/i.test(s);
}

function approxBytesFromDataUrl(dataUrl) {
  const i = String(dataUrl || '').indexOf('base64,');
  if (i < 0) return 0;
  const b64 = String(dataUrl).slice(i + 7).replace(/\s+/g, '');
  return Math.floor((b64.length * 3) / 4);
}

export async function ensureCashbackTables(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS cashback_submissions (
      id TEXT PRIMARY KEY,
      twitch_name TEXT NOT NULL,
      twitch_name_lc TEXT NOT NULL,
      pix_type TEXT,
      pix_key TEXT NOT NULL,
      screenshot_data_url TEXT,
      status TEXT NOT NULL DEFAULT 'PENDENTE',
      reason TEXT,
      payout_window TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at TIMESTAMPTZ
    )
  `);

  await q(`CREATE INDEX IF NOT EXISTS cashback_submissions_twitch_lc_idx ON cashback_submissions(twitch_name_lc)`);
  await q(`CREATE INDEX IF NOT EXISTS cashback_submissions_status_idx ON cashback_submissions(status, updated_at DESC)`);
}

export function registerCashbackRoutes({
  app,
  q,
  uid,
  requireAppKey,
  requireAuth,
  requireAdmin,
  sseSendAll
}) {
  const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    
  });

  app.post('/api/cashback/submit', requireAppKey, submitLimiter, async (req, res) => {
    try {
      const twitchNameRaw = req.body?.twitchName ?? req.body?.user ?? req.body?.nome ?? '';
      const twitchNameLc = normalizeTwitchName(twitchNameRaw);
      const twitchName = safeText(String(twitchNameRaw).trim().replace(/^@+/, ''), 40);

      const pixType = isValidPixType(req.body?.pixType) ? String(req.body.pixType).trim() : null;
      const pixKey = safeText(req.body?.pixKey, 160);

      const screenshot = req.body?.screenshotDataUrl ?? req.body?.screenshot ?? null;

      if (!twitchNameLc || !twitchName || !pixKey) {
        return res.status(400).json({ error: 'dados_invalidos' });
      }

      let screenshotDataUrl = null;

      if (screenshot != null && String(screenshot).trim() !== '') {
        if (!isDataUrlImage(screenshot)) {
          return res.status(400).json({ error: 'screenshot_invalida' });
        }
        const bytes = approxBytesFromDataUrl(screenshot);
        if (bytes > 4.5 * 1024 * 1024) {
          return res.status(413).json({ error: 'screenshot_grande' });
        }
        screenshotDataUrl = String(screenshot);
      }

      const id = uid();

      await q(
        `INSERT INTO cashback_submissions
          (id, twitch_name, twitch_name_lc, pix_type, pix_key, screenshot_data_url, status, created_at, updated_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
        [id, twitchName, twitchNameLc, pixType, pixKey, screenshotDataUrl, STATUS.PENDENTE]
      );

      sseSendAll?.('cashback-changed', { reason: 'submit', id, twitch: twitchName });

      return res.status(201).json({ ok: true, id, status: STATUS.PENDENTE });
    } catch (e) {
      console.error('cashback/submit:', e.message);
      return res.status(500).json({ error: 'falha_submit' });
    }
  });

  app.get('/api/cashback/status/:user', requireAppKey, async (req, res) => {
    try {
      const userLc = normalizeTwitchName(req.params.user);
      if (!userLc) return res.status(400).json({ error: 'user_invalido' });

      const { rows } = await q(
        `SELECT
           id,
           twitch_name AS "twitchName",
           status,
           reason,
           payout_window AS "payoutWindow",
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           decided_at AS "decidedAt"
         FROM cashback_submissions
         WHERE twitch_name_lc = $1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
        [userLc]
      );

      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      return res.json(rows[0]);
    } catch (e) {
      console.error('cashback/status:', e.message);
      return res.status(500).json({ error: 'falha_status' });
    }
  });

  app.get('/api/cashback/ranking', requireAppKey, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query?.limit || '50', 10) || 50, 1), 200);

      const { rows } = await q(
        `SELECT
           twitch_name AS "user",
           COUNT(*)::int AS "approved"
         FROM cashback_submissions
         WHERE status = $1
         GROUP BY twitch_name
         ORDER BY approved DESC, twitch_name ASC
         LIMIT ${limit}`,
        [STATUS.APROVADO]
      );

      return res.json({ ok: true, rows });
    } catch (e) {
      console.error('cashback/ranking:', e.message);
      return res.status(500).json({ error: 'falha_ranking' });
    }
  });

  app.get('/api/cashback/admin/list', requireAdmin, async (req, res) => {
    try {
      const status = String(req.query?.status || '').trim().toUpperCase();
      const statusFilter = [STATUS.PENDENTE, STATUS.APROVADO, STATUS.REPROVADO].includes(status) ? status : null;

      const limit = Math.min(Math.max(parseInt(req.query?.limit || '200', 10) || 200, 1), 1000);

      const params = [];
      let where = '';
      if (statusFilter) {
        params.push(statusFilter);
        where = `WHERE status = $${params.length}`;
      }

      const { rows } = await q(
        `SELECT
           id,
           twitch_name AS "twitchName",
           pix_type AS "pixType",
           pix_key AS "pixKey",
           (screenshot_data_url IS NOT NULL) AS "hasScreenshot",
           status,
           reason,
           payout_window AS "payoutWindow",
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           decided_at AS "decidedAt"
         FROM cashback_submissions
         ${where}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ${limit}`,
        params
      );

      return res.json({ ok: true, rows });
    } catch (e) {
      console.error('cashback/admin/list:', e.message);
      return res.status(500).json({ error: 'falha_list' });
    }
  });

  app.get('/api/cashback/admin/:id', requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id_invalido' });

      const { rows } = await q(
        `SELECT
           id,
           twitch_name AS "twitchName",
           pix_type AS "pixType",
           pix_key AS "pixKey",
           screenshot_data_url AS "screenshotDataUrl",
           status,
           reason,
           payout_window AS "payoutWindow",
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           decided_at AS "decidedAt"
         FROM cashback_submissions
         WHERE id = $1
         LIMIT 1`,
        [id]
      );

      if (!rows.length) return res.status(404).json({ error: 'not_found' });
      return res.json({ ok: true, row: rows[0] });
    } catch (e) {
      console.error('cashback/admin/get:', e.message);
      return res.status(500).json({ error: 'falha_get' });
    }
  });

  app.patch('/api/cashback/admin/:id', requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id || '').trim();
      const nextStatus = String(req.body?.status || '').trim().toUpperCase();
      const reason = safeText(req.body?.reason, 500);
      const payoutWindow = safeText(req.body?.payoutWindow ?? req.body?.prazo, 120);

      if (!id) return res.status(400).json({ error: 'id_invalido' });
      if (![STATUS.APROVADO, STATUS.REPROVADO, STATUS.PENDENTE].includes(nextStatus)) {
        return res.status(400).json({ error: 'status_invalido' });
      }

      const decidedAt = nextStatus === STATUS.PENDENTE ? null : new Date();

      const { rows } = await q(
        `UPDATE cashback_submissions
         SET status = $2,
             reason = $3,
             payout_window = $4,
             decided_at = $5,
             updated_at = now()
         WHERE id = $1
         RETURNING
           id,
           twitch_name AS "twitchName",
           status,
           reason,
           payout_window AS "payoutWindow",
           created_at AS "createdAt",
           updated_at AS "updatedAt",
           decided_at AS "decidedAt"`,
        [id, nextStatus, reason, payoutWindow, decidedAt]
      );

      if (!rows.length) return res.status(404).json({ error: 'not_found' });

      sseSendAll?.('cashback-changed', { reason: 'decide', id, status: nextStatus });

      return res.json({ ok: true, row: rows[0] });
    } catch (e) {
      console.error('cashback/admin/patch:', e.message);
      return res.status(500).json({ error: 'falha_patch' });
    }
  });
}

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import axios from 'axios';
import QRCode from 'qrcode';
import pkg from 'pg';
import { initTwitchBot } from "./twitch-bot.js";

const { Pool } = pkg;

const {
  PORT = 3000,
  ORIGIN = `http://localhost:3000`,
  STATIC_ROOT,
  ADMIN_USER = 'admin',
  ADMIN_PASSWORD_HASH,
  JWT_SECRET,
  APP_PUBLIC_KEY,
  EFI_CLIENT_ID,
  EFI_CLIENT_SECRET,
  EFI_CERT_PATH,
  EFI_KEY_PATH,
  EFI_BASE_URL,
  EFI_OAUTH_URL,
  EFI_PIX_KEY,
  DATABASE_URL
} = process.env;

const PROD = process.env.NODE_ENV === 'production';

['ADMIN_USER','ADMIN_PASSWORD_HASH','JWT_SECRET'].forEach(k=>{
  if(!process.env[k]) {
    console.error(`❌ Falta ${k} no .env (login)`);
    process.exit(1);
  }
});

['EFI_CLIENT_ID','EFI_CLIENT_SECRET','EFI_CERT_PATH','EFI_KEY_PATH','EFI_PIX_KEY','EFI_BASE_URL','EFI_OAUTH_URL']
  .forEach(k => {
    if(!process.env[k]) {
      console.error(`❌ Falta ${k} no .env (Efi)`);
      process.exit(1);
    }
  });

if (!DATABASE_URL) {
  console.error('❌ Falta DATABASE_URL no .env');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, STATIC_ROOT || '..');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const q = (text, params) => pool.query(text, params);

const httpsAgent = new https.Agent({
  cert: fs.readFileSync(EFI_CERT_PATH),
  key:  fs.readFileSync(EFI_KEY_PATH),
  rejectUnauthorized: true
});

async function getAccessToken() {
  const resp = await axios.post(
    EFI_OAUTH_URL,
    'grant_type=client_credentials',
    {
      httpsAgent,
      auth: { username: EFI_CLIENT_ID, password: EFI_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return resp.data.access_token;
}

function brlStrToCents(strOriginal) {
  const n = Number.parseFloat(String(strOriginal).replace(',', '.'));
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

function uid(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}
function tok(){
  return 'tok_' + crypto.randomBytes(18).toString('hex');
}

const tokenStore = new Map();
const TOKEN_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenStore) {
    if (now - v.createdAt > TOKEN_TTL_MS) tokenStore.delete(k);
  }
}, 60000);

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use((req, res, next) => {
  if (req.url.includes('/.git')) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
  );
  next();
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: ORIGIN, credentials: true }));
app.use(express.static(ROOT, { extensions: ['html'] }));

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function signSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
}
function verifySession(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}
function randomHex(n=32){
  return crypto.randomBytes(n).toString('hex');
}

function setAuthCookies(res, token) {
  const common = {
    sameSite: 'strict',
    secure: PROD,
    maxAge: 2 * 60 * 60 * 1000,
    path: '/'
  };
  res.cookie('session', token, { ...common, httpOnly: true });
  res.cookie('csrf',    randomHex(16), { ...common, httpOnly: false });
}
function clearAuthCookies(res){
  const common = { sameSite: 'strict', secure: PROD, path: '/' };
  res.clearCookie('session', { ...common, httpOnly:true });
  res.clearCookie('csrf',    { ...common });
}

function requireAuth(req, res, next){
  const token = req.cookies?.session;
  const data = token && verifySession(token);
  if (!data) return res.status(401).json({ error: 'unauthorized' });

  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    const csrfHeader = req.get('X-CSRF-Token');
    const csrfCookie = req.cookies?.csrf;
    if (!csrfHeader || csrfHeader !== csrfCookie) {
      return res.status(403).json({ error: 'invalid_csrf' });
    }
  }
  req.user = data;
  next();
}

function requireAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden_admin' });
    }
    next();
  });
}

const sseClients = new Set();
function sseSendAll(event, payload = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

function requireAppKey(req, res, next){
  if (!APP_PUBLIC_KEY) return res.status(403).json({ error:'public_off' });
  const key =
    req.get('X-APP-KEY') ||
    req.get('X-Palpite-Key') ||
    req.query?.key;
  if (!key || key !== APP_PUBLIC_KEY) return res.status(401).json({ error:'unauthorized' });
  next();
}

function parseMoneyToCents(v){
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);

  const s = String(v).trim();
  if (!s) return null;

  const cleaned = s.replace(/[^\d,.\-]/g, '');
  if (!cleaned) return null;

  let numStr = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    numStr = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    numStr = cleaned.replace(',', '.');
  }

  const n = Number.parseFloat(numStr);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

const PALPITE = {
  roundId: null,
  isOpen: false,
  buyValueCents: 0,
  winnersCount: 3,
  createdAt: null,
  actualResultCents: null,
  winners: [],
  winnersAt: null
};

const palpiteSseClients = new Set();
function palpiteSendAll(event, payload = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of palpiteSseClients) {
    try { res.write(msg); } catch {}
  }
}

const palpiteAdminSseClients = new Set();
function palpiteAdminSendAll(event, payload = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  for (const res of palpiteAdminSseClients) {
    try { res.write(msg); } catch {}
  }
}

async function palpiteLoadFromDB(){
  try{
    const { rows } = await q(
      `select id,
              is_open      as "isOpen",
              buy_value_cents as "buyValueCents",
              winners_count as "winnersCount",
              created_at   as "createdAt"
         from palpite_rounds
        order by created_at desc
        limit 1`
    );
    if (rows.length){
      const r = rows[0];
      PALPITE.roundId = r.id;
      PALPITE.isOpen = !!r.isOpen;
      PALPITE.buyValueCents = Number(r.buyValueCents || 0) | 0;
      PALPITE.winnersCount = Number(r.winnersCount || 3) | 0;
      PALPITE.createdAt = r.createdAt || null;
    }
  }catch(e){
    console.error('palpiteLoadFromDB:', e.message);
  }
}

async function palpiteGetEntries(limit = 300){
  if (!PALPITE.roundId) return [];
  const lim = Math.min(Math.max(parseInt(limit,10)||300, 1), 1000);
  const { rows } = await q(
    `select user_name  as "user",
            guess_cents as "guessCents",
            raw_text    as "rawText",
            created_at  as "createdAt",
            updated_at  as "updatedAt"
       from palpite_entries
      where round_id = $1
      order by updated_at desc, created_at desc
      limit ${lim}`,
    [PALPITE.roundId]
  );
  return rows;
}

async function palpiteCountEntries(){
  if (!PALPITE.roundId) return 0;
  const { rows } = await q(
    `select count(*)::int as c from palpite_entries where round_id = $1`,
    [PALPITE.roundId]
  );
  return rows?.[0]?.c ?? 0;
}

async function palpiteStatePayload(){
  const entries = await palpiteGetEntries(500);
  const total = await palpiteCountEntries();
  return {
    roundId: PALPITE.roundId,
    isOpen: PALPITE.isOpen,
    buyValueCents: PALPITE.buyValueCents,
    winnersCount: PALPITE.winnersCount,
    createdAt: PALPITE.createdAt,
    total,
    entries,
    actualResultCents: PALPITE.actualResultCents,
    winners: PALPITE.winners,
    winnersAt: PALPITE.winnersAt
  };
}

async function palpiteAdminCompactState(){
  const entries = await palpiteGetEntries(60);
  const lastGuesses = entries.slice(0, 24).map(e => ({
    name: e.user,
    value: (e.guessCents || 0) / 100
  }));
  return {
    open: PALPITE.isOpen,
    buyValue: (PALPITE.buyValueCents || 0) / 100,
    totalGuesses: await palpiteCountEntries(),
    lastGuesses
  };
}

function mapCupom(row){
  if (!row) return null;
  return {
    id: row.id,
    codigo: row.codigo,
    valorCentavos: row.valor_cents,
    ativo: row.ativo,
    maxUsos: row.max_usos,
    usadoEm: row.usado_em,
    expiraEm: row.expira_em,
    usadoPorNome: row.usado_por_nome,
    usadoPorPixType: row.usado_por_pix_type,
    usadoPorPixKey: row.usado_por_pix_key,
    usadoPorMessage: row.usado_por_message,
    createdAt: row.created_at
  };
}

function normalizarCodigo(c){
  return String(c || '').trim().toUpperCase();
}

function gerarCodigoCupom(){
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tmp = '';
  for (let i = 0; i < 8; i++) {
    tmp += alpha[Math.floor(Math.random() * alpha.length)];
  }
  return tmp.slice(0,4) + '-' + tmp.slice(4);
}

app.use('/api', (req, res, next) => {
  const openRoutes = [
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/me',
    '/api/pix/cob',
    '/api/pix/status',
    '/api/sorteio/inscrever',
    '/api/cupons/resgatar',
    '/api/palpite/stream',
    '/api/palpite/guess',
    '/api/palpite/state-public'
  ];

  if (openRoutes.some(r => req.path.startsWith(r.replace('/api','')))) {
    return next();
  }

  const token = req.cookies?.session;
  const data  = token && verifySession(token);

  if (!data) {
    return res.status(401).json({ error: 'unauthorized_global' });
  }

  req.user = data;
  next();
});

app.get('/api/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  res.flushHeaders?.();
  sseClients.add(res);

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
    try { res.end(); } catch {}
  });
});

app.get('/api/palpite/stream', requireAppKey, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();
  palpiteSseClients.add(res);

  try{
    const state = await palpiteStatePayload();
    res.write(`event: palpite-init\ndata: ${JSON.stringify(state)}\n\n`);
  }catch{}

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    palpiteSseClients.delete(res);
    try { res.end(); } catch {}
  });
});

app.get('/api/palpite/state-public', requireAppKey, async (req, res) => {
  const state = await palpiteStatePayload();
  res.json(state);
});

app.get('/api/palpite/admin/stream', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();
  palpiteAdminSseClients.add(res);

  try{
    const st = await palpiteAdminCompactState();
    res.write(`event: state\ndata: ${JSON.stringify(st)}\n\n`);
  }catch{}

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    palpiteAdminSseClients.delete(res);
    try { res.end(); } catch {}
  });
});

app.get('/api/palpite/admin/state', requireAuth, async (req, res) => {
  const st = await palpiteAdminCompactState();
  res.json(st);
});

app.post('/api/palpite/guess', requireAppKey, async (req, res) => {
  try{
    if (!PALPITE.roundId) return res.status(409).json({ error:'no_round' });
    if (!PALPITE.isOpen)  return res.status(409).json({ error:'palpite_closed' });

    const user =
      String(req.body?.user || req.body?.username || req.body?.nome || '').trim();

    const raw =
      req.body?.rawText ?? req.body?.raw ?? req.body?.text ?? req.body?.value ?? '';

    const cents = parseMoneyToCents(req.body?.value ?? req.body?.guess ?? raw);
    if (!user || cents == null || cents < 0) {
      return res.status(400).json({ error:'dados_invalidos' });
    }

    const { rows } = await q(
      `insert into palpite_entries (round_id, user_name, guess_cents, raw_text, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (round_id, user_name)
       do update set guess_cents = excluded.guess_cents,
                     raw_text   = excluded.raw_text,
                     updated_at = now()
       returning user_name as "user",
                 guess_cents as "guessCents",
                 raw_text as "rawText",
                 created_at as "createdAt",
                 updated_at as "updatedAt"`,
      [PALPITE.roundId, user, cents, String(raw || '').slice(0, 300)]
    );

    const entry = rows[0];
    const total = await palpiteCountEntries();

    palpiteSendAll('palpite-guess', { entry, total });

    palpiteAdminSendAll('guess', {
      name: entry.user,
      value: (entry.guessCents || 0) / 100,
      totalGuesses: total
    });
    palpiteAdminSendAll('state', await palpiteAdminCompactState());

    sseSendAll('palpite-changed', { reason:'guess', entry });

    res.json({ ok:true, entry });
  }catch(e){
    console.error('palpite/guess:', e.message);
    res.status(500).json({ error:'falha_palpite' });
  }
});

app.get('/api/palpite/state', requireAuth, async (req, res) => {
  const state = await palpiteStatePayload();
  res.json(state);
});

app.post('/api/palpite/start', requireAuth, async (req, res) => {
  req.body = {
    buyValue: req.body?.buyValue ?? req.body?.buy ?? req.body?.buyValueCents ?? 0,
    winnersCount: req.body?.winnersCount ?? req.body?.winners ?? 3
  };
  try{
    const buyCents =
      (typeof req.body?.buyValueCents === 'number' ? (req.body.buyValueCents|0) : null) ??
      parseMoneyToCents(req.body?.buyValue ?? req.body?.buy ?? 0) ??
      0;

    let winners =
      parseInt(req.body?.winnersCount ?? req.body?.winners ?? 3, 10);

    if (!Number.isFinite(winners) || winners < 1) winners = 1;
    if (winners > 10) winners = 10;

    if (PALPITE.roundId && PALPITE.isOpen) {
      try{
        await q(
          `update palpite_rounds
              set is_open = false,
                  closed_at = now(),
                  updated_at = now()
            where id = $1`,
          [PALPITE.roundId]
        );
      }catch{}
    }

    const roundId = uid();

    await q(
      `insert into palpite_rounds (id, is_open, buy_value_cents, winners_count, created_at, updated_at)
       values ($1, true, $2, $3, now(), now())`,
      [roundId, buyCents|0, winners|0]
    );

    PALPITE.roundId = roundId;
    PALPITE.isOpen = true;
    PALPITE.buyValueCents = buyCents|0;
    PALPITE.winnersCount = winners|0;
    PALPITE.createdAt = new Date().toISOString();

    const state = await palpiteStatePayload();

    palpiteSendAll('palpite-open', state);
    palpiteAdminSendAll('state', await palpiteAdminCompactState());
    sseSendAll('palpite-changed', { reason:'open', state });

    res.json({ ok:true, roundId });
  }catch(e){
    console.error('palpite/start:', e.message);
    res.status(500).json({ error:'falha_start' });
  }
});

app.post('/api/palpite/stop', requireAuth, async (req, res) => {
  try{
    if (!PALPITE.roundId) return res.json({ ok:true });

    await q(
      `update palpite_rounds
          set is_open = false,
              closed_at = now(),
              updated_at = now()
        where id = $1`,
      [PALPITE.roundId]
    );

    PALPITE.isOpen = false;

    const state = await palpiteStatePayload();
    palpiteSendAll('palpite-close', state);
    palpiteAdminSendAll('state', await palpiteAdminCompactState());
    sseSendAll('palpite-changed', { reason:'close', state });

    res.json({ ok:true });
  }catch(e){
    console.error('palpite/stop:', e.message);
    res.status(500).json({ error:'falha_stop' });
  }
});

app.post('/api/palpite/open', requireAuth, async (req, res) => {
  try{
    const buyCents =
      (typeof req.body?.buyValueCents === 'number' ? (req.body.buyValueCents|0) : null) ??
      parseMoneyToCents(req.body?.buyValue ?? req.body?.buy ?? 0) ??
      0;

    let winners =
      parseInt(req.body?.winnersCount ?? req.body?.winners ?? 3, 10);

    if (!Number.isFinite(winners) || winners < 1) winners = 1;
    if (winners > 10) winners = 10;

    if (PALPITE.roundId && PALPITE.isOpen) {
      try{
        await q(
          `update palpite_rounds
              set is_open = false,
                  closed_at = now(),
                  updated_at = now()
            where id = $1`,
          [PALPITE.roundId]
        );
      }catch{}
    }

    const roundId = uid();

    await q(
      `insert into palpite_rounds (id, is_open, buy_value_cents, winners_count, created_at, updated_at)
       values ($1, true, $2, $3, now(), now())`,
      [roundId, buyCents|0, winners|0]
    );

    PALPITE.roundId = roundId;
    PALPITE.actualResultCents = null;
    PALPITE.winners = [];
    PALPITE.winnersAt = null;
    PALPITE.isOpen = true;
    PALPITE.buyValueCents = buyCents|0;
    PALPITE.winnersCount = winners|0;
    PALPITE.createdAt = new Date().toISOString();

    const state = await palpiteStatePayload();

    palpiteSendAll('palpite-open', state);
    palpiteAdminSendAll('state', await palpiteAdminCompactState());
    sseSendAll('palpite-changed', { reason:'open', state });

    if (twitchBot?.enabled) {
      twitchBot.say(`🔔 PALPITE ABERTO! Digite: !palpite 230,50`);
    }

    res.json({ ok:true, roundId });
  }catch(e){
    console.error('palpite/open:', e.message);
    res.status(500).json({ error:'falha_open' });
  }
});

app.post('/api/palpite/close', requireAuth, async (req, res) => {
  try{
    if (!PALPITE.roundId) return res.json({ ok:true });

    await q(
      `update palpite_rounds
          set is_open = false,
              closed_at = now(),
              updated_at = now()
        where id = $1`,
      [PALPITE.roundId]
    );

    PALPITE.isOpen = false;

    const state = await palpiteStatePayload();
    palpiteSendAll('palpite-close', state);
    palpiteAdminSendAll('state', await palpiteAdminCompactState());
    sseSendAll('palpite-changed', { reason:'close', state });

    if (twitchBot?.enabled) {
      twitchBot.say(`⛔ PALPITE FECHADO!`);
    }

    res.json({ ok:true });
  }catch(e){
    console.error('palpite/close:', e.message);
    res.status(500).json({ error:'falha_close' });
  }
});

app.post('/api/palpite/clear', requireAuth, async (req, res) => {
  try{
    if (!PALPITE.roundId) return res.json({ ok:true });

    await q(`delete from palpite_entries where round_id = $1`, [PALPITE.roundId]);

    PALPITE.actualResultCents = null;
    PALPITE.winners = [];
    PALPITE.winnersAt = null;

    const state = await palpiteStatePayload();
    palpiteSendAll('palpite-clear', state);

    palpiteAdminSendAll('clear', {});
    palpiteAdminSendAll('state', await palpiteAdminCompactState());

    sseSendAll('palpite-changed', { reason:'clear', state });

    res.json({ ok:true });
  }catch(e){
    console.error('palpite/clear:', e.message);
    res.status(500).json({ error:'falha_clear' });
  }
});

app.post('/api/palpite/winners', requireAdmin, async (req, res) => {
  try {
    if (!PALPITE.roundId) return res.status(409).json({ error: 'no_round' });

    let actualCents =
      req.body?.actualResultCents != null ? Number(req.body.actualResultCents) : null;

    if (!Number.isFinite(actualCents)) {
      actualCents = parseMoneyToCents(req.body?.actualResult ?? req.body?.actual ?? req.body?.value);
    }

    if (!Number.isFinite(actualCents) || actualCents == null) {
      return res.status(400).json({ error: 'actual_invalido' });
    }

    let winnersCount = Number(req.body?.winnersCount ?? PALPITE.winnersCount ?? 3);
    winnersCount = Math.max(1, Math.min(3, winnersCount));

    const entries = await palpiteGetEntries(1000);
    if (!entries.length) {
      return res.status(400).json({ error: 'sem_palpites' });
    }

    const ranked = entries
      .map(e => ({
        name: e.user,
        valueCents: Number(e.guessCents || 0) | 0,
        deltaCents: Math.abs((Number(e.guessCents || 0) | 0) - actualCents),
      }))
      .sort((a, b) => a.deltaCents - b.deltaCents);

    const winners = ranked.slice(0, winnersCount);

    PALPITE.actualResultCents = actualCents;
    PALPITE.winnersCount = winnersCount;
    PALPITE.winners = winners;
    PALPITE.winnersAt = new Date().toISOString();
    PALPITE.isOpen = false;

    const state = await palpiteStatePayload();

    palpiteSendAll('palpite-winners', state);

    palpiteAdminSendAll('state', await palpiteAdminCompactState());

    sseSendAll('palpite-changed', { reason: 'winners', winners, actualResultCents: actualCents });

    return res.json({ ok: true, winners, actualResultCents: actualCents, winnersCount });
  } catch (e) {
    console.error('palpite/winners:', e.message);
    return res.status(500).json({ error: 'falha_winners' });
  }
});

app.get('/palpite-overlay.html', (req, res) => {
  if (!APP_PUBLIC_KEY) {
    return res.status(403).send('public_off');
  }
  const key = String(req.query?.key || '');
  if (!key || key !== APP_PUBLIC_KEY) {
    return res.status(401).send('unauthorized');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Palpite Overlay</title>
<style>
  html,body{ margin:0; padding:0; background:transparent; font-family:Inter,system-ui,Arial; }
  .wrap{
    position:fixed; left:20px; top:20px;
    width: 460px; max-width: calc(100vw - 40px);
    color:#fff;
  }
  .card{
    background: linear-gradient(180deg, rgba(0,0,0,.55), rgba(0,0,0,.25));
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 14px;
    box-shadow: 0 18px 60px rgba(0,0,0,.45);
    padding: 12px 12px 10px;
    backdrop-filter: blur(6px) saturate(1.1);
  }
  .head{ display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .title{ font-weight:800; font-size:16px; letter-spacing:.2px; }
  .pill{
    font-size:12px; font-weight:800;
    padding:6px 10px; border-radius:999px;
    background: rgba(255,255,255,.10);
    border:1px solid rgba(255,255,255,.18);
  }
  .pill.on{ background: rgba(46, 204, 113, .18); border-color: rgba(46,204,113,.35); }
  .pill.off{ background: rgba(231,76,60,.18); border-color: rgba(231,76,60,.35); }
  .sub{ margin:8px 0 0; font-size:12px; opacity:.9; }
  .log{ margin-top:10px; display:grid; gap:8px; }
  .item{
    display:flex; justify-content:space-between; gap:10px; align-items:center;
    padding:10px 10px;
    border-radius: 12px;
    background: rgba(255,255,255,.08);
    border: 1px solid rgba(255,255,255,.14);
    animation: in .18s ease-out;
  }
  @keyframes in{ from{ opacity:0; transform: translateY(6px) scale(.98);} to{opacity:1; transform:none;} }
  .name{ font-weight:800; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .val{ font-weight:800; font-variant-numeric: tabular-nums; }
  .foot{ margin-top:8px; font-size:12px; opacity:.85; display:flex; justify-content:space-between; }
  .muted{ opacity:.75; }
  .hide{ opacity:0; transform: translateY(6px); transition: .35s ease; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="head">
      <div class="title">💰 Palpite Exato</div>
      <div id="statusPill" class="pill off">FECHADO</div>
    </div>
    <div class="sub">
      Compra (Bonus Buy): <span id="buyVal" class="muted">—</span>
    </div>

    <div id="log" class="log"></div>

    <div class="foot">
      <div>Total: <span id="total">0</span></div>
      <div class="muted">Atualiza ao vivo</div>
    </div>
  </div>
</div>

<script>
  const fmtBRL = (c)=> (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const params = new URLSearchParams(location.search);
  const key = params.get('key');

  const elLog = document.getElementById('log');
  const elTotal = document.getElementById('total');
  const elBuy = document.getElementById('buyVal');
  const pill = document.getElementById('statusPill');

  const MAX = 18;
  const TTL = 12000;

  function setStatus(isOpen){
    pill.classList.toggle('on', !!isOpen);
    pill.classList.toggle('off', !isOpen);
    pill.textContent = isOpen ? 'ABERTO' : 'FECHADO';
  }

  function renderInit(state){
    setStatus(state.isOpen);
    elBuy.textContent = state.buyValueCents ? fmtBRL(state.buyValueCents) : '—';
    elTotal.textContent = state.total || 0;

    elLog.innerHTML = '';
    (state.entries || []).slice(0, MAX).forEach(e => addItem(e.user, e.guessCents, false));
  }

  function addItem(user, cents, animate=true){
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = \`
      <div class="name">\${escapeHtml(user || '')}</div>
      <div class="val">\${fmtBRL(cents||0)}</div>
    \`;
    if (!animate) div.style.animation = 'none';

    elLog.prepend(div);
    while (elLog.children.length > MAX) elLog.removeChild(elLog.lastChild);

    setTimeout(() => {
      div.classList.add('hide');
      setTimeout(()=> div.remove(), 380);
    }, TTL);
  }

  function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  const es = new EventSource('/api/palpite/stream?key=' + encodeURIComponent(key));

  es.addEventListener('palpite-init', (ev)=>{
    try{ renderInit(JSON.parse(ev.data||'{}')); }catch{}
  });

  es.addEventListener('palpite-open', (ev)=>{
    try{ renderInit(JSON.parse(ev.data||'{}')); }catch{}
  });

  es.addEventListener('palpite-close', (ev)=>{
    try{
      const st = JSON.parse(ev.data||'{}');
      setStatus(false);
      elTotal.textContent = st.total || elTotal.textContent;
    }catch{
      setStatus(false);
    }
  });

  es.addEventListener('palpite-clear', (ev)=>{
    try{ renderInit(JSON.parse(ev.data||'{}')); }catch{
      elLog.innerHTML = '';
      elTotal.textContent = '0';
    }
  });

  es.addEventListener('palpite-guess', (ev)=>{
    try{
      const data = JSON.parse(ev.data||'{}');
      const entry = data.entry || {};
      if (entry.user) addItem(entry.user, entry.guessCents, true);
      if (data.total != null) elTotal.textContent = String(data.total);
      else elTotal.textContent = String(Number(elTotal.textContent||0) + 1);
    }catch{}
  });

  es.addEventListener('palpite-winners', ()=>{});

  es.onerror = ()=>{};
</script>
</body>
</html>`);
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const userOk = username === ADMIN_USER;
  const passOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!userOk || !passOk) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = signSession({ sub: ADMIN_USER, role: 'admin' });
  setAuthCookies(res, token);
  return res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookies(res);
  return res.json({ ok:true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies?.session;
  const data  = token && verifySession(token);
  if (!data) return res.status(401).json({ error: 'unauthorized' });
  return res.json({ user: { username: data.sub } });
});

app.get('/area.html', (req, res) => {
  const token = req.cookies?.session;
  if (!token || !verifySession(token)) return res.redirect('/login.html');
  return res.sendFile(path.join(ROOT, 'area.html'));
});

app.get('/health', async (req, res) => {
  try {
    fs.accessSync(EFI_CERT_PATH);
    fs.accessSync(EFI_KEY_PATH);
    await q('select 1');
    return res.json({ ok:true, cert:EFI_CERT_PATH, key:EFI_KEY_PATH, pg:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/api/pix/ping', async (req, res) => {
  try {
    const token = await getAccessToken();
    return res.json({ ok:true, token:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.post('/api/pix/cob', async (req, res) => {
  try {
    const { nome, cpf, valorCentavos } = req.body || {};
    if (!nome || typeof valorCentavos !== 'number' || valorCentavos < 1) {
      return res.status(400).json({ error: 'Dados inválidos (mínimo R$ 10,00)' });
    }
    const access = await getAccessToken();
    const valor = (valorCentavos / 100).toFixed(2);

    const payload = {
      calendario: { expiracao: 3600 },
      valor: { original: valor },
      chave: EFI_PIX_KEY,
      infoAdicionais: [{ nome: 'Nome', valor: nome }]
    };
    if (cpf) {
      const cpfNum = String(cpf).replace(/\D/g, '');
      if (cpfNum.length !== 11) {
        return res.status(400).json({ error: 'cpf_invalido' });
      }
      payload.devedor = { cpf: cpfNum, nome };
    }

    const { data: cob } = await axios.post(`${EFI_BASE_URL}/v2/cob`, payload, {
      httpsAgent,
      headers: { Authorization: `Bearer ${access}` }
    });
    const { txid, loc } = cob;

    const { data: qr } = await axios.get(`${EFI_BASE_URL}/v2/loc/${loc.id}/qrcode`, {
      httpsAgent,
      headers: { Authorization: `Bearer ${access}` }
    });

    const tokenOpaque = tok();
    tokenStore.set(tokenOpaque, { txid, createdAt: Date.now() });

    const emv = qr.qrcode;
    const qrPng = qr.imagemQrcode || (await QRCode.toDataURL(emv));
    res.json({ token: tokenOpaque, emv, qrPng });
  } catch (err) {
    console.error('Erro /api/pix/cob:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao criar cobrança PIX' });
  }
});

app.get('/api/pix/status/:token', async (req, res) => {
  try {
    const rec = tokenStore.get(req.params.token);
    if (!rec) return res.status(404).json({ error: 'token_not_found' });
    const access = await getAccessToken();
    const { data } = await axios.get(
      `${EFI_BASE_URL}/v2/cob/${encodeURIComponent(rec.txid)}`,
      { httpsAgent, headers: { Authorization: `Bearer ${access}` } }
    );
    res.json({ status: data.status });
  } catch (err) {
    console.error('Erro status:', err.response?.data || err.message);
    res.status(500).json({ error: 'Falha ao consultar status' });
  }
});

app.post('/api/pix/confirmar', async (req, res) => {
  try{
    if (!APP_PUBLIC_KEY) return res.status(403).json({ error:'public_off' });
    const key = req.get('X-APP-KEY');
    if (!key || key !== APP_PUBLIC_KEY) return res.status(401).json({ error:'unauthorized' });

    const { token, nome, valorCentavos, tipo=null, chave=null, message=null } = req.body || {};
    if (!token || !nome || typeof valorCentavos !== 'number' || valorCentavos < 1) {
      return res.status(400).json({ error:'dados_invalidos' });
    }

    const rec = tokenStore.get(token);
    if (!rec) return res.status(404).json({ error:'token_not_found' });

    const access = await getAccessToken();
    const { data } = await axios.get(
      `${EFI_BASE_URL}/v2/cob/${encodeURIComponent(rec.txid)}`,
      { httpsAgent, headers: { Authorization: `Bearer ${access}` } }
    );

    if (data.status !== 'CONCLUIDA') {
      return res.status(409).json({ error:'pix_nao_concluido' });
    }
    const valorEfiCents = brlStrToCents(data?.valor?.original);
    if (valorEfiCents == null) {
      return res.status(500).json({ error:'valor_invalido_efi' });
    }
    if (valorEfiCents !== valorCentavos) {
      return res.status(409).json({ error:'valor_divergente' });
    }

    const id = uid();
    const { rows } = await q(
      `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, message, created_at)
       values ($1,$2,$3,$4,$5,$6,$7, now())
       returning id, nome,
                 deposito_cents as "depositoCents",
                 banca_cents    as "bancaCents",
                 pix_type       as "pixType",
                 pix_key        as "pixKey",
                 message        as "message",
                 created_at     as "createdAt"`,
      [id, nome, valorCentavos, null, tipo, chave, message]
    );

    await q(
      `insert into extratos (id, ref_id, nome, tipo, valor_cents, created_at)
       values ($1,$2,$3,'deposito',$4, now())`,
      [uid(), rows[0].id, nome, valorCentavos]
    );
    sseSendAll('extratos-changed', { reason: 'deposito' });

    tokenStore.delete(token);
    sseSendAll('bancas-changed', { reason: 'insert-confirmed' });

    return res.json({ ok:true, ...rows[0] });
  }catch(e){
    console.error('pix/confirmar:', e.response?.data || e.message);
    return res.status(500).json({ error:'falha_confirmar' });
  }
});



const areaAuth = [requireAuth];

app.get('/api/bancas', areaAuth, async (req, res) => {
  const { rows } = await q(
    `select id, nome,
            deposito_cents as "depositoCents",
            banca_cents    as "bancaCents",
            pix_type       as "pixType",
            pix_key        as "pixKey",
            message        as "message",
            created_at     as "createdAt"
     from bancas
     order by created_at desc`
  );
  res.json(rows);
});

app.post('/api/bancas', areaAuth, async (req, res) => {
  const { nome, depositoCents, pixType=null, pixKey=null, message=null } = req.body || {};
  if (!nome || typeof depositoCents !== 'number' || depositoCents <= 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const id = uid();
  const { rows } = await q(
    `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, message, created_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     returning id, nome, deposito_cents as "depositoCents", banca_cents as "bancaCents",
               pix_type as "pixType", pix_key as "pixKey", message as "message", created_at as "createdAt"`,
    [id, nome, depositoCents, null, pixType, pixKey, message]
  );

  sseSendAll('bancas-changed', { reason: 'insert' });
  res.json(rows[0]);
});

app.patch('/api/bancas/:id', areaAuth, async (req, res) => {
  const { bancaCents } = req.body || {};
  if (typeof bancaCents !== 'number' || bancaCents < 0) {
    return res.status(400).json({ error: 'dados_invalidos' });
  }
  const { rows } = await q(
    `update bancas set banca_cents = $2
     where id = $1
     returning id, nome,
               deposito_cents as "depositoCents",
               banca_cents    as "bancaCents",
               pix_type       as "pixType",
               pix_key        as "pixKey",
               message        as "message",
               created_at     as "createdAt"`,
    [req.params.id, bancaCents]
  );
  if (!rows.length) return res.status(404).json({ error:'not_found' });

  sseSendAll('bancas-changed', { reason: 'update' });
  res.json(rows[0]);
});

app.post('/api/bancas/:id/to-pagamento', areaAuth, async (req, res) => {
  const { bancaCents } = req.body || {};
  const client = await pool.connect();
  try{
    await client.query('begin');

    const sel = await client.query(
      `select id, nome, deposito_cents, banca_cents, pix_type, pix_key, message, created_at
       from bancas where id = $1 for update`,
      [req.params.id]
    );
    if (!sel.rows.length) {
      await client.query('rollback');
      return res.status(404).json({ error:'not_found' });
    }
    const b = sel.rows[0];

    const bancaFinal = (typeof bancaCents === 'number' && bancaCents >= 0)
      ? bancaCents
      : (typeof b.banca_cents === 'number' && b.banca_cents > 0 ? b.banca_cents : b.deposito_cents);

    await client.query(
      `insert into pagamentos (id, nome, pagamento_cents, pix_type, pix_key, message, status, created_at, paid_at)
       values ($1,$2,$3,$4,$5,$6,'nao_pago',$7,null)`,
      [b.id, b.nome, bancaFinal, b.pix_type, b.pix_key, b.message || null, b.created_at]
    );
    await client.query(`delete from bancas where id = $1`, [b.id]);

    await client.query('commit');

    sseSendAll('bancas-changed', { reason: 'moved' });
    sseSendAll('pagamentos-changed', { reason: 'moved' });

    res.json({ ok:true });
  }catch(e){
    await client.query('rollback');
    console.error('to-pagamento:', e.message);
    res.status(500).json({ error:'falha_mover' });
  }finally{
    client.release();
  }
});

app.post('/api/pagamentos/:id/to-banca', areaAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const sel = await client.query(
      `select id, nome, pagamento_cents, pix_type, pix_key, message, created_at
         from pagamentos where id = $1 for update`,
      [req.params.id]
    );
    if (!sel.rows.length) {
      await client.query('rollback');
      return res.status(404).json({ error: 'not_found' });
    }
    const p = sel.rows[0];

    await client.query(
      `insert into bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, message, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.id, p.nome, p.pagamento_cents, p.pagamento_cents, p.pix_type, p.pix_key, p.message || null, p.created_at]
    );
    await client.query(`delete from pagamentos where id = $1`, [p.id]);

    await client.query('commit');

    sseSendAll('bancas-changed', { reason: 'moved-back' });
    sseSendAll('pagamentos-changed', { reason: 'moved-back' });

    return res.json({ ok: true });
  } catch (e) {
    await client.query('rollback');
    console.error('to-banca:', e.message);
    return res.status(500).json({ error: 'falha_mover' });
  } finally {
    client.release();
  }
});

app.delete('/api/bancas/:id', areaAuth, async (req, res) => {
  const r = await q(`delete from bancas where id = $1`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error:'not_found' });
  sseSendAll('bancas-changed', { reason: 'delete' });
  res.json({ ok:true });
});

app.get('/api/pagamentos', areaAuth, async (req, res) => {
  const { rows } = await q(
    `select id, nome,
            pagamento_cents as "pagamentoCents",
            pix_type        as "pixType",
            pix_key         as "pixKey",
            message         as "message",
            status,
            created_at      as "createdAt",
            paid_at         as "paidAt"
     from pagamentos
     order by created_at desc`
  );
  res.json(rows);
});

app.patch('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['pago','nao_pago'].includes(status)) {
    return res.status(400).json({ error: 'status_invalido' });
  }

  const beforeQ = await q(
    `select id, nome, pagamento_cents, status, paid_at from pagamentos where id = $1`,
    [req.params.id]
  );
  if (!beforeQ.rows.length) return res.status(404).json({ error:'not_found' });

  const { rows } = await q(
    `update pagamentos
       set status = $2,
           paid_at = case when $2 = 'pago' then now() else null end
     where id = $1
     returning id, nome,
               pagamento_cents as "pagamentoCents",
               pix_type as "PixType",
               pix_key  as "pixKey",
               status, created_at as "CreatedAt", paid_at as "paidAt"`,
    [req.params.id, status]
  );
  if (!rows.length) return res.status(404).json({ error:'not_found' });

  sseSendAll('pagamentos-changed', { reason: 'update-status' });
  res.json(rows[0]);
});

app.delete('/api/pagamentos/:id', areaAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const sel = await client.query(
      `select id, nome, pagamento_cents, status, paid_at
         from pagamentos
        where id = $1
        for update`,
      [req.params.id]
    );
    if (!sel.rows.length) {
      await client.query('rollback');
      return res.status(404).json({ error:'not_found' });
    }
    const p = sel.rows[0];

    let insertedExtrato = false;
    if (p.status === 'pago') {
      await client.query(
        `insert into extratos (id, ref_id, nome, tipo, valor_cents, created_at)
         values ($1,$2,$3,'pagamento',$4, coalesce($5, now()))`,
        [uid(), p.id, p.nome, p.pagamento_cents, p.paid_at]
      );
      insertedExtrato = true;
    }

    const del = await client.query(`delete from pagamentos where id = $1`, [p.id]);
    if (del.rowCount === 0) {
      await client.query('rollback');
      return res.status(404).json({ error:'not_found' });
    }

    await client.query('commit');

    if (insertedExtrato) sseSendAll('extratos-changed', { reason: 'pagamento-finalizado' });
    sseSendAll('pagamentos-changed', { reason: 'delete' });

    return res.json({ ok:true });
  } catch (e) {
    await client.query('rollback');
    console.error('delete pagamento:', e.message);
    return res.status(500).json({ error:'falha_delete' });
  } finally {
    client.release();
  }
});

app.get('/qr', async (req, res) => {
  try {
    const data = String(req.query.data || '');
    const size = Math.max(120, Math.min(1024, parseInt(req.query.size || '240', 10)));
    if (!data) return res.status(400).send('missing data');

    const png = await QRCode.toBuffer(data, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size
    });

    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    res.status(500).send('qr error');
  }
});

app.get('/api/sorteio/inscricoes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, nome_twitch, mensagem, criado_em FROM sorteio_inscricoes ORDER BY criado_em DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/sorteio/inscricoes', err);
    res.status(500).json({ error: 'Erro ao buscar inscritos' });
  }
});

app.post('/api/sorteio/inscrever', async (req, res) => {
  const { nome_twitch, mensagem } = req.body;

  if (!nome_twitch || !mensagem) {
    return res.status(400).json({ ok: false, error: 'nome_twitch e mensagem (ID) são obrigatórios.' });
  }

  try {
    await pool.query(
      `INSERT INTO sorteio_inscricoes (nome_twitch, mensagem)
       VALUES ($1, $2)`,
      [nome_twitch, mensagem]
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        ok: false,
        code: 'ID_DUPLICADO',
        error: 'Esse ID já está cadastrado.'
      });
    }

    console.error('Erro ao inserir inscrição do sorteio', err);
    return res.status(500).json({ ok: false, error: 'Erro interno ao salvar inscrição.' });
  }
});

app.delete('/api/sorteio/inscricoes/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });

    await pool.query('DELETE FROM sorteio_inscricoes WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/sorteio/inscricoes/:id', err);
    res.status(500).json({ error: 'Erro ao excluir inscrição' });
  }
});

app.delete('/api/sorteio/inscricoes', async (req, res) => {
  try {
    await pool.query('TRUNCATE TABLE sorteio_inscricoes');
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/sorteio/inscricoes', err);
    res.status(500).json({ error: 'Erro ao limpar inscrições' });
  }
});

app.post('/api/bancas/manual', areaAuth, async (req, res) => {
  const { nome, depositoCents, pixKey, pixType } = req.body || {};

  const nomeTrim    = (nome || '').trim();
  const deposito    = Number(depositoCents || 0) | 0;
  const pix         = (pixKey || '').trim();
  const pixTypeNorm = ['email','cpf','phone','random'].includes(pixType) ? pixType : null;

  if (!nomeTrim || deposito <= 0) {
    return res.status(400).json({ error: 'Nome e depósito são obrigatórios.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bancaId = uid();

    const insertBanca = await client.query(
      `INSERT INTO bancas (id, nome, deposito_cents, banca_cents, pix_type, pix_key, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, now())
       RETURNING id, nome, deposito_cents, banca_cents, pix_type, pix_key, message, created_at`,
      [bancaId, nomeTrim, deposito, deposito, pixTypeNorm, pix || null]
    );
    const row = insertBanca.rows[0];

    await client.query(
      `INSERT INTO extratos (id, ref_id, nome, tipo, valor_cents, created_at)
       VALUES ($1, $2, $3, 'deposito', $4, now())`,
      [uid(), row.id, nomeTrim, deposito]
    );

    await client.query('COMMIT');

    sseSendAll('bancas-changed', { reason: 'manual' });
    sseSendAll('extratos-changed', { reason: 'deposito-manual' });

    return res.status(201).json({
      id:            row.id,
      nome:          row.nome,
      depositoCents: row.deposito_cents,
      bancaCents:    row.banca_cents,
      pixType:       row.pix_type,
      pixKey:        row.pix_key,
      message:       row.message,
      createdAt:     row.created_at
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar banca manual:', err);
    return res.status(500).json({ error: 'Erro ao criar banca manual.' });
  } finally {
    client.release();
  }
});

app.get('/api/extratos', areaAuth, async (req, res) => {
  let { tipo, nome, from, to, range, limit = 200 } = req.query || {};

  const conds = [];
  const params = [];
  let i = 1;

  if (tipo && ['deposito','pagamento'].includes(tipo)) {
    conds.push(`tipo = $${i++}`);
    params.push(tipo);
  }
  if (nome) {
    conds.push(`lower(nome) LIKE $${i++}`);
    params.push(`%${String(nome).toLowerCase()}%`);
  }

  const now = new Date();
  const startOfDay = (d)=>{
    const x = new Date(d);
    x.setHours(0,0,0,0);
    return x;
  };
  const addDays = (d,n)=>{
    const x = new Date(d);
    x.setDate(x.getDate()+n);
    return x;
  };

  if (range) {
    if (range === 'today') {
      from = startOfDay(now).toISOString();
      to   = addDays(startOfDay(now), 1).toISOString();
    }
    if (range === 'last7') {
      from = addDays(startOfDay(now), -6).toISOString();
      to   = addDays(startOfDay(now), 1).toISOString();
    }
    if (range === 'last30'){
      from = addDays(startOfDay(now), -29).toISOString();
      to   = addDays(startOfDay(now), 1).toISOString();
    }
  }

  if (from) {
    conds.push(`created_at >= $${i++}`);
    params.push(new Date(from));
  }
  if (to)   {
    conds.push(`created_at <  $${i++}`);
    params.push(new Date(to));
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const sql = `
    SELECT
      id,
      ref_id        AS "refId",
      nome,
      tipo,
      valor_cents   AS "valorCents",
      created_at    AS "createdAt"
    FROM extratos
    ${where}
    ORDER BY created_at DESC
    LIMIT ${Math.min(parseInt(limit,10)||200, 1000)}
  `;
  const { rows } = await q(sql, params);
  res.json(rows);
});

app.get('/api/cupons', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM cupons ORDER BY created_at DESC'
    );
    res.json(rows.map(mapCupom));
  } catch (err) {
    next(err);
  }
});

app.post('/api/cupons', requireAuth, async (req, res, next) => {
  try {
    const codigoRaw = req.body.codigo;

    const valorBruto =
      req.body.valorCentavos ??
      req.body.valorCents ??
      req.body.valor_cents ??
      0;

    const valorCentavos = Number(valorBruto) | 0;
    const diasValidade  = Number(req.body.diasValidade || 3);
    const maxUsos       = Number(req.body.maxUsos || 1);

    if (!valorCentavos || valorCentavos <= 0) {
      return res.status(400).json({ error: 'Código e valor são obrigatórios.' });
    }

    let codigo = normalizarCodigo(codigoRaw);
    if (!codigo) {
      codigo = gerarCodigoCupom();
    }

    const expiraEm = req.body.expiraEm
      ? new Date(req.body.expiraEm)
      : new Date(Date.now() + diasValidade * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(
      `INSERT INTO cupons (codigo, valor_cents, expira_em, max_usos, ativo)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [codigo, valorCentavos, expiraEm, maxUsos]
    );

    const cupom = rows[0];
    sseSendAll('cupons-changed', { reason: 'create', id: cupom.id });

    res.status(201).json(mapCupom(cupom));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Já existe um cupom com esse código.' });
    }
    next(err);
  }
});

app.patch('/api/cupons/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const fields = [];
    const values = [];
    let idx = 1;

    if (req.body.valorCentavos != null ||
        req.body.valorCents    != null ||
        req.body.valor_cents   != null) {
      const v =
        req.body.valorCentavos ??
        req.body.valorCents ??
        req.body.valor_cents;
      fields.push(`valor_cents = $${idx++}`);
      values.push(Number(v));
    }
    if (req.body.ativo != null) {
      fields.push(`ativo = $${idx++}`);
      values.push(!!req.body.ativo);
    }
    if (req.body.expiraEm) {
      fields.push(`expira_em = $${idx++}`);
      values.push(new Date(req.body.expiraEm));
    }

    if (!fields.length) {
      return res.status(400).json({ error: 'Nada para atualizar.' });
    }

    values.push(id);

    const { rows } = await pool.query(
      `UPDATE cupons
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING *`,
      values
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }

    const cupom = rows[0];
    sseSendAll('cupons-changed', { reason: 'update', id: cupom.id });

    res.json(mapCupom(cupom));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/cupons/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      'DELETE FROM cupons WHERE id = $1',
      [id]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }
    sseSendAll('cupons-changed', { reason: 'delete', id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.post('/api/cupons/resgatar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const codigo   = normalizarCodigo(req.body.codigo);
    const nome     = String(req.body.nome || '').trim();
    const pixType  = String(req.body.pixType || '').trim() || null;
    const pixKey   = String(req.body.pixKey || '').trim() || null;
    const message  = req.body.message != null ? String(req.body.message) : null;

    if (!codigo || !nome || !pixKey || !pixType) {
      client.release();
      return res.status(400).json({ error: 'Dados obrigatórios ausentes.' });
    }

    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM cupons WHERE codigo = $1 FOR UPDATE',
      [codigo]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Cupom não encontrado.' });
    }

    const cupom = rows[0];

    if (!cupom.ativo) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'Cupom inativo.' });
    }

    const agora = new Date();
    if (cupom.expira_em && agora > cupom.expira_em) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'Cupom expirado.' });
    }

    if (cupom.usado_em) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({ error: 'Cupom já utilizado.' });
    }

    const valorCents = cupom.valor_cents;

    const bancaId = uid();

    await client.query(
      `INSERT INTO bancas (id, nome, deposito_cents, banca_cents, pix_key, pix_type, message, created_at)
       VALUES ($1, $2, $3, 0, $4, $5, $6, now())`,
      [bancaId, nome, valorCents, pixKey, pixType, message]
    );

    await client.query(
      `INSERT INTO extratos (id, ref_id, nome, tipo, valor_cents, created_at)
       VALUES ($1, $2, $3, 'deposito', $4, now())`,
      [uid(), bancaId, nome, valorCents]
    );

    await client.query(
      `UPDATE cupons
       SET usado_em = now(),
           ativo = false,
           usado_por_nome = $2,
           usado_por_pix_type = $3,
           usado_por_pix_key = $4,
           usado_por_message = $5
       WHERE id = $1`,
      [cupom.id, nome, pixType, pixKey, message]
    );

    await client.query('COMMIT');
    client.release();

    setTimeout(async () => {
      try {
        await pool.query('DELETE FROM cupons WHERE id = $1', [cupom.id]);
        sseSendAll('cupons-changed', { reason: 'auto-delete', id: cupom.id });
      } catch (err) {
        console.error('Erro ao apagar cupom após 5 minutos:', err);
      }
    }, 5 * 60 * 1000);

    sseSendAll('bancas-changed',  { reason: 'cupom-resgatado', bancaId });
    sseSendAll('extratos-changed',{ reason: 'cupom-resgatado' });
    sseSendAll('cupons-changed',  { reason: 'resgatado', id: cupom.id });

    res.json({
      ok: true,
      valorCentavos: valorCents,
      codigo: cupom.codigo
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    next(err);
  }
});

async function ensureMessageColumns(){
  try{
    await q(`alter table if exists bancas add column if not exists message text`);
    await q(`alter table if exists pagamentos add column if not exists message text`);
  }catch(e){
    console.error('ensureMessageColumns:', e.message);
  }
}

async function ensureCuponsTable(){
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS cupons (
        id BIGSERIAL PRIMARY KEY,
        codigo TEXT NOT NULL UNIQUE,
        valor_cents INTEGER NOT NULL,
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        max_usos INTEGER NOT NULL DEFAULT 1,
        usado_em TIMESTAMPTZ,
        expira_em TIMESTAMPTZ,
        usado_por_nome TEXT,
        usado_por_pix_type TEXT,
        usado_por_pix_key TEXT,
        usado_por_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  } catch (e) {
    console.error('ensureCuponsTable:', e.message);
  }
}

async function ensurePalpiteTables(){
  try{
    await q(`
      CREATE TABLE IF NOT EXISTS palpite_rounds (
        id TEXT PRIMARY KEY,
        is_open BOOLEAN NOT NULL DEFAULT false,
        buy_value_cents INTEGER NOT NULL DEFAULT 0,
        winners_count INTEGER NOT NULL DEFAULT 3,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at TIMESTAMPTZ
      )
    `);

    await q(`
      CREATE TABLE IF NOT EXISTS palpite_entries (
        id BIGSERIAL PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES palpite_rounds(id) ON DELETE CASCADE,
        user_name TEXT NOT NULL,
        guess_cents INTEGER NOT NULL,
        raw_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (round_id, user_name)
      )
    `);
  }catch(e){
    console.error('ensurePalpiteTables:', e.message);
  }
}

let twitchBot = { enabled: false, say: async () => {} };

app.listen(PORT, async () => {
  try{
    await q('select 1');
    await ensureMessageColumns();
    await ensureCuponsTable();

    await ensurePalpiteTables();
    await palpiteLoadFromDB();

    console.log('🗄️  Postgres conectado');
  } catch(e){
    console.error('❌ Postgres falhou:', e.message);
  }

  twitchBot = initTwitchBot({
    port: PORT,
    apiKey: APP_PUBLIC_KEY,
    botUsername: process.env.TWITCH_BOT_USERNAME,
    oauthToken: process.env.TWITCH_OAUTH_TOKEN,
    channel: process.env.TWITCH_CHANNEL,
    enabled: true,
    onLog: console,
  });

  console.log(`✅ Server rodando em ${ORIGIN} (NODE_ENV=${process.env.NODE_ENV||'dev'})`);
  console.log(`🗂  Servindo estáticos de: ${ROOT}`);
  console.log(`🔒 /area.html protegido por sessão; login em /login.html`);
});

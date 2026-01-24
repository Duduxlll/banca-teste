const express = require('express');
const router = express.Router();

const KEY = process.env.PALPITE_OVERLAY_KEY || '';
const clients = new Set();

const state = {
  isOpen: false,
  buyValue: 0,
  totalGuesses: 0,
  guesses: [],
  byUser: {},
  winners: [],
  actualResult: null,
};

function authed(req) {
  if (!KEY) return true;
  const k = req.query.key || req.get('x-palpite-key') || '';
  return k === KEY;
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    try { sseSend(res, event, data); } catch {}
  }
}

function publicState() {
  const last = state.guesses.slice(-30).reverse();
  return {
    isOpen: state.isOpen,
    buyValue: state.buyValue,
    totalGuesses: state.totalGuesses,
    lastGuesses: last,
    winners: state.winners,
    actualResult: state.actualResult,
  };
}

function cleanName(raw) {
  return String(raw || '')
    .trim()
    .slice(0, 28)
    .replace(/[^\p{L}\p{N}_ .-]/gu, '');
}

function parseMoney(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function resetRound(buyValue) {
  state.isOpen = true;
  state.buyValue = Number(buyValue || 0) || 0;
  state.totalGuesses = 0;
  state.guesses = [];
  state.byUser = {};
  state.winners = [];
  state.actualResult = null;
}

router.get('/stream', (req, res) => {
  if (!authed(req)) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseSend(res, 'state', publicState());

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

router.post('/start', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  resetRound(req.body?.buyValue);
  broadcast('start', { buyValue: state.buyValue });
  broadcast('state', publicState());
  res.json({ ok: true });
});

router.post('/stop', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  state.isOpen = false;
  broadcast('stop', {});
  broadcast('state', publicState());
  res.json({ ok: true });
});

router.post('/clear', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  state.isOpen = false;
  state.buyValue = 0;
  state.totalGuesses = 0;
  state.guesses = [];
  state.byUser = {};
  state.winners = [];
  state.actualResult = null;

  broadcast('clear', {});
  broadcast('state', publicState());
  res.json({ ok: true });
});

router.post('/guess', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!state.isOpen) return res.json({ ok: false, reason: 'round_closed' });

  const name = cleanName(req.body?.name);
  const value = parseMoney(req.body?.value);

  if (!name || value == null) return res.status(400).json({ error: 'bad_payload' });

  if (state.buyValue > 0 && value <= state.buyValue) {
    return res.json({ ok: false, reason: 'below_buy' });
  }

  const ts = Date.now();
  state.byUser[name] = { name, value, ts };

  state.guesses.push({ name, value, ts });
  if (state.guesses.length > 800) state.guesses.splice(0, state.guesses.length - 800);

  state.totalGuesses = Object.keys(state.byUser).length;

  broadcast('guess', { name, value, totalGuesses: state.totalGuesses });
  res.json({ ok: true });
});

router.post('/winners', (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  const actual = parseMoney(req.body?.actualResult);
  const count = Math.max(1, Math.min(3, Number(req.body?.winnersCount || 1)));

  if (actual == null) return res.status(400).json({ error: 'actualResult_required' });

  const list = Object.values(state.byUser);

  const sorted = list
    .map(g => ({ ...g, diff: Math.abs(g.value - actual) }))
    .sort((a, b) => a.diff - b.diff)
    .slice(0, count)
    .map(({ name, value }) => ({ name, value }));

  state.winners = sorted;
  state.actualResult = actual;

  broadcast('winners', { winners: sorted, actualResult: actual });
  broadcast('state', publicState());
  res.json({ ok: true, winners: sorted });
});

module.exports = router;

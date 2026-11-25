'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || '';
const MAP_ADMIN_KEY = process.env.MAP_ADMIN_KEY || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const STALE_AFTER_MS = 30_000;
const CHUNK_TTL_MS = 10 * 60_000;
const MAX_MAP_CHUNKS = 128;
const CHUNK_SIZE = 1800;

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let pool = null;
let mapExport = process.env.MAP_EXPORT || '';
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000
  });
  pool.on('error', (error) => {
    console.error('[mpkzakrzowice] Błąd połączenia z Neon:', error.message);
  });
}

const servers = new Map();
const pendingMapUploads = new Map();

function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  if (!keyMatches(req.get('x-api-key'), API_KEY)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid API key' });
  }
  next();
}

function requireMapAdmin(req, res, next) {
  if (!keyMatches(req.get('x-admin-key'), MAP_ADMIN_KEY)) {
    return res.status(401).json({ ok: false, error: 'Nieprawidłowy klucz administratora mapy.' });
  }
  next();
}

async function saveMapToDatabase(data) {
  if (!pool) throw new Error('DATABASE_URL nie jest skonfigurowany.');
  const result = await pool.query(
    `INSERT INTO mpkzakrzowice_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE
     SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
     RETURNING updated_at`,
    ['map_export', data]
  );
  mapExport = data;
  return result.rows[0]?.updated_at || new Date().toISOString();
}

async function initDatabase() {
  if (!pool) {
    console.warn('[mpkzakrzowice] Brak DATABASE_URL — trwały zapis mapy jest wyłączony.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mpkzakrzowice_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const result = await pool.query(
    'SELECT setting_value FROM mpkzakrzowice_settings WHERE setting_key = $1',
    ['map_export']
  );
  if (result.rowCount) {
    mapExport = result.rows[0].setting_value;
    console.log(`[mpkzakrzowice] Wczytano mapę z Neon (${mapExport.length} znaków).`);
  } else {
    console.log('[mpkzakrzowice] Neon działa; mapa nie została jeszcze zapisana.');
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'mpkzakrzowice-live',
    time: new Date().toISOString(),
    persistentStorageConfigured: Boolean(pool),
    mapSaved: Boolean(mapExport)
  });
});

app.get('/api/positions', (_req, res) => {
  const now = Date.now();
  const allBuses = [];
  let activeServers = 0;
  for (const [serverId, state] of servers.entries()) {
    if (now - state.receivedAt > STALE_AFTER_MS) {
      servers.delete(serverId);
      continue;
    }
    activeServers += 1;
    for (const bus of state.buses) allBuses.push({ ...bus, serverId, receivedAt: state.receivedAt });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ updatedAt: now, serverCount: activeServers, buses: allBuses });
});

app.post('/api/positions', requireApiKey, (req, res) => {
  const body = req.body || {};
  const serverId = typeof body.serverId === 'string' ? body.serverId.slice(0, 128) : '';
  if (!serverId) return res.status(400).json({ ok: false, error: 'Brak serverId.' });
  if (!Array.isArray(body.buses) || body.buses.length > 300) {
    return res.status(400).json({ ok: false, error: 'buses musi być tablicą (maks. 300 pojazdów).' });
  }
  const buses = [];
  for (const raw of body.buses) {
    if (!raw || typeof raw.id !== 'string' || !raw.id ||
        !Number.isFinite(raw.x) || !Number.isFinite(raw.z) || !Number.isFinite(raw.heading)) continue;
    buses.push({
      id: raw.id.slice(0, 128),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 100) : 'Autobus',
      line: typeof raw.line === 'string' ? raw.line.slice(0, 24) : '',
      x: raw.x,
      z: raw.z,
      heading: raw.heading
    });
  }
  servers.set(serverId, { receivedAt: Date.now(), buses });
  res.json({ ok: true, accepted: buses.length });
});

app.get('/api/map', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ data: mapExport, persistent: Boolean(pool) });
});

// Admin webpage can still save a complete OBRYSY export using MAP_ADMIN_KEY.
app.post('/api/map', requireMapAdmin, async (req, res) => {
  const data = req.body && req.body.data;
  if (typeof data !== 'string' || data.length > 2_000_000 || !data.includes('OBRYSY:')) {
    return res.status(400).json({ ok: false, error: 'Brak poprawnego eksportu OBRYSY:.' });
  }
  try {
    const savedAt = await saveMapToDatabase(data);
    res.json({ ok: true, chars: data.length, savedAt, persistent: true });
  } catch (error) {
    console.error('[mpkzakrzowice] Zapis mapy nie powiódł się:', error.message);
    res.status(500).json({ ok: false, error: 'Nie udało się zapisać mapy w Neon.' });
  }
});

// IMPORTANT FIX: this is the endpoint the Roblox importer actually calls.
// It accepts small base64url chunks, joins them in order, wraps them as OBRYSY lines,
// then writes the finished map to Neon. Authentication reuses the already-working API_KEY.
app.post('/api/map/import-chunk', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  const index = Number(body.index);
  const total = Number(body.total);
  const chunk = typeof body.chunk === 'string' ? body.chunk : '';

  if (!pool) return res.status(503).json({ ok: false, error: 'Brak DATABASE_URL — trwały zapis jest wyłączony.' });
  if (!uploadId || uploadId.length > 100 || !Number.isInteger(index) || !Number.isInteger(total) ||
      total < 1 || total > MAX_MAP_CHUNKS || index < 1 || index > total ||
      !chunk || chunk.length > CHUNK_SIZE || !/^[A-Za-z0-9_-]+$/.test(chunk)) {
    return res.status(400).json({ ok: false, error: 'Nieprawidłowe dane fragmentu mapy.' });
  }

  const now = Date.now();
  for (const [id, upload] of pendingMapUploads.entries()) {
    if (now - upload.startedAt > CHUNK_TTL_MS) pendingMapUploads.delete(id);
  }
  if (!pendingMapUploads.has(uploadId) && pendingMapUploads.size >= 3) {
    return res.status(429).json({ ok: false, error: 'Inny import mapy jest w toku. Spróbuj ponownie za chwilę.' });
  }

  let upload = pendingMapUploads.get(uploadId);
  if (!upload) {
    upload = { total, startedAt: now, chunks: new Map() };
    pendingMapUploads.set(uploadId, upload);
  }
  if (upload.total !== total) {
    pendingMapUploads.delete(uploadId);
    return res.status(400).json({ ok: false, error: 'Liczba fragmentów zmieniła się w trakcie importu.' });
  }
  upload.chunks.set(index, chunk);

  if (upload.chunks.size !== total) {
    return res.json({ ok: true, received: index, receivedCount: upload.chunks.size, total, complete: false });
  }

  const ordered = [];
  for (let i = 1; i <= total; i++) {
    const part = upload.chunks.get(i);
    if (typeof part !== 'string') {
      return res.status(400).json({ ok: false, error: `Brakuje fragmentu ${i}.` });
    }
    ordered.push(part);
  }
  const encoded = ordered.join('');
  pendingMapUploads.delete(uploadId);
  if (!encoded.length || encoded.length % 9 !== 0) {
    return res.status(400).json({ ok: false, error: 'Dane mapy są niekompletne (rekord powinien mieć 9 znaków).' });
  }

  const lines = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
    lines.push('OBRYSY: ' + encoded.slice(offset, offset + CHUNK_SIZE));
  }
  const data = lines.join('\n');
  try {
    const savedAt = await saveMapToDatabase(data);
    console.log(`[mpkzakrzowice] Import mapy zakończony: ${encoded.length / 9} części, ${encoded.length} znaków.`);
    res.json({ ok: true, complete: true, roads: encoded.length / 9, chars: encoded.length, savedAt, persistent: true });
  } catch (error) {
    console.error('[mpkzakrzowice] Import mapy — zapis do Neon nie powiódł się:', error.message);
    res.status(500).json({ ok: false, error: 'Nie udało się zapisać importowanej mapy do Neon.' });
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`mpkzakrzowice-live działa na porcie ${PORT}`);
      if (!API_KEY) console.warn('[mpkzakrzowice] Brak API_KEY.');
      if (!MAP_ADMIN_KEY) console.warn('[mpkzakrzowice] Brak MAP_ADMIN_KEY.');
    });
  })
  .catch((error) => {
    console.error('[mpkzakrzowice] Nie można uruchomić Neon:', error.message);
    process.exit(1);
  });

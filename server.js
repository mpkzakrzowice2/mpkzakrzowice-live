'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || '';
const MAP_ADMIN_KEY = process.env.MAP_ADMIN_KEY || '';
const STALE_AFTER_MS = 30_000;
const DATABASE_URL = process.env.DATABASE_URL || '';

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Neon Postgres stores the map permanently; Render's local filesystem is not used.
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
    console.error('[mpkzakrzowice] Błąd połączenia z bazą danych:', error.message);
  });
}

const servers = new Map();

function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
  if (!keyMatches(req.get('x-api-key'), API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized: invalid API key' });
  }
  next();
}

function requireMapAdmin(req, res, next) {
  if (!keyMatches(req.get('x-admin-key'), MAP_ADMIN_KEY)) {
    return res.status(401).json({ error: 'Nieprawidłowy klucz administratora mapy.' });
  }
  next();
}

async function initDatabase() {
  if (!pool) {
    console.warn('[mpkzakrzowice] Brak DATABASE_URL. Mapa może się wyświetlać z MAP_EXPORT, ale trwały zapis jest wyłączony.');
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
    'SELECT setting_value, updated_at FROM mpkzakrzowice_settings WHERE setting_key = $1',
    ['map_export']
  );
  if (result.rowCount > 0) {
    mapExport = result.rows[0].setting_value;
    console.log(`[mpkzakrzowice] Wczytano mapę z bazy (${mapExport.length} znaków).`);
  } else {
    console.log('[mpkzakrzowice] Baza działa, ale nie zapisano jeszcze mapy. Po zapisaniu mapa przetrwa restarty.');
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
    for (const bus of state.buses) {
      allBuses.push({ ...bus, serverId, receivedAt: state.receivedAt });
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({ updatedAt: now, serverCount: activeServers, buses: allBuses });
});

app.post('/api/positions', requireApiKey, (req, res) => {
  const body = req.body || {};
  const serverId = typeof body.serverId === 'string' ? body.serverId.slice(0, 128) : '';
  if (!serverId) return res.status(400).json({ error: 'Brak serverId.' });
  if (!Array.isArray(body.buses) || body.buses.length > 300) {
    return res.status(400).json({ error: 'buses musi być tablicą (maks. 300 pojazdów).' });
  }

  const buses = [];
  for (const raw of body.buses) {
    if (!raw || typeof raw.id !== 'string' || !raw.id ||
        !Number.isFinite(raw.x) || !Number.isFinite(raw.z) ||
        !Number.isFinite(raw.heading)) continue;
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

// One-time map import directly from Roblox, so the owner does not need to copy the large export text.
// The import is accepted only while no saved map exists; chunks are committed to Neon when complete.
const mapUploads = new Map();

app.post('/api/map/import-chunk', requireApiKey, async (req, res) => {
  const body = req.body || {};
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId.slice(0, 128) : '';
  const index = Number(body.index);
  const total = Number(body.total);
  const chunk = body.chunk;

  if (!uploadId || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 2000 || index < 1 || index > total) {
    return res.status(400).json({ error: 'Nieprawidłowe informacje o fragmencie importu.' });
  }
  if (typeof chunk !== 'string' || chunk.length > 1800 || !/^[A-Za-z0-9_-]+$/.test(chunk) || chunk.length % 9 !== 0) {
    return res.status(400).json({ error: 'Fragment eksportu jest nieprawidłowy.' });
  }
  if (!pool) {
    return res.status(503).json({ error: 'Trwały zapis nie jest skonfigurowany: brak DATABASE_URL.' });
  }

  // If a map is already saved, do not reupload it on every new game server start.
  if (mapExport && !mapUploads.has(uploadId)) {
    return res.json({ ok: true, skipped: true, reason: 'Mapa jest już zapisana w bazie.' });
  }

  let session = mapUploads.get(uploadId);
  if (!session) {
    session = { total, chunks: new Array(total), startedAt: Date.now() };
    mapUploads.set(uploadId, session);
  }
  if (session.total !== total) {
    mapUploads.delete(uploadId);
    return res.status(400).json({ error: 'Liczba fragmentów zmieniła się podczas importu.' });
  }
  session.chunks[index - 1] = chunk;
  session.updatedAt = Date.now();
  const received = session.chunks.filter((part) => typeof part === 'string').length;

  if (received < session.total) {
    return res.json({ ok: true, received, total: session.total, complete: false });
  }

  const joined = session.chunks.join('');
  if (!joined || joined.length % 9 !== 0) {
    mapUploads.delete(uploadId);
    return res.status(400).json({ error: 'Eksport jest niekompletny albo ma nieprawidłową długość.' });
  }
  const exportText = session.chunks.map((part) => `OBRYSY: ${part}`).join('\n');

  try {
    await pool.query(
      `INSERT INTO mpkzakrzowice_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      ['map_export', exportText]
    );
    mapExport = exportText;
    mapUploads.delete(uploadId);
    console.log(`[mpkzakrzowice] Zapisano mapę bezpośrednio z Roblox (${joined.length / 9} części, ${joined.length} znaków).`);
    return res.json({ ok: true, complete: true, roads: joined.length / 9, chars: joined.length, persistent: true });
  } catch (error) {
    console.error('[mpkzakrzowice] Import mapy z Roblox nie powiódł się:', error.message);
    return res.status(500).json({ error: 'Nie udało się zapisać mapy w Neon.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of mapUploads.entries()) {
    if (now - (session.updatedAt || session.startedAt) > 10 * 60 * 1000) mapUploads.delete(id);
  }
}, 60 * 1000).unref();

app.post('/api/map', requireMapAdmin, async (req, res) => {
  const data = req.body && req.body.data;
  if (typeof data !== 'string' || data.length > 2_000_000) {
    return res.status(400).json({ error: 'Brak danych mapy albo eksport jest za duży.' });
  }
  if (!data.includes('OBRYSY:')) {
    return res.status(400).json({ error: 'Eksport musi zawierać wiersze OBRYSY: z Roblox Studio.' });
  }
  if (!pool) {
    return res.status(503).json({ error: 'Trwały zapis nie jest skonfigurowany. Dodaj DATABASE_URL z Neon w Render → Environment.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO mpkzakrzowice_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
       RETURNING updated_at`,
      ['map_export', data]
    );
    mapExport = data;
    res.json({ ok: true, chars: data.length, savedAt: result.rows[0].updated_at, persistent: true });
  } catch (error) {
    console.error('[mpkzakrzowice] Nie udało się zapisać mapy do bazy:', error.message);
    res.status(500).json({ error: 'Nie udało się zapisać mapy w bazie Neon. Sprawdź DATABASE_URL w Render.' });
  }
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`mpkzakrzowice-live działa na porcie ${PORT}`);
      if (!API_KEY) console.warn('[mpkzakrzowice] Brak zmiennej API_KEY — endpoint przyjmujący autobusy pozostanie niedostępny.');
      if (!MAP_ADMIN_KEY) console.warn('[mpkzakrzowice] Brak zmiennej MAP_ADMIN_KEY — zapisywanie mapy pozostanie niedostępne.');
    });
  })
  .catch((error) => {
    console.error('[mpkzakrzowice] Nie można uruchomić bazy Neon:', error.message);
    process.exit(1);
  });

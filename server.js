'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || '';
const MAP_ADMIN_KEY = process.env.MAP_ADMIN_KEY || '';
const STALE_AFTER_MS = 30_000;

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// MVP storage is in memory. It lasts while this service instance runs.
// After a restart/redeploy, re-upload the road export in the map page.
let mapExport = process.env.MAP_EXPORT || '';
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mpkzakrzowice-live', time: new Date().toISOString() });
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
  res.json({ data: mapExport });
});

app.post('/api/map', requireMapAdmin, (req, res) => {
  const data = req.body && req.body.data;
  if (typeof data !== 'string' || data.length > 2_000_000) {
    return res.status(400).json({ error: 'Brak danych mapy albo eksport jest za duży.' });
  }
  if (!data.includes('OBRYSY:')) {
    return res.status(400).json({ error: 'Eksport musi zawierać wiersze OBRYSY: z Roblox Studio.' });
  }
  mapExport = data;
  res.json({ ok: true, chars: data.length });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`mpkzakrzowice-live działa na porcie ${PORT}`);
  if (!API_KEY) console.warn('Brak zmiennej API_KEY — endpoint przyjmujący autobusy pozostanie niedostępny.');
  if (!MAP_ADMIN_KEY) console.warn('Brak zmiennej MAP_ADMIN_KEY — zapisywanie mapy pozostanie niedostępne.');
});

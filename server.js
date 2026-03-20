const express      = require('express');
const qrcode       = require('qrcode');
const path         = require('path');
const os           = require('os');
const { randomBytes } = require('crypto'); // built-in de Node.js, sin instalar nada

const app  = express();
const PORT = process.env.PORT || 3000;

const EMOJIS = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
  '🦁','🐮','🐸','🐵','🐧','🐦','🦆','🦅','🦉','🦋',
  '🐺','🐗','🐴','🦄','🐝','🐞','🐬','🐙','🦈','🦒'
];
const TIMEOUT = 30000;

const rooms          = new Map(); // subnet → Map(deviceId → device)
const roomClips      = new Map(); // subnet → Map(id → clip)
const sseClients     = new Map(); // deviceId → res  ← solo para señalización WebRTC
const pendingSignals = new Map(); // deviceId → [{from,type,data,ts}] señales en espera

// Limpiar señales en espera viejas cada 60s
setInterval(() => {
  const cutoff = Date.now() - 30000;
  for (const [id, sigs] of pendingSignals.entries()) {
    const fresh = sigs.filter(s => s.ts > cutoff);
    if (fresh.length) pendingSignals.set(id, fresh);
    else pendingSignals.delete(id);
  }
}, 60000);

// ── Helpers ──
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const skip   = /virtual|vmware|vbox|hyper|vethernet|loopback|bluetooth|tunnel|tap|tun/i;
  const prefer = /wi.?fi|wlan|wireless/i;
  let fallback = null;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (skip.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (prefer.test(name)) return addr.address;
      if (!fallback) fallback = addr.address;
    }
  }
  return fallback || '127.0.0.1';
}

function getClientIP(req) {
  // Solo confiar en X-Forwarded-For si estamos en Railway (proxy conocido)
  // En local, cualquiera podría falsificar ese header
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.replace(/^::ffff:/, '');
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// Buscar un dispositivo en todos los rooms → devuelve { device, subnet } o null
function findDevice(deviceId) {
  for (const [subnet, room] of rooms.entries())
    if (room.has(deviceId)) return { device: room.get(deviceId), subnet };
  return null;
}

// Rate limiting simple sin dependencias externas
function rateLimit(max, windowMs) {
  const _rl = new Map(); // Map propio por endpoint — evita contaminación cruzada
  return (req, res, next) => {
    const key = getClientIP(req);
    const now = Date.now();
    const entry = _rl.get(key);
    if (!entry || now > entry.t) { _rl.set(key, { n: 1, t: now + windowMs }); return next(); }
    if (entry.n >= max) return res.status(429).json({ error: 'Demasiadas solicitudes' });
    entry.n++;
    next();
  };
}

function isPrivateIP(ip) {
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.'))      return true;
  if (ip.startsWith('172.')) {
    const n = parseInt(ip.split('.')[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

function clientSubnet(req) {
  const ip = getClientIP(req);
  if (ip === '127.0.0.1' || ip === '::1')
    return getLocalIP().split('.').slice(0, 3).join('.');
  if (isPrivateIP(ip))
    return ip.split('.').slice(0, 3).join('.');
  return ip; // IP pública: todos del mismo router comparten la misma
}

function getRoom(subnet) {
  if (!rooms.has(subnet)) rooms.set(subnet, new Map());
  return rooms.get(subnet);
}
function getRoomClips(subnet) {
  if (!roomClips.has(subnet)) roomClips.set(subnet, new Map());
  return roomClips.get(subnet);
}

// Limpiar dispositivos inactivos
setInterval(() => {
  const now = Date.now();
  for (const devMap of rooms.values())
    for (const [id, d] of devMap.entries())
      if (now - d.lastSeen > TIMEOUT) devMap.delete(id);
}, 10000);

app.use(express.json());

// Security headers básicos
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Dispositivos ──
app.post('/api/register', rateLimit(20, 60_000), (req, res) => {
  const subnet = clientSubnet(req);
  const room   = getRoom(subnet);
  const { deviceId: existing, token: existingToken } = req.body || {};

  // Re-registro: validar que el token coincida antes de renovar
  if (existing && room.has(existing)) {
    const d = room.get(existing);
    if (d.token !== existingToken) return res.status(403).json({ error: 'Token inválido' });
    d.lastSeen = Date.now();
    return res.json({ deviceId: existing, emoji: d.emoji, token: d.token });
  }

  const deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const token    = randomBytes(24).toString('hex'); // secreto único por dispositivo
  const used     = new Set([...room.values()].map(d => d.emoji));
  const pool     = EMOJIS.filter(e => !used.has(e));
  const emoji    = (pool.length ? pool : EMOJIS)[Math.floor(Math.random() * (pool.length || EMOJIS.length))];

  room.set(deviceId, { id: deviceId, emoji, token, subnet, lastSeen: Date.now() });
  res.json({ deviceId, emoji, token });
});

app.post('/api/heartbeat', (req, res) => {
  const subnet = clientSubnet(req);
  const { deviceId, token } = req.body || {};
  const d = getRoom(subnet).get(deviceId);
  if (d && d.token === token) d.lastSeen = Date.now();
  res.json({ ok: true }); // respuesta neutral para no filtrar si el ID existe
});

app.get('/api/devices', (req, res) => {
  const subnet = clientSubnet(req);
  const { me }  = req.query;
  const now     = Date.now();
  const list    = [...getRoom(subnet).values()]
    .filter(d => d.id !== me && now - d.lastSeen < TIMEOUT)
    .map(({ id, emoji }) => ({ id, emoji }));
  res.json(list);
});

// ── Señalización WebRTC (SSE) ──
// El servidor SOLO reenvía mensajes — nunca toca los archivos
app.get('/api/events', (req, res) => {
  const { deviceId, token } = req.query;

  // Validar que el dispositivo existe y el token es correcto
  const found = findDevice(deviceId);
  if (!found || found.device.token !== token) return res.status(403).end();

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.set(deviceId, res);

  // Entregar señales que llegaron antes de que este SSE estuviera listo
  const queued = pendingSignals.get(deviceId);
  if (queued) {
    const now = Date.now();
    for (const s of queued)
      if (now - s.ts < 30000)
        res.write(`data: ${JSON.stringify({ from: s.from, type: s.type, data: s.data })}\n\n`);
    pendingSignals.delete(deviceId);
  }

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(deviceId); });
});

app.post('/api/signal', rateLimit(60, 10_000), (req, res) => {
  const { to, from, token, type, data } = req.body;

  // 1. Verificar que el emisor existe y su token es válido
  const senderInfo = findDevice(from);
  if (!senderInfo || senderInfo.device.token !== token)
    return res.status(403).json({ error: 'No autorizado' });

  // 2. Verificar que el destino está en la MISMA red (mismo room)
  const targetRoom = getRoom(senderInfo.subnet);
  if (!targetRoom.has(to))
    return res.status(403).json({ error: 'Dispositivo fuera de tu red' });

  const target = sseClients.get(to);
  if (target) {
    target.write(`data: ${JSON.stringify({ from, type, data })}\n\n`);
  } else {
    // Receptor aún no tiene SSE activo — encolar para entregar cuando conecte
    if (!pendingSignals.has(to)) pendingSignals.set(to, []);
    pendingSignals.get(to).push({ from, type, data, ts: Date.now() });
  }
  res.json({ ok: !!target });
});

// ── Clips de texto ──
const MAX_CLIPS_PER_SUBNET = 100;

app.get('/api/clips', (req, res) => {
  const clips = getRoomClips(clientSubnet(req));
  res.json([...clips.values()].map(({ id, text, mtime }) => ({ id, text, mtime })));
});

app.post('/api/clips', rateLimit(30, 60_000), (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  if (text.length > 10000) return res.status(400).json({ error: 'Texto muy largo' });
  const clips = getRoomClips(clientSubnet(req));
  if (clips.size >= MAX_CLIPS_PER_SUBNET) return res.status(429).json({ error: 'Límite de clips alcanzado' });
  const id    = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  clips.set(id, { id, text, mtime: new Date() });
  res.json({ ok: true, id });
});

app.delete('/api/clips/:id', rateLimit(30, 60_000), (req, res) => {
  const clips = getRoomClips(clientSubnet(req));
  if (!clips.has(req.params.id)) return res.status(404).json({ error: 'Not found' });
  clips.delete(req.params.id);
  res.json({ ok: true });
});

// ── QR ──
app.get('/api/qr', async (req, res) => {
  const host  = process.env.RAILWAY_PUBLIC_DOMAIN || `${getLocalIP()}:${PORT}`;
  const proto = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  const url   = `${proto}://${host}`;
  const qr    = await qrcode.toDataURL(url);
  res.json({ url, qr });
});

app.listen(PORT, '0.0.0.0', () => {
  const ip     = getLocalIP();
  const subnet = ip.split('.').slice(0, 3).join('.');
  console.log('\n WiFi Share corriendo');
  console.log(` Red:    http://${ip}:${PORT}`);
  console.log(` Subred: ${subnet}.x`);
  console.log(' Archivos van P2P — servidor no guarda nada en RAM\n');
});

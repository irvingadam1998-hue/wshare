const express = require('express');
const qrcode  = require('qrcode');
const path    = require('path');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

const EMOJIS = [
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯',
  '🦁','🐮','🐸','🐵','🐧','🐦','🦆','🦅','🦉','🦋',
  '🐺','🐗','🐴','🦄','🐝','🐞','🐬','🐙','🦈','🦒'
];
const TIMEOUT = 30000;

const rooms      = new Map(); // subnet → Map(deviceId → device)
const roomClips  = new Map(); // subnet → Map(id → clip)
const sseClients = new Map(); // deviceId → res  ← solo para señalización WebRTC

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
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (forwarded || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
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
app.use(express.static(path.join(__dirname, 'public')));

// ── Dispositivos ──
app.post('/api/register', (req, res) => {
  const subnet = clientSubnet(req);
  const room   = getRoom(subnet);
  const { deviceId: existing } = req.body || {};

  if (existing && room.has(existing)) {
    const d = room.get(existing);
    d.lastSeen = Date.now();
    return res.json({ deviceId: existing, emoji: d.emoji });
  }

  const deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const used     = new Set([...room.values()].map(d => d.emoji));
  const pool     = EMOJIS.filter(e => !used.has(e));
  const emoji    = (pool.length ? pool : EMOJIS)[Math.floor(Math.random() * (pool.length || EMOJIS.length))];

  room.set(deviceId, { id: deviceId, emoji, subnet, lastSeen: Date.now() });
  res.json({ deviceId, emoji });
});

app.post('/api/heartbeat', (req, res) => {
  const subnet = clientSubnet(req);
  const { deviceId } = req.body || {};
  const d = getRoom(subnet).get(deviceId);
  if (d) d.lastSeen = Date.now();
  res.json({ ok: true });
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
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).end();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // evita buffering en proxies (Railway/nginx)
  res.flushHeaders();

  sseClients.set(deviceId, res);

  // Ping cada 25s para mantener viva la conexión en Railway
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(deviceId); });
});

app.post('/api/signal', (req, res) => {
  const { to, from, type, data } = req.body;
  const target = sseClients.get(to);
  if (target) target.write(`data: ${JSON.stringify({ from, type, data })}\n\n`);
  res.json({ ok: !!target });
});

// ── Clips de texto ──
app.get('/api/clips', (req, res) => {
  const clips = getRoomClips(clientSubnet(req));
  res.json([...clips.values()].map(({ id, text, mtime }) => ({ id, text, mtime })));
});

app.post('/api/clips', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  if (text.length > 10000) return res.status(400).json({ error: 'Texto muy largo' });
  const clips = getRoomClips(clientSubnet(req));
  const id    = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  clips.set(id, { id, text, mtime: new Date() });
  res.json({ ok: true, id });
});

app.delete('/api/clips/:id', (req, res) => {
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

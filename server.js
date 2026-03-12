const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Datos aislados por subred /24 ──
// Cada red WiFi tiene su propio espacio independiente
const networkFiles = new Map(); // subnet -> Map(name -> file)
const networkClips = new Map(); // subnet -> Map(id  -> clip)

function getFiles(subnet) {
  if (!networkFiles.has(subnet)) networkFiles.set(subnet, new Map());
  return networkFiles.get(subnet);
}
function getClips(subnet) {
  if (!networkClips.has(subnet)) networkClips.set(subnet, new Map());
  return networkClips.get(subnet);
}

// ── Subred del cliente (/24) ──
function clientSubnet(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return getLocalIP().split('.').slice(0, 3).join('.');
  return ip.split('.').slice(0, 3).join('.');
}

// ── IP WiFi local (para QR y consola) ──
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  const skip = /virtual|vmware|vbox|hyper|vethernet|loopback|bluetooth|tunnel|tap|tun/i;
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

app.use(express.static(path.join(__dirname, 'public')));

// ── Files ──

// List — solo los de tu red
app.get('/api/files', (req, res) => {
  const subnet = clientSubnet(req);
  const list = [...getFiles(subnet).values()].map(({ name, size, mtime }) => ({ name, size, mtime }));
  res.json(list);
});

// Upload — se guardan bajo tu subred
app.post('/api/upload', (req, res) => {
  upload.array('files')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'Archivo muy grande. Máximo 50 MB.' });
    if (err) return res.status(500).json({ error: err.message });

    const subnet = clientSubnet(req);
    const filesMap = getFiles(subnet);

    for (const f of req.files) {
      let name = f.originalname;
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let i = 1;
      while (filesMap.has(name)) name = `${base}(${i++})${ext}`;
      filesMap.set(name, { name, buffer: f.buffer, size: f.size, mtime: new Date() });
    }

    res.json({ ok: true, files: req.files.map(f => f.originalname) });
  });
});

// Download — solo puedes descargar archivos de tu red
app.get('/api/download/:filename', (req, res) => {
  const subnet = clientSubnet(req);
  const file = getFiles(subnet).get(req.params.filename);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(file.buffer);
});

// Delete — solo puedes borrar archivos de tu red
app.delete('/api/files/:filename', (req, res) => {
  const subnet = clientSubnet(req);
  const filesMap = getFiles(subnet);
  if (!filesMap.has(req.params.filename)) return res.status(404).json({ error: 'Not found' });
  filesMap.delete(req.params.filename);
  res.json({ ok: true });
});

// ── Text clips ──
app.use(express.json());

app.get('/api/clips', (req, res) => {
  const subnet = clientSubnet(req);
  res.json([...getClips(subnet).values()].map(({ id, text, mtime }) => ({ id, text, mtime })));
});

app.post('/api/clips', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  if (text.length > 10000) return res.status(400).json({ error: 'Texto muy largo (máx 10 000 caracteres)' });
  const subnet = clientSubnet(req);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  getClips(subnet).set(id, { id, text, mtime: new Date() });
  res.json({ ok: true, id });
});

app.delete('/api/clips/:id', (req, res) => {
  const subnet = clientSubnet(req);
  const clipsMap = getClips(subnet);
  if (!clipsMap.has(req.params.id)) return res.status(404).json({ error: 'Not found' });
  clipsMap.delete(req.params.id);
  res.json({ ok: true });
});

// ── QR ──
app.get('/api/qr', async (req, res) => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || `${getLocalIP()}:${PORT}`;
  const proto = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  const url = `${proto}://${host}`;
  const qr = await qrcode.toDataURL(url);
  res.json({ url, qr });
});

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n WiFi Share corriendo`);
  console.log(` Red:    http://${ip}:${PORT}`);
  console.log(` Cada red WiFi ve solo sus propios archivos.\n`);
});

const express = require('express');
const multer = require('multer');
const qrcode = require('qrcode');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Archivos en memoria — se pierden al reiniciar
const files = new Map(); // name -> { name, buffer, size, mtime }
const clips = new Map(); // id -> { id, text, mtime }

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Restricción de red local ──
function isLocalNetwork(clientIp) {
  // Solo omitir restricción si hay un dominio público de Railway explícito
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return true;

  const normalize = ip => ip.replace(/^::ffff:/, '');
  const client = normalize(clientIp || '');

  // Permitir loopback
  if (client === '127.0.0.1' || client === '::1') return true;

  const serverIp = getLocalIP();
  const sp = serverIp.split('.');
  const cp = client.split('.');

  if (cp.length !== 4) return false;

  // Misma subred /24
  return sp[0] === cp[0] && sp[1] === cp[1] && sp[2] === cp[2];
}

app.use((req, res, next) => {
  const clientIp = req.ip || req.socket.remoteAddress || '';
  if (!isLocalNetwork(clientIp)) {
    return res.status(403).send('Acceso permitido solo desde la red local WiFi.');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// List
app.get('/api/files', (req, res) => {
  const list = [...files.values()].map(({ name, size, mtime }) => ({ name, size, mtime }));
  res.json(list);
});

// Upload
app.post('/api/upload', (req, res) => {
  upload.array('files')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'Archivo muy grande. Máximo 50 MB.' });
    if (err) return res.status(500).json({ error: err.message });

    for (const f of req.files) {
      let name = f.originalname;
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let i = 1;
      while (files.has(name)) name = `${base}(${i++})${ext}`;
      files.set(name, { name, buffer: f.buffer, size: f.size, mtime: new Date() });
    }

    res.json({ ok: true, files: req.files.map(f => f.originalname) });
  });
});

// Download
app.get('/api/download/:filename', (req, res) => {
  const file = files.get(req.params.filename);
  if (!file) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(file.buffer);
});

// Delete
app.delete('/api/files/:filename', (req, res) => {
  if (!files.has(req.params.filename)) return res.status(404).json({ error: 'Not found' });
  files.delete(req.params.filename);
  res.json({ ok: true });
});

// Text clips
app.use(express.json());

app.get('/api/clips', (req, res) => {
  res.json([...clips.values()].map(({ id, text, mtime }) => ({ id, text, mtime })));
});


app.post('/api/clips', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Texto vacío' });
  if (text.length > 10000) return res.status(400).json({ error: 'Texto muy largo (máx 10 000 caracteres)' });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  clips.set(id, { id, text, mtime: new Date() });
  res.json({ ok: true, id });
});

app.delete('/api/clips/:id', (req, res) => {
  if (!clips.has(req.params.id)) return res.status(404).json({ error: 'Not found' });
  clips.delete(req.params.id);
  res.json({ ok: true });
});

// QR
app.get('/api/qr', async (req, res) => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    || process.env.HOST
    || `${getLocalIP()}:${PORT}`;
  const proto = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https' : 'http';
  const url = `${proto}://${host}`;
  const qr = await qrcode.toDataURL(url);
  res.json({ url, qr });
});

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n WiFi Share corriendo`);
  console.log(` Local:  http://localhost:${PORT}`);
  console.log(` Red:    http://${getLocalIP()}:${PORT}\n`);
});

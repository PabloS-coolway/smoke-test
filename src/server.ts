import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { stores, storeById } from './stores';
import { getRun, history, runStore } from './runner';
import { storage } from './storage';

const app = express();
const PORT = Number(process.env.PORT ?? 8080);
const PASSWORD = (process.env.SMOKE_PASSWORD ?? '').trim();

app.use(express.json());
// Capturas de cada ejecución, servidas desde el almacenamiento (disco o DO Spaces).
app.get('/runs/:runId/:file', async (req, res) => {
  const { runId, file } = req.params;
  if (!/^[a-z]+-\d+$/.test(runId) || !/^[a-z0-9-]+\.png$/.test(file)) {
    return res.status(400).end();
  }
  const img = await storage.getImage(`${runId}/${file}`);
  if (!img) return res.status(404).end();
  res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable').send(img);
});
// UI para Catalina.
app.use(express.static(path.resolve('public')));

/** Tiendas configuradas (para pintar los botones) + si hace falta contraseña. */
app.get('/api/stores', (_req, res) => {
  res.json({
    needsPassword: !!PASSWORD,
    stores: stores().map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl })),
  });
});

/** Historial de ejecuciones (resúmenes, más reciente primero). */
app.get('/api/history', async (_req, res) => {
  res.json(await history());
});

/** Informe completo de una ejecución pasada. */
app.get('/api/run/:runId', async (req, res) => {
  const r = await getRun(req.params.runId);
  if (!r) return res.status(404).json({ error: 'No existe esa ejecución.' });
  return res.json(r);
});

/** Lanza el smoke test de una tienda y devuelve el informe. */
app.post('/api/run', async (req, res) => {
  if (PASSWORD && req.header('x-smoke-password') !== PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  const id = String((req.body as { store?: string })?.store ?? '');
  const store = storeById(id);
  if (!store) return res.status(400).json({ error: `Tienda desconocida: "${id}".` });
  try {
    const result = await runStore(store);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(PORT, () => {
  const list = stores().map((s) => `${s.name} (${s.baseUrl})`).join(', ') || '(ninguna configurada)';
  console.log(`coolway-smoke escuchando en http://localhost:${PORT}`);
  console.log(`Tiendas: ${list}`);
  console.log(`Historial: ${storage.describe()}`);
});

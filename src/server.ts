import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { stores, storeById } from './stores';
import { runStore } from './runner';

const app = express();
const PORT = Number(process.env.PORT ?? 8080);
const PASSWORD = (process.env.SMOKE_PASSWORD ?? '').trim();

app.use(express.json());
// Capturas de cada ejecución.
app.use('/runs', express.static(path.resolve('runs')));
// UI para Catalina.
app.use(express.static(path.resolve('public')));

/** Tiendas configuradas (para pintar los botones) + si hace falta contraseña. */
app.get('/api/stores', (_req, res) => {
  res.json({
    needsPassword: !!PASSWORD,
    stores: stores().map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl })),
  });
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
});

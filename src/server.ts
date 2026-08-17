import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { stores, storeById } from './stores';
import { getRun, history, runStore } from './runner';
import { storage } from './storage';
import { authEnabled, clearSession, isAuthed, requireAuth, setSession, checkPassword } from './auth';

const app = express();
const PORT = Number(process.env.PORT ?? 8080);
app.set('trust proxy', 1); // detrás del proxy de DO (para cookies secure / req.secure)

app.use(express.json());

// --- Sesión / login (público) ----------------------------------------------
/** Estado de sesión: si hace falta login y si esta petición ya está autenticada. */
app.get('/api/session', (req, res) => {
  res.json({ needsLogin: authEnabled(), authed: isAuthed(req) });
});

/** Inicia sesión con la contraseña compartida; emite la cookie de sesión. */
app.post('/api/login', (req, res) => {
  const pass = String((req.body as { password?: string })?.password ?? '');
  if (!checkPassword(pass)) return res.status(401).json({ error: 'Contraseña incorrecta.' });
  setSession(res);
  res.json({ ok: true });
});

/** Cierra sesión. */
app.post('/api/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// --- A partir de aquí, todo exige sesión (si el login está activo) ----------
// Capturas de cada ejecución, servidas desde el almacenamiento (disco o DO Spaces).
app.get('/runs/:runId/:file', requireAuth, async (req, res) => {
  const { runId, file } = req.params;
  if (!/^[a-z]+-\d+$/.test(runId) || !/^[a-z0-9-]+\.png$/.test(file)) {
    return res.status(400).end();
  }
  const img = await storage.getImage(`${runId}/${file}`);
  if (!img) return res.status(404).end();
  res.type('png').set('Cache-Control', 'private, max-age=31536000, immutable').send(img);
});

/** Tiendas configuradas (para pintar los botones). */
app.get('/api/stores', requireAuth, (_req, res) => {
  res.json({
    needsPassword: authEnabled(),
    stores: stores().map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl })),
  });
});

/** Historial de ejecuciones (resúmenes, más reciente primero). */
app.get('/api/history', requireAuth, async (_req, res) => {
  res.json(await history());
});

/** Informe completo de una ejecución pasada. */
app.get('/api/run/:runId', requireAuth, async (req, res) => {
  const r = await getRun(req.params.runId);
  if (!r) return res.status(404).json({ error: 'No existe esa ejecución.' });
  return res.json(r);
});

/** Lanza el smoke test de una tienda y devuelve el informe. */
app.post('/api/run', requireAuth, async (req, res) => {
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

// La UI (estática) va al final; su JS pedirá /api/session y mostrará el login si hace falta.
app.use(express.static(path.resolve('public')));

app.listen(PORT, () => {
  const list = stores().map((s) => `${s.name} (${s.baseUrl})`).join(', ') || '(ninguna configurada)';
  console.log(`coolway-smoke escuchando en http://localhost:${PORT}`);
  console.log(`Tiendas: ${list}`);
  console.log(`Historial: ${storage.describe()}`);
  console.log(`Login: ${authEnabled() ? 'activado' : 'desactivado (abierto)'}`);
});

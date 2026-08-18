import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { stores, storeById } from './stores';
import { BLOCKS, CHIPS, SELECTORS, deleteRun, getRun, history, isBusy, jobStatus, runningJob, startRun } from './runner';
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
    blocks: BLOCKS,
    chips: CHIPS, // tests sueltos: [{ chip, value }]
    stores: stores().map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl })),
  });
});

/** Historial de ejecuciones (resúmenes, más reciente primero). */
app.get('/api/history', requireAuth, async (_req, res) => {
  res.json(await history());
});

/** Estado global: ¿hay una validación en curso? (para que la UI bloquee lanzar otra). */
app.get('/api/busy', requireAuth, (_req, res) => {
  const j = runningJob();
  res.json({ busy: !!j, storeName: j?.storeName ?? null, runId: j?.runId ?? null });
});

/** Estado de una corrida en curso (para el sondeo del cliente). */
app.get('/api/run/:runId/status', requireAuth, (req, res) => {
  const job = jobStatus(req.params.runId);
  if (!job) return res.json({ status: 'unknown' });
  return res.json({ status: job.status, error: job.error, storeName: job.storeName });
});

/** Informe completo de una ejecución pasada. */
app.get('/api/run/:runId', requireAuth, async (req, res) => {
  const r = await getRun(req.params.runId);
  if (!r) return res.status(404).json({ error: 'No existe esa ejecución.' });
  return res.json(r);
});

/** Borra una ejecución del historial (capturas + informe + fila). */
app.delete('/api/run/:runId', requireAuth, async (req, res) => {
  const ok = await deleteRun(req.params.runId);
  if (!ok) return res.status(400).json({ error: 'runId inválido.' });
  return res.json({ ok: true });
});

/**
 * Arranca el smoke test de una tienda y devuelve el `runId` AL INSTANTE (202). La validación corre en
 * segundo plano; el cliente sondea `/api/run/:runId/status` y, al acabar, pide el informe con
 * `/api/run/:runId`. Se hace así porque una corrida tarda más que el timeout de request de DO (~60 s).
 */
app.post('/api/run', requireAuth, (req, res) => {
  const body = (req.body ?? {}) as { store?: string; blocks?: string[] };
  const id = String(body.store ?? '');
  const store = storeById(id);
  if (!store) return res.status(400).json({ error: `Tienda desconocida: "${id}".` });
  if (isBusy()) {
    return res.status(409).json({ error: 'Ya hay una validación en curso. Espera a que termine.' });
  }
  const blocks = Array.isArray(body.blocks) ? body.blocks.filter((b) => SELECTORS.includes(b)) : undefined;
  const runId = startRun(store, blocks);
  return res.status(202).json({ runId, storeName: store.name });
});

// La UI (estática) va al final; su JS pedirá /api/session y mostrará el login si hace falta.
app.use(express.static(path.resolve('public')));

app.listen(PORT, () => {
  const list =
    stores()
      .map((s) => `${s.name} (${s.baseUrl})${s.proxy ? ' [proxy]' : ''}${s.sig && s.sigInput ? ' [web-bot-auth]' : ''}`)
      .join(', ') || '(ninguna configurada)';
  console.log(`coolway-smoke escuchando en http://localhost:${PORT}`);
  console.log(`Tiendas: ${list}`);
  console.log(`Historial: ${storage.describe()}`);
  console.log(`Login: ${authEnabled() ? 'activado' : 'desactivado (abierto)'}`);
});

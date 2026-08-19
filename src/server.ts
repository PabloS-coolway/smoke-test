import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { stores, storeById } from './stores';
import type { StoreConfig } from './stores';
import { BLOCKS, CHIPS, SELECTORS, deleteRun, getRun, history, isBusy, jobStatus, runningJob, startRun } from './runner';
import { reloadSchedule, scheduleSummary, startScheduler } from './scheduler';
import { getConfig, setConfig } from './config';
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

/** Comparativa entre tiendas: la última corrida COMPLETA de cada tienda, con el estado por check. */
app.get('/api/compare', requireAuth, async (_req, res) => {
  const hist = await history(); // más reciente primero
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const h of hist) {
    if (seen.has(h.store)) continue;
    const full = await getRun(h.runId);
    if (!full) continue;
    if (full.blocks && full.blocks.length) continue; // parcial: sigue buscando la última COMPLETA de esa tienda
    seen.add(h.store);
    type Cell = { ok: boolean; detail: string; group: string };
    const cks: Record<string, { d?: Cell; m?: Cell; g?: Cell }> = {};
    for (const it of full.items) {
      if (it.level !== 'check') continue;
      const vp = it.viewport === 'Móvil' ? 'm' : it.viewport === 'General' ? 'g' : 'd';
      (cks[it.label] ||= {})[vp] = { ok: it.ok, detail: it.detail, group: it.group };
    }
    out.push({
      store: full.storeName,
      runId: full.runId,
      startedAt: full.startedAt,
      durationMs: full.durationMs,
      passed: full.passed,
      total: full.total,
      ok: full.ok,
      perf: full.perf ?? null,
      checks: cks,
    });
  }
  res.json({ stores: out });
});

/**
 * Resumen (Home): estado agregado de todas las tiendas para el panel de KPIs, la rejilla por tienda
 * y la lista de «fallos a revisar». El estado de salud de cada tienda se toma de su última corrida
 * COMPLETA (una parcial de un chip no representa la salud); `lastAt` refleja la última actividad.
 */
app.get('/api/overview', requireAuth, async (_req, res) => {
  const hist = await history(); // más reciente primero
  const nowS = Date.now() / 1000;
  const STALE_DAYS = 7;
  const sigDaysLeft = (s: StoreConfig): number | null => {
    if (!s.sigInput) return null;
    const m = s.sigInput.match(/expires=(\d+)/);
    return m ? Math.floor((Number(m[1]) - nowS) / 86400) : null;
  };
  type Fail = { label: string; viewport: string; detail: string; group: string };
  const storesOut: Array<Record<string, unknown>> = [];
  const topFailures: Array<Record<string, unknown>> = [];
  for (const s of stores()) {
    const runs = hist.filter((h) => h.store === s.id);
    const last = runs[0] ?? null;
    const lastComplete = runs.find((h) => !(h.blocks && h.blocks.length)) ?? null;
    let verdict: 'ok' | 'fail' | 'none' = 'none';
    let passed = 0;
    let total = 0;
    let perf = null as null | { ttfbMs: number; loadMs: number };
    let runId: string | null = null;
    const failing: Fail[] = [];
    if (lastComplete) {
      verdict = lastComplete.ok ? 'ok' : 'fail';
      passed = lastComplete.passed;
      total = lastComplete.total;
      perf = lastComplete.perf ?? null;
      runId = lastComplete.runId;
      if (!lastComplete.ok) {
        const full = await getRun(lastComplete.runId);
        for (const it of full?.items ?? []) {
          if (it.level === 'check' && !it.ok) {
            const f: Fail = { label: it.label, viewport: it.viewport ?? '', detail: it.detail, group: it.group };
            failing.push(f);
            topFailures.push({ store: s.name, storeId: s.id, runId: lastComplete.runId, ...f });
          }
        }
      }
    }
    const daysLeft = sigDaysLeft(s);
    const ageDays = lastComplete ? (Date.now() - new Date(lastComplete.startedAt).getTime()) / 86400000 : Infinity;
    storesOut.push({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      verdict,
      passed,
      total,
      perf,
      runId,
      lastAt: last ? last.startedAt : null,
      lastCompleteAt: lastComplete ? lastComplete.startedAt : null,
      failing,
      stale: ageDays > STALE_DAYS,
      signatureDaysLeft: daysLeft,
    });
  }
  const withPerf = storesOut.filter((s) => s.perf) as Array<{ perf: { loadMs: number } }>;
  const kpis = {
    stores: storesOut.length,
    ok: storesOut.filter((s) => s.verdict === 'ok').length,
    failing: storesOut.filter((s) => s.verdict === 'fail').length,
    unvalidated: storesOut.filter((s) => s.verdict === 'none').length,
    stale: storesOut.filter((s) => s.stale && s.verdict !== 'none').length,
    expiringSignatures: storesOut.filter((s) => s.signatureDaysLeft !== null && (s.signatureDaysLeft as number) <= 21).length,
    avgLoadMs: withPerf.length ? Math.round(withPerf.reduce((a, s) => a + s.perf.loadMs, 0) / withPerf.length) : null,
  };
  res.json({ kpis, stores: storesOut, topFailures });
});

/** Avisos: firmas Web Bot Auth próximas a caducar (el `expires` va en el propio Signature-Input). */
app.get('/api/warnings', requireAuth, (_req, res) => {
  const nowS = Date.now() / 1000;
  const warnings: Array<{ kind: string; store: string; daysLeft: number; expiresAt: number }> = [];
  for (const s of stores()) {
    if (!s.sigInput) continue;
    const m = s.sigInput.match(/expires=(\d+)/);
    if (!m) continue;
    const exp = Number(m[1]);
    const daysLeft = Math.floor((exp - nowS) / 86400);
    if (daysLeft <= 21) warnings.push({ kind: 'signature', store: s.name, daysLeft, expiresAt: exp * 1000 });
  }
  res.json({ warnings });
});

/** Centro de notificaciones: firmas + corridas fallidas recientes. `count` = las NUEVAS (sin ver). */
app.get('/api/notifications', requireAuth, async (_req, res) => {
  const nowS = Date.now() / 1000;
  const cfg = await getConfig();
  const seenAt = cfg.alertsSeenAt || 0;
  const items: Array<Record<string, unknown>> = [];
  let count = 0;
  // Firmas Web Bot Auth: estado de cada una (las que caducan en ≤21 días piden atención).
  for (const s of stores()) {
    if (!s.sigInput) continue;
    const m = s.sigInput.match(/expires=(\d+)/);
    if (!m) continue;
    const daysLeft = Math.floor((Number(m[1]) - nowS) / 86400);
    const attention = daysLeft <= 21;
    if (attention) count++;
    items.push({ kind: 'signature', store: s.name, daysLeft, expiresAt: Number(m[1]) * 1000, attention });
  }
  // Corridas fallidas recientes (alerta en el propio panel, no solo Slack). Las nuevas suben el badge.
  const hist = await history();
  for (const h of hist.filter((x) => !x.ok).slice(0, 20)) {
    const isNew = new Date(h.startedAt).getTime() > seenAt;
    if (isNew) count++;
    items.push({ kind: 'failure', store: h.storeName, runId: h.runId, passed: h.passed, total: h.total, startedAt: h.startedAt, isNew });
  }
  res.json({ count, items });
});

/** Marca las alertas como vistas (limpia el badge). */
app.post('/api/notifications/seen', requireAuth, async (_req, res) => {
  await setConfig({ alertsSeenAt: Date.now() });
  res.json({ ok: true });
});

/** Config administrable (programación de corridas). */
app.get('/api/config', requireAuth, async (_req, res) => {
  const cfg = await getConfig();
  res.json({ ...cfg, summary: scheduleSummary(cfg), alertsOn: !!process.env.SLACK_WEBHOOK_URL });
});

app.post('/api/config', requireAuth, async (req, res) => {
  const b = (req.body ?? {}) as Partial<{ scheduleEnabled: boolean; scheduleTimes: string[]; scheduleDays: string; scheduleBlocks: string[] }>;
  const patch: Record<string, unknown> = {};
  if (typeof b.scheduleEnabled === 'boolean') patch.scheduleEnabled = b.scheduleEnabled;
  if (Array.isArray(b.scheduleTimes)) patch.scheduleTimes = b.scheduleTimes;
  if (b.scheduleDays === 'daily' || b.scheduleDays === 'weekdays') patch.scheduleDays = b.scheduleDays;
  if (Array.isArray(b.scheduleBlocks)) patch.scheduleBlocks = b.scheduleBlocks.filter((x) => SELECTORS.includes(x));
  const cfg = await setConfig(patch);
  await reloadSchedule(); // reprograma en caliente
  res.json({ ...cfg, summary: scheduleSummary(cfg), alertsOn: !!process.env.SLACK_WEBHOOK_URL });
});

/** Reinicia la referencia de regresión visual de una tienda: borra la baseline para que la próxima
 *  corrida capture una nueva (tras un rediseño intencionado). */
app.post('/api/baseline/reset', requireAuth, async (req, res) => {
  const id = String((req.body as { store?: string })?.store ?? '');
  const store = storeById(id);
  if (!store) return res.status(400).json({ error: `Tienda desconocida: "${id}".` });
  await storage.del(`baseline/${store.id}-home.png`);
  res.json({ ok: true });
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
  console.log(`Alertas: ${process.env.SLACK_WEBHOOK_URL ? 'Slack (webhook)' : 'desactivadas'}`);
  startScheduler();
});

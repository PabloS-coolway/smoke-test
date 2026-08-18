import { chromium } from 'playwright';
import { checks, discover, isChallenged } from './checks';
import { storage } from './storage';
import type { StoreConfig } from './stores';

export interface ResultItem {
  group: string;
  label: string;
  /** Descripción breve de qué comprueba este test (en lenguaje llano). */
  desc: string;
  ok: boolean;
  detail: string;
  shot: string | null; // ruta relativa a /runs, para servir la captura
  /** `check` cuenta para el veredicto; `info` es informativo (p. ej. errores JS) y no lo pinta rojo. */
  level: 'check' | 'info';
}

export interface RunResult {
  runId: string;
  store: string;
  storeName: string;
  baseUrl: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  total: number;
  ok: boolean;
  items: ResultItem[];
}

const INDEX = 'index.json';

/** Fila del historial (resumen de cada ejecución guardada). */
export interface RunSummary {
  runId: string;
  store: string;
  storeName: string;
  startedAt: string;
  durationMs: number;
  passed: number;
  total: number;
  ok: boolean;
}

/** Historial completo (más reciente primero). */
export async function history(): Promise<RunSummary[]> {
  return (await storage.getJson<RunSummary[]>(INDEX)) ?? [];
}

/** Informe completo de una ejecución pasada (por runId). */
export async function getRun(runId: string): Promise<RunResult | null> {
  if (!/^[a-z]+-\d+$/.test(runId)) return null; // evita traversal
  return storage.getJson<RunResult>(`${runId}/result.json`);
}

async function appendIndex(s: RunSummary): Promise<void> {
  const arr = await history();
  arr.unshift(s);
  await storage.putJson(INDEX, arr.slice(0, 200));
}

/**
 * Errores de JS conocidos y benignos (de librerías/terceros del tema) que NO deben pintar el test
 * en rojo. Se amplía según lo que aparezca en las tiendas reales. Solo fallan los NO listados.
 */
const IGNORE_JS = [
  'assignedNodes',
  'IntersectionObserver',
  "reading 'addEventListener'",
  'Failed to fetch', // fetch de trackers/terceros bloqueados en headless — benigno
];

/**
 * Registro de corridas en curso. Las validaciones tardan más de lo que aguanta el proxy de DO
 * (~60 s de timeout de request), así que NO se sirven de forma síncrona: se arrancan en segundo plano
 * y el cliente sondea el estado por `runId`. Además solo se permite UNA a la vez (Chromium en 1 GB
 * no soporta dos en paralelo).
 */
export type JobStatus = 'running' | 'done' | 'error';
export interface Job {
  runId: string;
  store: string;
  storeName: string;
  status: JobStatus;
  error?: string;
  startedAt: string;
}
const jobs = new Map<string, Job>();

/** La validación en curso ahora mismo, o null si no hay ninguna. */
export function runningJob(): Job | null {
  for (const j of jobs.values()) if (j.status === 'running') return j;
  return null;
}

/** ¿Hay alguna validación ejecutándose ahora mismo? */
export function isBusy(): boolean {
  return runningJob() !== null;
}

/** Estado de una corrida por id (null si no se conoce, p. ej. tras reiniciar el proceso). */
export function jobStatus(runId: string): Job | null {
  return jobs.get(runId) ?? null;
}

/** Arranca una validación en segundo plano y devuelve su runId al instante (no bloquea). */
export function startRun(store: StoreConfig): string {
  const runId = `${store.id}-${Date.now()}`;
  const job: Job = {
    runId,
    store: store.id,
    storeName: store.name,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  jobs.set(runId, job);
  void runStore(store, runId)
    .then(() => {
      job.status = 'done';
    })
    .catch((e) => {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
    });
  // Limpieza: no acumular jobs viejos en memoria indefinidamente.
  if (jobs.size > 50) {
    const oldest = [...jobs.values()].filter((j) => j.status !== 'running').slice(0, jobs.size - 50);
    for (const j of oldest) jobs.delete(j.runId);
  }
  return runId;
}

/** Cabecera secreta del monitor, de la env `MONITOR_HEADER` = "Nombre: valor". Vacío = ninguna. */
function monitorHeader(): Record<string, string> | null {
  const raw = (process.env.MONITOR_HEADER ?? '').trim();
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const name = raw.slice(0, i).trim();
  const value = raw.slice(i + 1).trim();
  return name && value ? { [name]: value } : null;
}

/** Parsea `http://usuario:clave@host:puerto` al formato de proxy de Playwright. */
function parseProxy(url?: string): { server: string; username?: string; password?: string } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const proxy: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    return undefined;
  }
}

/** Corre todos los checks contra una tienda y devuelve el informe (con capturas). */
export async function runStore(store: StoreConfig, runId = `${store.id}-${Date.now()}`): Promise<RunResult> {
  const started = Date.now();

  // Proxy por-tienda (opcional): enruta el navegador por una IP residencial del país de la tienda,
  // para las tiendas que bloquean con bot-challenge a IPs de datacenter (p. ej. la US).
  const proxy = parseProxy(store.proxy);
  const browser = await chromium.launch({ args: ['--no-sandbox'], ...(proxy ? { proxy } : {}) });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: store.lang,
    // Cabecera secreta del monitor (opcional): el dev puede añadir una excepción en la protección
    // anti-bot de las tiendas ("saltar challenge si llega esta cabecera") para que el monitor pase
    // sin proxy y sin depender de IPs. Formato env MONITOR_HEADER = "Nombre: valor".
    ...(monitorHeader() ? { extraHTTPHeaders: monitorHeader() as Record<string, string> } : {}),
  });
  const page = await context.newPage();

  const jsErrors: string[] = [];
  page.on('pageerror', (e) => {
    if (!IGNORE_JS.some((s) => e.message.includes(s))) jsErrors.push(e.message);
  });

  // Descubre una colección y un producto reales del tema una sola vez; los checks los reutilizan.
  const disco = await discover(page, store).catch(() => ({ collectionUrl: null, productUrl: null, prefix: '', how: 'error' }));

  // Ejecuta un check (con su captura) y devuelve el ResultItem. `idx` fija el nombre de la captura.
  const runCheck = async (check: (typeof checks)[number], idx: number): Promise<ResultItem> => {
    let ok = false;
    let detail = '';
    try {
      const r = await check.run({ page, store, disco });
      ok = r.ok;
      detail = r.detail;
    } catch (e) {
      ok = false;
      detail = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Si falló Y la tienda está sirviendo un challenge anti-bot a este servidor, NO es un fallo real:
    // no es verificable desde aquí. Se marca ámbar (info) para no dar un rojo falso.
    let level: ResultItem['level'] = 'check';
    if (!ok) {
      const challengeJs = jsErrors.some((e) => e.includes('<!DOCTYPE') || e.includes('is not valid JSON'));
      if ((await isChallenged(page).catch(() => false)) || challengeJs) {
        level = 'info';
        detail = `${detail} · bloqueo anti-bot: no verificable desde el servidor`;
      }
    }
    let shot: string | null = null;
    try {
      const file = `${idx}-${check.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      const png = await page.screenshot();
      await storage.putImage(`${runId}/${file}`, png);
      shot = `${runId}/${file}`;
    } catch {
      /* sin captura */
    }
    return { group: check.group, label: check.label, desc: check.desc, ok, detail, shot, level };
  };

  const items: ResultItem[] = [];
  for (let i = 0; i < checks.length; i++) {
    items.push(await runCheck(checks[i], i));
    // Pacing: separa las peticiones para no disparar el rate-limiting de la tienda en la ráfaga.
    await page.waitForTimeout(1200);
  }

  // Segunda pasada: reintenta SOLO los checks que fallaron, tras una pausa de enfriamiento. Las tiendas
  // throttlean las peticiones tardías de la ráfaga (dan resultados vacíos/challenge); el respiro deja que
  // el límite se resetee y evita falsos negativos. Se queda con el mejor resultado de las dos pasadas.
  const failedIdx = items.map((it, i) => (!it.ok && it.level === 'check' ? i : -1)).filter((i) => i >= 0);
  if (failedIdx.length > 0 && failedIdx.length < checks.length) {
    await page.waitForTimeout(10000);
    for (const i of failedIdx) {
      const retry = await runCheck(checks[i], i);
      if (retry.ok) items[i] = retry;
      await page.waitForTimeout(1500);
    }
  }

  // Informativo: errores de JS (no listados) capturados durante toda la ejecución. No cuenta para el
  // veredicto (las tiendas tienen errores benignos preexistentes); solo avisa si aparece algo nuevo.
  items.push({
    group: 'Región',
    label: 'Errores de JS en consola',
    desc: 'Recoge los errores de JavaScript aparecidos durante la validación (informativo, no tumba el test).',
    ok: jsErrors.length === 0,
    detail: jsErrors.length ? `${jsErrors.length}: ${jsErrors.slice(0, 3).join(' | ')}` : 'ninguno',
    shot: null,
    level: 'info',
  });

  await browser.close();

  // El veredicto se calcula solo sobre los checks (los `info` no lo tumban).
  const checkItems = items.filter((i) => i.level === 'check');
  const passed = checkItems.filter((i) => i.ok).length;
  const total = checkItems.length;
  const result: RunResult = {
    runId,
    store: store.id,
    storeName: store.name,
    baseUrl: store.baseUrl,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    passed,
    total,
    ok: passed === total,
    items,
  };
  await storage.putJson(`${runId}/result.json`, result);
  // Guarda el resumen en el historial (cada ejecución queda registrada).
  await appendIndex({
    runId,
    store: store.id,
    storeName: store.name,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    passed,
    total,
    ok: result.ok,
  });
  return result;
}

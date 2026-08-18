import { chromium, devices } from 'playwright';
import { checks, discover, isChallenged } from './checks';
import type { Discovery } from './checks';
import { storage } from './storage';
import type { StoreConfig } from './stores';

export interface ResultItem {
  group: string;
  label: string;
  /** Descripción breve de qué comprueba este test (en lenguaje llano). */
  desc: string;
  /** Vista en la que se ejecutó: "Escritorio" o "Móvil". */
  viewport?: string;
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

/**
 * Cabeceras a enviar en cada petición del navegador para esta tienda: la cabecera genérica del monitor
 * (si hay) + las de **Shopify Web Bot Auth** (si la tienda tiene firma), que la identifican como bot
 * autorizado. Vacío = ninguna (peticiones normales).
 */
function storeHeaders(store: StoreConfig): Record<string, string> | undefined {
  const h: Record<string, string> = { ...(monitorHeader() ?? {}) };
  if (store.sig && store.sigInput) {
    h['Signature'] = store.sig;
    h['Signature-Input'] = store.sigInput;
    h['Signature-Agent'] = '"https://shopify.com"';
  }
  return Object.keys(h).length ? h : undefined;
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
  const headers = storeHeaders(store);
  const browser = await chromium.launch({ args: ['--no-sandbox'], ...(proxy ? { proxy } : {}) });

  // Cada tienda se prueba en DOS vistas: Escritorio y Móvil (donde más se rompen los temas de Shopify).
  const viewports = [
    { id: 'desktop', name: 'Escritorio', mobile: false, opts: { viewport: { width: 1366, height: 900 } } },
    { id: 'mobile', name: 'Móvil', mobile: true, opts: { ...devices['iPhone 13'] } },
  ];

  const items: ResultItem[] = [];
  let disco: Discovery | null = null; // se descubre una vez (en escritorio) y se reutiliza en móvil

  for (const vp of viewports) {
    const context = await browser.newContext({
      ...vp.opts,
      locale: store.lang,
      // Cabeceras del monitor: Web Bot Auth de Shopify (bot autorizado) y/o cabecera secreta genérica.
      ...(headers ? { extraHTTPHeaders: headers } : {}),
    });
    const page = await context.newPage();

    const jsErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (!IGNORE_JS.some((s) => e.message.includes(s))) jsErrors.push(e.message);
    });

    // Descubre colección y producto reales del tema una sola vez (en escritorio); se reutilizan en móvil.
    if (!disco) {
      disco = await discover(page, store).catch(() => ({ collectionUrl: null, productUrl: null, prefix: '', how: 'error' }));
    }
    const disco_ = disco;

    // Ejecuta un check (con su captura) y devuelve el ResultItem. La captura lleva el id de vista + idx.
    const runCheck = async (check: (typeof checks)[number], idx: number): Promise<ResultItem> => {
      const jsBefore = jsErrors.length; // para detectar challenge SOLO durante este check
      let ok = false;
      let detail = '';
      try {
        const r = await check.run({ page, store, disco: disco_, mobile: vp.mobile });
        ok = r.ok;
        detail = r.detail;
      } catch (e) {
        ok = false;
        detail = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Si falló Y la tienda sirvió un challenge anti-bot EN ESTE check (página-challenge o un error de
      // fetch <!DOCTYPE nuevo durante el check), NO es un fallo real: no es verificable desde aquí →
      // ámbar (info), no rojo. Se acota al check para no sobre-marcar por un error suelto anterior.
      let level: ResultItem['level'] = 'check';
      if (!ok) {
        const newJs = jsErrors.slice(jsBefore);
        const challengeJs = newJs.some((e) => e.includes('<!DOCTYPE') || e.includes('is not valid JSON'));
        if ((await isChallenged(page).catch(() => false)) || challengeJs) {
          level = 'info';
          detail = `${detail} · bloqueo anti-bot: no verificable desde el servidor`;
        }
      }
      let shot: string | null = null;
      try {
        const file = `${vp.id}-${idx}-${check.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
        const png = await page.screenshot();
        await storage.putImage(`${runId}/${file}`, png);
        shot = `${runId}/${file}`;
      } catch {
        /* sin captura */
      }
      return { group: check.group, label: check.label, desc: check.desc, viewport: vp.name, ok, detail, shot, level };
    };

    const vpItems: ResultItem[] = [];
    for (let i = 0; i < checks.length; i++) {
      vpItems.push(await runCheck(checks[i], i));
      await page.waitForTimeout(500); // pacing corto (Web Bot Auth ya da rate limits altos)
    }

    // Segunda pasada: reintenta SOLO los checks que fallaron (de verdad, no los ámbar) tras enfriar.
    const failedIdx = vpItems.map((it, i) => (!it.ok && it.level === 'check' ? i : -1)).filter((i) => i >= 0);
    if (failedIdx.length > 0 && failedIdx.length < checks.length) {
      await page.waitForTimeout(5000);
      for (const i of failedIdx) {
        const retry = await runCheck(checks[i], i);
        if (retry.ok) vpItems[i] = retry;
        await page.waitForTimeout(800);
      }
    }

    // Informativo por vista: errores de JS de consola (no tumba el veredicto).
    vpItems.push({
      group: 'OTROS',
      label: 'Errores de JS en consola',
      desc: 'Recoge los errores de JavaScript aparecidos durante la validación (informativo, no tumba el test).',
      viewport: vp.name,
      ok: jsErrors.length === 0,
      detail: jsErrors.length ? `${jsErrors.length}: ${jsErrors.slice(0, 3).join(' | ')}` : 'ninguno',
      shot: null,
      level: 'info',
    });

    items.push(...vpItems);
    await context.close();
  }

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

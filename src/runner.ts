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
  /** Líneas de detalle desplegable (p. ej. la lista de enlaces revisados con su estado). */
  extra?: string[];
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
  /** Bloques ejecutados (si fue una corrida parcial); vacío/omitido = todos. */
  blocks?: string[];
  /** Rendimiento de la home (ms): TTFB (primer byte) y carga completa. */
  perf?: Perf;
  items: ResultItem[];
}

/** Métrica de rendimiento de la home. */
export interface Perf {
  ttfbMs: number;
  loadMs: number;
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
  /** Rendimiento de la home (para ver la evolución en el histórico). */
  perf?: Perf;
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

/** Borra una ejecución: sus capturas, su informe y su fila del historial. */
export async function deleteRun(runId: string): Promise<boolean> {
  if (!/^[a-z]+-\d+$/.test(runId)) return false;
  const result = await getRun(runId);
  if (result) {
    for (const it of result.items) if (it.shot) await storage.del(it.shot);
  }
  await storage.del(`${runId}/result.json`);
  const arr = await history();
  const filtered = arr.filter((r) => r.runId !== runId);
  await storage.putJson(INDEX, filtered);
  return true;
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

/** Bloques de checks disponibles (para correr solo uno). */
export const BLOCKS = ['HOME', 'COLECCIONES', 'PDP', 'OTROS'] as const;

/** Tests concretos que se pueden correr sueltos como chip ({chip: etiqueta corta, value: label del check}). */
export const CHIPS = checks
  .filter((c) => c.chip)
  .map((c) => ({ chip: c.chip as string, value: c.label }));

/** Todos los selectores válidos para `blocks` (grupos + labels de chip). */
export const SELECTORS: string[] = [...BLOCKS, ...CHIPS.map((c) => c.value)];

/** Arranca una validación en segundo plano y devuelve su runId al instante (no bloquea).
 *  `blocks` opcional limita a esos bloques (p. ej. solo HOME); vacío = todos. */
export function startRun(store: StoreConfig, blocks?: string[]): string {
  const runId = `${store.id}-${Date.now()}`;
  const job: Job = {
    runId,
    store: store.id,
    storeName: store.name,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  jobs.set(runId, job);
  void runStore(store, runId, blocks)
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

/**
 * Mide el rendimiento de la home: TTFB (latencia hasta el primer byte) y tiempo hasta "DOM listo"
 * (página usable). Se mide EN FRÍO (debe ser la primera navegación del contexto) para que el TTFB no
 * salga falseado por la caché. No espera a que carguen todas las imágenes/trackers (eso da minutos).
 */
async function measurePerf(page: import('playwright').Page, store: StoreConfig): Promise<Perf | null> {
  try {
    await page.goto(store.baseUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400); // deja que se rellene el timing
    return await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (!n) return null;
      const ttfb = Math.round(n.responseStart);
      const dcl = Math.round(n.domContentLoadedEventEnd || n.responseEnd);
      return { ttfbMs: ttfb > 0 ? ttfb : Math.round(n.responseEnd), loadMs: dcl };
    });
  } catch {
    return null;
  }
}

/** Corre los checks contra una tienda y devuelve el informe (con capturas). `blocks` limita a esos
 *  bloques (HOME/COLECCIONES/PDP/OTROS); vacío/omitido = todos. */
export async function runStore(store: StoreConfig, runId = `${store.id}-${Date.now()}`, blocks?: string[]): Promise<RunResult> {
  const started = Date.now();
  // `blocks` puede traer nombres de bloque (HOME…) o labels de un check concreto (chip suelto).
  const activeChecks =
    blocks && blocks.length ? checks.filter((c) => blocks.includes(c.group) || blocks.includes(c.label)) : checks;

  // Proxy por-tienda (opcional): enruta el navegador por una IP residencial del país de la tienda,
  // para las tiendas que bloquean con bot-challenge a IPs de datacenter (p. ej. la US).
  const proxy = parseProxy(store.proxy);
  const headers = storeHeaders(store);
  const browser = await chromium.launch({ args: ['--no-sandbox'], ...(proxy ? { proxy } : {}) });

  // Cada tienda se prueba en DOS vistas: Escritorio y Móvil (donde más se rompen los temas de Shopify).
  const viewports = [
    { id: 'desktop', name: 'Escritorio', mobile: false, opts: { viewport: { width: 1366, height: 900 } } },
    // Móvil: device Android **Chrome** (no iPhone/Safari): el UA debe cuadrar con el motor Chromium,
    // si no Cloudflare detecta un fingerprint incoherente (Safari-sobre-Chromium) y lo challengea.
    { id: 'mobile', name: 'Móvil', mobile: true, opts: { ...devices['Pixel 7'] } },
  ];

  const items: ResultItem[] = [];
  let disco: Discovery | null = null; // se descubre una vez (en escritorio) y se reutiliza en móvil
  let perf: Perf | null = null; // rendimiento de la home (se mide en escritorio)

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
      const msg = (e && (e.message || e.stack?.split('\n')[0])) || String(e);
      if (msg && !IGNORE_JS.some((s) => msg.includes(s))) jsErrors.push(msg);
    });

    // Rendimiento de la home: EN FRÍO (primera navegación del contexto) y solo en escritorio.
    if (vp.id === 'desktop' && (!blocks || !blocks.length || blocks.includes('HOME'))) {
      perf = await measurePerf(page, store);
    }

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
      let extra: string[] | undefined;
      try {
        const r = await check.run({ page, store, disco: disco_, mobile: vp.mobile });
        ok = r.ok;
        detail = r.detail;
        extra = r.extra;
      } catch (e) {
        ok = false;
        detail = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      // Métricas informativas (info) nunca cuentan para el veredicto. Si no, challenge anti-bot EN ESTE
      // check (página-challenge o error de fetch <!DOCTYPE nuevo) → ámbar, no rojo (acotado al check).
      let level: ResultItem['level'] = check.info ? 'info' : 'check';
      if (!ok && level === 'check') {
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
      return { group: check.group, label: check.label, desc: check.desc, viewport: vp.name, ok, detail, extra, shot, level };
    };

    // En móvil se saltan los checks `once` (no dependen de la vista: enlaces rotos, redirects, stock…).
    const vpChecks = vp.mobile ? activeChecks.filter((c) => !c.once) : activeChecks;

    const vpItems: ResultItem[] = [];
    for (let i = 0; i < vpChecks.length; i++) {
      vpItems.push(await runCheck(vpChecks[i], i));
      await page.waitForTimeout(500); // pacing corto (Web Bot Auth ya da rate limits altos)
    }

    // Segunda pasada: reintenta SOLO los checks que fallaron (de verdad, no los ámbar) tras enfriar.
    const failedIdx = vpItems.map((it, i) => (!it.ok && it.level === 'check' ? i : -1)).filter((i) => i >= 0);
    if (failedIdx.length > 0 && failedIdx.length < vpChecks.length) {
      await page.waitForTimeout(5000);
      for (const i of failedIdx) {
        const retry = await runCheck(vpChecks[i], i);
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
    blocks: blocks && blocks.length ? blocks : undefined,
    perf: perf ?? undefined,
    items,
  };
  await storage.putJson(`${runId}/result.json`, result);
  // Guarda el resumen en el historial (cada ejecución queda registrada, con el rendimiento).
  await appendIndex({
    runId,
    store: store.id,
    storeName: store.name,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    passed,
    total,
    ok: result.ok,
    perf: perf ?? undefined,
  });
  return result;
}

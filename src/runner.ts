import { chromium } from 'playwright';
import { checks } from './checks';
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

/** Corre todos los checks contra una tienda y devuelve el informe (con capturas). */
export async function runStore(store: StoreConfig): Promise<RunResult> {
  const runId = `${store.id}-${Date.now()}`;
  const started = Date.now();

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: store.lang,
  });
  const page = await context.newPage();

  const jsErrors: string[] = [];
  page.on('pageerror', (e) => {
    if (!IGNORE_JS.some((s) => e.message.includes(s))) jsErrors.push(e.message);
  });

  const items: ResultItem[] = [];
  for (const check of checks) {
    let ok = false;
    let detail = '';
    try {
      const r = await check.run({ page, store });
      ok = r.ok;
      detail = r.detail;
    } catch (e) {
      ok = false;
      detail = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    let shot: string | null = null;
    try {
      const file = `${items.length}-${check.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      const png = await page.screenshot();
      await storage.putImage(`${runId}/${file}`, png);
      shot = `${runId}/${file}`;
    } catch {
      /* sin captura */
    }
    items.push({ group: check.group, label: check.label, desc: check.desc, ok, detail, shot, level: 'check' });
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

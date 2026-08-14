import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checks } from './checks';
import type { StoreConfig } from './stores';

export interface ResultItem {
  group: string;
  label: string;
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

const RUNS_DIR = path.resolve('runs');

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
  const dir = path.join(RUNS_DIR, runId);
  await mkdir(dir, { recursive: true });
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
      await page.screenshot({ path: path.join(dir, file) });
      shot = `${runId}/${file}`;
    } catch {
      /* sin captura */
    }
    items.push({ group: check.group, label: check.label, ok, detail, shot, level: 'check' });
  }

  // Informativo: errores de JS (no listados) capturados durante toda la ejecución. No cuenta para el
  // veredicto (las tiendas tienen errores benignos preexistentes); solo avisa si aparece algo nuevo.
  items.push({
    group: 'Región',
    label: 'Errores de JS en consola',
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
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

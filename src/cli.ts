import 'dotenv/config';
import { stores } from './stores';
import { runStore } from './runner';

/**
 * Ejecución por terminal (sin UI), para automatizar post-deploy o CI.
 *   npm run cli          → todas las tiendas configuradas
 *   npm run cli -- eu     → solo EU
 * Sale con código 1 si alguna comprobación falla (útil para el pipeline).
 */
const arg = process.argv[2];
const targets = stores().filter((s) => !arg || s.id === arg);

if (targets.length === 0) {
  console.error('No hay tiendas configuradas (revisa STORE_EU_URL / STORE_US_URL), o el id no existe.');
  process.exit(2);
}

let failed = 0;
for (const store of targets) {
  const r = await runStore(store);
  console.log(`\n${r.ok ? '✓' : '✗'} ${r.storeName} — ${r.passed}/${r.total} (${(r.durationMs / 1000).toFixed(1)}s) · ${r.baseUrl}`);
  for (const i of r.items) console.log(`  ${i.ok ? '✓' : '✗'} [${i.group}] ${i.label} — ${i.detail}`);
  if (!r.ok) failed++;
}

process.exit(failed > 0 ? 1 : 0);

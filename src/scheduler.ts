import cron from 'node-cron';
import { stores } from './stores';
import { isBusy, startRun, waitForJob } from './runner';

/**
 * Corridas programadas: si `SCHEDULE_CRON` está definido (expresión cron), lanza una validación de
 * TODAS las tiendas en ese horario, encadenadas (una a una, respetando el candado de concurrencia).
 * Al fallar, cada corrida avisa por Slack si hay webhook (ver notify.ts). Zona horaria: `SCHEDULE_TZ`.
 * Ejemplos: "0 8 * * *" = cada día a las 08:00; "0 8,20 * * 1-5" = 08:00 y 20:00 de lunes a viernes.
 */
export function startScheduler(): void {
  const expr = (process.env.SCHEDULE_CRON ?? '').trim();
  const tz = (process.env.SCHEDULE_TZ ?? 'Europe/Madrid').trim();
  if (!expr) {
    console.log('Programación: desactivada (define SCHEDULE_CRON para activarla)');
    return;
  }
  if (!cron.validate(expr)) {
    console.log(`Programación: expresión cron inválida (${expr}) — desactivada`);
    return;
  }
  cron.schedule(expr, () => void runAllStores(), { timezone: tz });
  console.log(`Programación: "${expr}" (${tz})`);
}

let running = false;
async function runAllStores(): Promise<void> {
  if (running) return; // no solapar dos ciclos programados
  running = true;
  try {
    for (const store of stores()) {
      // Si hay una corrida manual en curso, espera un poco; si sigue ocupada, salta esta tienda.
      let waited = 0;
      while (isBusy() && waited < 24) {
        await new Promise((r) => setTimeout(r, 5000));
        waited++;
      }
      if (isBusy()) continue;
      const runId = startRun(store);
      await waitForJob(runId);
    }
  } finally {
    running = false;
  }
}

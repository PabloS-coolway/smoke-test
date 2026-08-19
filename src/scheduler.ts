import cron, { type ScheduledTask } from 'node-cron';
import { stores } from './stores';
import { isBusy, startRun, waitForJob } from './runner';
import { getConfig, type AppConfig } from './config';

/**
 * Corridas programadas ADMINISTRABLES desde la UI (la config vive en el storage, no en env).
 * Lanza una validación de TODAS las tiendas a las horas configuradas, encadenadas (respetando el
 * candado de concurrencia). Al fallar, cada corrida avisa por Slack si hay webhook (ver notify.ts).
 */
let tasks: ScheduledTask[] = [];

/** Traduce la config a expresiones cron y (re)programa las tareas. Se puede llamar en caliente. */
export async function reloadSchedule(): Promise<void> {
  for (const t of tasks) t.stop();
  tasks = [];
  const cfg = await getConfig();
  if (!cfg.scheduleEnabled) {
    console.log('Programación: desactivada');
    return;
  }
  const dayField = cfg.scheduleDays === 'weekdays' ? '1-5' : '*';
  for (const time of cfg.scheduleTimes) {
    const [h, m] = time.split(':');
    const expr = `${Number(m)} ${Number(h)} * * ${dayField}`;
    if (!cron.validate(expr)) continue;
    tasks.push(cron.schedule(expr, () => void runAllStores(), { timezone: cfg.tz }));
  }
  console.log(`Programación: ${cfg.scheduleTimes.join(', ')} (${cfg.scheduleDays}, ${cfg.tz})`);
}

export function startScheduler(): void {
  void reloadSchedule();
}

/** Descripción legible del estado actual (para la UI). */
export function scheduleSummary(cfg: AppConfig): string {
  if (!cfg.scheduleEnabled) return 'desactivadas';
  const dias = cfg.scheduleDays === 'weekdays' ? 'L-V' : 'todos los días';
  return `${dias} a las ${cfg.scheduleTimes.join(' y ')} (${cfg.tz})`;
}

let running = false;
async function runAllStores(): Promise<void> {
  if (running) return; // no solapar dos ciclos programados
  running = true;
  try {
    for (const store of stores()) {
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

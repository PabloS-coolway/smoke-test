import type { RunResult } from './runner';

/**
 * Avisos cuando una validación FALLA. Manda un mensaje a un webhook de Slack (env `SLACK_WEBHOOK_URL`).
 * Si no hay webhook configurado, no hace nada. Pensado sobre todo para las corridas programadas
 * (desatendidas), pero avisa de cualquier corrida fallida.
 */
export async function notifyRun(result: RunResult): Promise<void> {
  const url = (process.env.SLACK_WEBHOOK_URL ?? '').trim();
  if (!url || result.ok) return; // solo se avisa en fallo real

  const failed = result.items.filter((i) => i.level === 'check' && !i.ok);
  const base = (process.env.PUBLIC_URL ?? '').trim();
  const lines = failed
    .slice(0, 10)
    .map((i) => `• ${i.label}${i.viewport ? ` [${i.viewport}]` : ''}: ${i.detail}`)
    .join('\n');
  const text =
    `🔴 *${result.storeName}* falló ${result.passed}/${result.total}` +
    (result.blocks?.length ? ` (solo ${result.blocks.join(', ')})` : '') +
    `\n${lines}` +
    (base ? `\n${base}` : '');

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    /* si falla el aviso, no rompemos la corrida */
  }
}

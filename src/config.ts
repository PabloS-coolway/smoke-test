import { storage } from './storage';

/**
 * Configuración administrable desde la UI (persistida en el storage, sobrevive redeploys).
 * De momento: la programación de corridas automáticas.
 */
export interface AppConfig {
  scheduleEnabled: boolean;
  scheduleTimes: string[]; // horas "HH:MM" a las que correr (una o varias)
  scheduleDays: 'daily' | 'weekdays'; // todos los días o solo L-V
  tz: string; // zona horaria
}

const KEY = 'config.json';

const DEFAULT: AppConfig = {
  scheduleEnabled: false,
  scheduleTimes: ['08:00'],
  scheduleDays: 'daily',
  tz: (process.env.SCHEDULE_TZ ?? 'Europe/Madrid').trim() || 'Europe/Madrid',
};

let cache: AppConfig | null = null;

export async function getConfig(): Promise<AppConfig> {
  if (cache) return cache;
  const stored = await storage.getJson<Partial<AppConfig>>(KEY);
  cache = { ...DEFAULT, ...(stored ?? {}) };
  return cache;
}

export async function setConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const cur = await getConfig();
  const next: AppConfig = { ...cur, ...patch };
  // Saneado mínimo.
  next.scheduleTimes = (next.scheduleTimes || [])
    .map((t) => String(t).trim())
    .filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t))
    .slice(0, 6);
  if (!next.scheduleTimes.length) next.scheduleTimes = ['08:00'];
  if (next.scheduleDays !== 'weekdays') next.scheduleDays = 'daily';
  cache = next;
  await storage.putJson(KEY, next);
  return next;
}

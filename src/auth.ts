import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Login simple para que la herramienta no quede expuesta. Una sola contraseña compartida
 * (`SMOKE_PASSWORD`); al acertarla se emite una cookie de sesión firmada (HMAC-SHA256 con clave
 * derivada de la propia contraseña, así no hace falta otra env). Sin usuarios ni BD: es una utilidad
 * interna para el equipo.
 *
 * Si `SMOKE_PASSWORD` está vacío, el login queda DESACTIVADO (todo abierto) — pensado para desarrollo.
 */
const PASSWORD = (process.env.SMOKE_PASSWORD ?? '').trim();
const COOKIE = 'smoke_session';
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const signingKey = `coolway-smoke::${PASSWORD}`;

export const authEnabled = (): boolean => !!PASSWORD;

function sign(payload: string): string {
  return createHmac('sha256', signingKey).update(payload).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** ¿Coincide la contraseña? (comparación en tiempo constante). */
export function checkPassword(input?: string): boolean {
  if (!PASSWORD) return true;
  if (!input) return false;
  return safeEqual(input, PASSWORD);
}

/** Token de sesión: `<expira>.<firma>`. */
export function issueToken(): string {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function validToken(token?: string): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

function cookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** ¿La petición está autenticada? Vale cookie de sesión O cabecera `x-smoke-password` (CLI/curl). */
export function isAuthed(req: Request): boolean {
  if (!authEnabled()) return true;
  if (validToken(cookie(req, COOKIE))) return true;
  return checkPassword(req.header('x-smoke-password'));
}

export function setSession(res: Response): void {
  res.cookie(COOKIE, issueToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: TTL_MS,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

/** Middleware: exige sesión válida (o cabecera) cuando el login está activo. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'No autenticado.' });
}

/**
 * Devos CJ — enriquece el CSV mensual de ventas de CJ (afiliación) con dos columnas: DEVO (SI/NO) y MONTO
 * (total reembolsado), cruzando cada `Order ID` (= ID interno del pedido en Shopify) con la tienda de EUROPA.
 *
 * Reglas (Catalina, ago-2026): DEVO = SI si hay devolución iniciada o reembolso; MONTO = total reembolsado
 * (0 si aún nada); se mira hasta hoy (cubre la ventana de 60 días que da CJ).
 *
 * Credencial (variables de entorno, sólo lectura):
 *   SHOPIFY_EU_DOMAIN   coolway1.myshopify.com
 *   SHOPIFY_EU_TOKEN    token fijo (shpat_…) con read_orders + read_returns, O BIEN
 *   SHOPIFY_APP_CLIENT_ID + SHOPIFY_APP_CLIENT_SECRET   app de la organización (client credentials, token de 24 h)
 *   CJ_DEVOS_REFUNDS_JSON  (solo desarrollo) ruta a un JSON { "<orderId>": { returned, refunded } } en vez de Shopify
 */
import { readFile } from 'node:fs/promises';

export interface Devolucion { returned: boolean; refunded: number }
export interface Resultado {
  csv: string;
  pedidos: number;
  conDevolucion: number;
  importe: number;
  sinDatos: number;
  columnas: number;
}

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

export function credencialDisponible(): boolean {
  const e = process.env;
  return !!e.CJ_DEVOS_REFUNDS_JSON || (!!e.SHOPIFY_EU_DOMAIN && (!!e.SHOPIFY_EU_TOKEN || (!!e.SHOPIFY_APP_CLIENT_ID && !!e.SHOPIFY_APP_CLIENT_SECRET)));
}

/** CSV mínimo con comillas (campos con comas/comillas/saltos). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const csvEsc = (v: unknown): string => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCSV = (rows: string[][]): string => rows.map((r) => r.map(csvEsc).join(',')).join('\r\n') + '\r\n';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function tokenEU(): Promise<string> {
  const e = process.env;
  if (e.SHOPIFY_EU_TOKEN) return e.SHOPIFY_EU_TOKEN;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const r = await fetch(`https://${e.SHOPIFY_EU_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: e.SHOPIFY_APP_CLIENT_ID ?? '', client_secret: e.SHOPIFY_APP_CLIENT_SECRET ?? '' }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(/app_not_installed/.test(t) ? 'La app de Shopify no está instalada en Coolway EU (la instala el Owner de la organización).' : `Shopify no dio token (${r.status}).`);
  }
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 86_400) * 1000 };
  return j.access_token;
}

/** Reembolsos y devoluciones de una lista de IDs de pedido (lotes de 50). */
export async function devolucionesShopify(ids: string[]): Promise<Record<string, Devolucion>> {
  if (process.env.CJ_DEVOS_REFUNDS_JSON) return JSON.parse(await readFile(process.env.CJ_DEVOS_REFUNDS_JSON, 'utf8'));
  if (!credencialDisponible()) throw new Error('Falta la credencial de Shopify EU (SHOPIFY_EU_TOKEN o la app de la organización).');
  const token = await tokenEU();
  const QUERY = 'query($ids:[ID!]!){nodes(ids:$ids){... on Order{id totalRefundedSet{shopMoney{amount}} returns(first:1){nodes{id}}}}}';
  const map: Record<string, Devolucion> = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map((x) => `gid://shopify/Order/${x}`);
    const res = await fetch(`https://${process.env.SHOPIFY_EU_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query: QUERY, variables: { ids: batch } }),
    });
    const j = (await res.json().catch(() => ({}))) as { errors?: { message: string }[]; data?: { nodes: ({ id: string; totalRefundedSet?: { shopMoney?: { amount?: string } }; returns?: { nodes?: unknown[] } } | null)[] } };
    if (j.errors?.length) throw new Error(`Shopify: ${j.errors[0].message}`);
    for (const n of j.data?.nodes ?? []) {
      if (!n?.id) continue;
      map[n.id.split('/').pop() as string] = { returned: (n.returns?.nodes?.length ?? 0) > 0, refunded: Number(n.totalRefundedSet?.shopMoney?.amount ?? 0) };
    }
    if (i + 50 < ids.length) await new Promise((r) => setTimeout(r, 300));
  }
  return map;
}

/** Enriquece el CSV de CJ. `orderCol` = nombre de la columna del ID (por defecto "Order ID"). */
export async function enriquecerCSV(texto: string, orderCol = 'Order ID'): Promise<Resultado> {
  const rows = parseCSV(texto.replace(/^﻿/, ''));
  if (!rows.length) throw new Error('El CSV está vacío.');
  const header = rows[0];
  const idIdx = header.findIndex((h) => h.trim().toLowerCase() === orderCol.toLowerCase());
  if (idIdx < 0) throw new Error(`No encuentro la columna "${orderCol}". Columnas: ${header.join(' · ')}`);
  const data = rows.slice(1).filter((r) => r.length > 1 && (r[idIdx] ?? '').trim());
  const ids = [...new Set(data.map((r) => r[idIdx].trim()))];
  const devos = await devolucionesShopify(ids);
  const out: string[][] = [header.concat(['DEVO', 'MONTO'])];
  let conDevolucion = 0, sinDatos = 0, importe = 0;
  for (const r of data) {
    const info = devos[r[idIdx].trim()];
    let devo = 'NO', monto = '0';
    if (!info) { devo = '?'; sinDatos++; }
    else {
      const refunded = Number(info.refunded || 0);
      devo = info.returned || refunded > 0 ? 'SI' : 'NO';
      monto = refunded ? refunded.toFixed(2) : '0';
      if (devo === 'SI') { conDevolucion++; importe += refunded; }
    }
    out.push(r.concat([devo, monto]));
  }
  return { csv: toCSV(out), pedidos: data.length, conDevolucion, importe: Math.round(importe * 100) / 100, sinDatos, columnas: header.length + 2 };
}

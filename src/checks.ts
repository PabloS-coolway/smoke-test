import type { Locator, Page } from 'playwright';
import type { StoreConfig } from './stores';

/**
 * Los checks del smoke test. Cada uno es una comprobación independiente de una funcionalidad
 * crítica de la tienda. Devuelven `{ ok, detail }`; el runner añade la captura de pantalla.
 *
 * Son deliberadamente tolerantes: usan selectores estándar de Shopify (formulario /cart/add,
 * enlaces a /products/, API /cart.js) para que sigan valiendo aunque cambie el maquetado del tema.
 * Al correrlos por primera vez contra el DOM real puede que haya que afinar algún selector.
 */
export interface CheckCtx {
  page: Page;
  store: StoreConfig;
}
export interface Check {
  group: string;
  label: string;
  run: (c: CheckCtx) => Promise<{ ok: boolean; detail: string }>;
}

const GOTO = { timeout: 30000, waitUntil: 'domcontentloaded' as const };

/** Cierra popups (newsletter, cookies) que no deben tumbar el test. */
async function dismissPopups(page: Page): Promise<void> {
  const sels = [
    '[aria-label="Close"]',
    '[aria-label="Cerrar"]',
    'button:has-text("No, gracias")',
    'button:has-text("No thanks")',
    'button:has-text("Aceptar")',
    'button:has-text("Accept")',
    '.klaviyo-close-form',
  ];
  for (const sel of sels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 })) await el.click({ timeout: 800 });
    } catch {
      /* si no está, nada */
    }
  }
  try {
    await page.keyboard.press('Escape');
  } catch {
    /* nada */
  }
}

/** Navega con reintento: los blips de red transitorios (net::ERR_*) no deben tumbar un check. */
async function nav(page: Page, url: string) {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await page.goto(url, GOTO);
    } catch (e) {
      last = e;
      await page.waitForTimeout(1000);
    }
  }
  throw last;
}

/** Localiza el botón de añadir al carrito (formulario estándar de Shopify o por texto). */
async function findAddToCart(page: Page, store: StoreConfig): Promise<Locator | null> {
  const form = page
    .locator('form[action*="/cart/add"] button[type="submit"], form[action*="/cart/add"] [type="submit"]')
    .first();
  if (await form.count()) return form;
  for (const t of store.addToCart) {
    const b = page.getByRole('button', { name: new RegExp(t, 'i') }).first();
    if (await b.count()) return b;
  }
  return null;
}

/**
 * URL de un producto real. Usa la API estándar de Shopify (`/products.json`) para no depender del
 * maquetado; si falla, cae a los enlaces de la colección. Evita la gift-card (no tiene variantes al uso).
 * La página debe estar ya en el origen de la tienda (el fetch es relativo).
 */
async function firstProductUrl(page: Page, store: StoreConfig): Promise<string | null> {
  try {
    const handle = await page.evaluate(async () => {
      const r = await fetch('/products.json?limit=10', { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const j = (await r.json()) as { products?: Array<{ handle?: string }> };
      const list = (j.products ?? []).filter((p) => p.handle && p.handle !== 'gift-card');
      return (list[0] ?? j.products?.[0])?.handle ?? null;
    });
    if (handle) return `${store.baseUrl}/products/${handle}`;
  } catch {
    /* cae al fallback */
  }
  try {
    const href = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/products/"]'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h && !h.includes('/gift-card'));
      return links[0] ?? null;
    });
    if (href) return href.startsWith('http') ? href : `${store.baseUrl}${href}`;
  } catch {
    /* nada */
  }
  return null;
}

/** Nº de artículos en el carrito, vía la API estándar de Shopify (`/cart.js`). Robusto a temas. */
async function cartCount(page: Page): Promise<number> {
  try {
    return await page.evaluate(async () => {
      const r = await fetch('/cart.js', { headers: { accept: 'application/json' } });
      const j = (await r.json()) as { item_count?: number };
      return typeof j.item_count === 'number' ? j.item_count : 0;
    });
  } catch {
    return 0;
  }
}

export const checks: Check[] = [
  {
    group: 'Navegación',
    label: 'La home carga',
    run: async ({ page, store }) => {
      const resp = await nav(page, store.baseUrl);
      await dismissPopups(page);
      const status = resp?.status() ?? 0;
      const header = await page.locator('header, [role="banner"], .header, .site-header').first().count();
      return { ok: status < 400 && header > 0, detail: `HTTP ${status} · cabecera ${header ? 'presente' : 'ausente'}` };
    },
  },
  {
    group: 'Navegación',
    label: 'La colección carga con productos',
    run: async ({ page, store }) => {
      await nav(page, `${store.baseUrl}/collections/all`);
      await dismissPopups(page);
      const products = await page.locator('a[href*="/products/"]').count();
      return { ok: products > 0, detail: `${products} enlaces a producto` };
    },
  },
  {
    group: 'Navegación',
    label: 'El mega-menú abre',
    run: async ({ page, store }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      let links = 0;
      for (const label of store.navHover) {
        try {
          await page.getByText(label, { exact: true }).first().hover({ timeout: 3000 });
          await page.waitForTimeout(600);
          links = await page.locator('a[href*="/collections/"]:visible').count();
          if (links > 3) break;
        } catch {
          /* prueba la siguiente etiqueta */
        }
      }
      return { ok: links > 3, detail: links ? `${links} enlaces de submenú visibles` : 'no se detectó submenú' };
    },
  },
  {
    group: 'PDP + carrito',
    label: 'La ficha de producto carga',
    run: async ({ page, store }) => {
      await nav(page, `${store.baseUrl}/collections/all`);
      await dismissPopups(page);
      const url = await firstProductUrl(page, store);
      if (!url) return { ok: false, detail: 'no se encontró ningún producto' };
      await nav(page, url);
      await dismissPopups(page);
      const addBtn = await findAddToCart(page, store);
      return {
        ok: !!addBtn,
        detail: addBtn ? 'con botón de añadir al carrito' : `sin botón de añadir (${url.replace(store.baseUrl, '')})`,
      };
    },
  },
  {
    group: 'PDP + carrito',
    label: 'Añadir al carrito funciona',
    run: async ({ page, store }) => {
      let addBtn = await findAddToCart(page, store);
      if (!addBtn) {
        await nav(page, `${store.baseUrl}/collections/all`);
        await dismissPopups(page);
        const url = await firstProductUrl(page, store);
        if (url) {
          await nav(page, url);
          await dismissPopups(page);
          addBtn = await findAddToCart(page, store);
        }
      }
      const before = await cartCount(page);
      if (addBtn) await addBtn.click({ timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(1800);
      const after = await cartCount(page);
      return { ok: after > before, detail: `carrito ${before} → ${after}` };
    },
  },
  {
    group: 'PDP + carrito',
    label: 'El checkout es alcanzable',
    run: async ({ page, store }) => {
      // Con el producto en el carrito, la página /cart debe mostrar la línea y el botón de pago.
      // NO se coloca ningún pedido (no entramos al checkout externo).
      await nav(page, `${store.baseUrl}/cart`);
      await dismissPopups(page);
      const lineItems = await page.locator('a[href*="/products/"]').count();
      const checkoutBtn = await page
        .locator(
          '[name="checkout"], button[name="checkout"], a[href*="/checkout"], ' +
            'button:has-text("Finalizar"), button:has-text("Tramitar"), ' +
            'button:has-text("Checkout"), button:has-text("Pagar"), button:has-text("Pago")',
        )
        .count();
      return {
        ok: lineItems > 0 && checkoutBtn > 0,
        detail: `carrito con ${lineItems} artículo(s) · botón de pago ${checkoutBtn ? 'sí' : 'no'}`,
      };
    },
  },
  {
    group: 'Buscador',
    label: 'El buscador devuelve resultados',
    run: async ({ page, store }) => {
      await nav(page, `${store.baseUrl}/search?q=${encodeURIComponent(store.searchTerm)}`);
      await dismissPopups(page);
      const products = await page.locator('a[href*="/products/"]').count();
      return { ok: products > 0, detail: `"${store.searchTerm}" → ${products} resultados` };
    },
  },
  {
    group: 'Región',
    label: 'Moneda e idioma correctos',
    run: async ({ page, store }) => {
      const lang = (await page.locator('html').getAttribute('lang')) ?? '';
      const body = await page.locator('body').innerText().catch(() => '');
      const hasCurrency = body.includes(store.currency);
      const langOk = lang.toLowerCase().startsWith(store.lang);
      return {
        ok: hasCurrency && langOk,
        detail: `lang="${lang || '—'}" (esperado ${store.lang}*) · moneda ${store.currency} ${hasCurrency ? 'sí' : 'no'}`,
      };
    },
  },
];

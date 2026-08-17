import type { Locator, Page } from 'playwright';
import type { StoreConfig } from './stores';

/**
 * Los checks del smoke test. Cada uno comprueba una funcionalidad crítica del ESCAPARATE renderizado
 * (el tema), que es justo lo que se rompe al desplegar. Devuelven `{ ok, detail }`; el runner añade la
 * captura de pantalla.
 *
 * Principios (para que aguante las 12 tiendas sin tocar nada por tienda):
 *  - DESCUBRIR, no hardcodear: la colección y el producto a probar se descubren en runtime desde el
 *    propio tema (enlaces del DOM) con fallback a `/sitemap.xml`. Nada de rutas fijas tipo /collections/all.
 *  - INTERACTUAR POR EL TEMA, no por endpoints de scraper: el carrito se prueba clicando "añadir" y
 *    leyendo el contador del DOM — NO vía /cart.js ni /products.json, que algunas tiendas bloquean a
 *    IPs de datacenter. Así un solo datacenter valida todas las tiendas y además es más fiel al objetivo.
 */
export interface Discovery {
  collectionUrl: string | null;
  productUrl: string | null;
  prefix: string; // prefijo de locale/mercado descubierto (p. ej. "/es-eu"), o "" si no hay
  how: string; // cómo se descubrió (para el detalle/depuración)
}
export interface CheckCtx {
  page: Page;
  store: StoreConfig;
  disco: Discovery;
}
export interface Check {
  group: string;
  label: string;
  /** Descripción breve, en lenguaje llano, de qué comprueba este test (se muestra en el informe). */
  desc: string;
  run: (c: CheckCtx) => Promise<{ ok: boolean; detail: string }>;
}

const GOTO = { timeout: 30000, waitUntil: 'domcontentloaded' as const };

/** Convierte un href (relativo o absoluto) en URL absoluta del origen de la tienda. */
function abs(store: StoreConfig, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${store.baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
}

/** Cierra popups (cookies, newsletter, reseñas) que no deben tumbar el test ni tapar clics. */
async function dismissPopups(page: Page): Promise<void> {
  const sels = [
    'button:has-text("Reject")',
    'button:has-text("Rechazar")',
    'button:has-text("Accept")',
    'button:has-text("Aceptar")',
    'button:has-text("No, gracias")',
    'button:has-text("No thanks")',
    '[aria-label="Close"]',
    '[aria-label="Cerrar"]',
    '[aria-label="close"]',
    '.klaviyo-close-form',
    'button.needsclick[aria-label]',
  ];
  for (const sel of sels) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) await el.click({ timeout: 800, force: true });
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

/**
 * Cuenta elementos en una página tolerando cargas lentas (contenido que llega por JS): si sale 0,
 * espera un poco y vuelve a contar sobre la MISMA página. No recarga (evita amplificar peticiones y
 * provocar rate-limiting en la tienda).
 */
async function countResilient(page: Page, url: string, selector: string): Promise<number> {
  await nav(page, url);
  await dismissPopups(page);
  let n = await page.locator(selector).count();
  for (let i = 0; i < 2 && n === 0; i++) {
    await page.waitForTimeout(1500);
    n = await page.locator(selector).count();
  }
  return n;
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
 * Nº de artículos en el carrito leyendo el DOM del tema (badge/burbuja de la cabecera o el texto del
 * enlace "Cart [n]"). NO usa /cart.js (algunas tiendas lo bloquean a IPs de datacenter).
 */
async function cartCountDom(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const num = (s: string | null): number | null => {
        if (!s) return null;
        const m = s.match(/\d+/);
        return m ? parseInt(m[0], 10) : null;
      };
      const sels = [
        '[data-cart-count]',
        '[data-cart-item-count]',
        '.cart-count-bubble',
        '.cart-count',
        '#CartCount',
        '[id*="CartCount"]',
        '[class*="cart-count"]',
        '[class*="cart_count"]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el) {
          const n = num(el.getAttribute('data-cart-count') || el.getAttribute('data-cart-item-count') || el.textContent);
          if (n !== null) return n;
        }
      }
      // Fallback: texto del enlace al carrito, p. ej. "Cart [0]" / "Carrito (0)".
      const link = Array.from(document.querySelectorAll('a[href$="/cart"], a[href*="/cart?"], a[href*="/cart"]'))
        .map((a) => a.textContent || '')
        .join(' ');
      const m = link.match(/[[(](\d+)[\])]/) || link.match(/\b(\d+)\b/);
      return m ? parseInt(m[1], 10) : 0;
    });
  } catch {
    return 0;
  }
}

/** Nº de líneas de producto visibles en la página /cart (DOM). */
async function cartLineItems(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const sels = ['[data-line-item]', '.cart-item', '.cart__row', 'tr[id*="CartItem"]', '.line-item'];
      for (const s of sels) {
        const n = document.querySelectorAll(s).length;
        if (n > 0) return n;
      }
      // Fallback: enlaces a producto dentro del contenedor del carrito.
      const scope = document.querySelector('form[action*="/cart"], main, body');
      return scope ? scope.querySelectorAll('a[href*="/products/"]').length : 0;
    });
  } catch {
    return 0;
  }
}

/** Descubre una colección y un producto reales del tema (DOM primero, sitemap de respaldo). */
export async function discover(page: Page, store: StoreConfig): Promise<Discovery> {
  const d: Discovery = { collectionUrl: null, productUrl: null, prefix: '', how: '' };

  // 1) Colección: primer enlace a /collections/ del tema (evita "all"/"frontpage" y filtros con query).
  try {
    await nav(page, store.baseUrl);
    await dismissPopups(page);
    const col = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll('a[href*="/collections/"]'))
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => /\/collections\/[a-z0-9._-]+/i.test(h) && !h.includes('/products/'));
      const specific = hrefs.filter(
        (h) => !h.includes('?') && !/\/collections\/(all|frontpage)(\/|$|\?)/i.test(h),
      );
      return specific[0] || hrefs.find((h) => !h.includes('?')) || hrefs[0] || null;
    });
    if (col) {
      d.collectionUrl = abs(store, col);
      d.how = 'dom';
    }
  } catch {
    /* sigue */
  }

  // 2) Producto: primer enlace a /products/ en la colección (o en la home).
  try {
    if (d.collectionUrl) {
      await nav(page, d.collectionUrl);
      await dismissPopups(page);
    }
    const prod = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll('a[href*="/products/"]'))
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => h.includes('/products/') && !/gift-card/i.test(h));
      return hrefs[0] || null;
    });
    if (prod) d.productUrl = abs(store, prod);
  } catch {
    /* sigue */
  }

  // 3) Respaldo por sitemap si el DOM no dio colección o producto.
  if (!d.collectionUrl || !d.productUrl) {
    const sm = await fromSitemap(page);
    if (!d.collectionUrl && sm.collectionUrl) d.collectionUrl = sm.collectionUrl;
    if (!d.productUrl && sm.productUrl) d.productUrl = sm.productUrl;
    if (sm.collectionUrl || sm.productUrl) d.how = d.how ? `${d.how}+sitemap` : 'sitemap';
  }

  // Prefijo de locale/mercado: lo que va entre el origen y /collections|/products
  // (p. ej. "/es-eu"). Se usa para que /search y /cart apunten al mismo mercado.
  const ref = d.collectionUrl || d.productUrl;
  if (ref) {
    const path = ref.replace(store.baseUrl, '').replace(/^https?:\/\/[^/]+/, '');
    const m = path.match(/^(\/[a-z]{2}(?:-[a-z]{2})?)\/(?:collections|products)\//i);
    if (m) d.prefix = m[1];
  }

  return d;
}

/** Lee /sitemap.xml (estándar en todo Shopify, no bloqueado) para sacar una colección y un producto. */
async function fromSitemap(page: Page): Promise<{ collectionUrl: string | null; productUrl: string | null }> {
  try {
    return await page.evaluate(async () => {
      const get = (u: string) => fetch(u).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      const root = await get('/sitemap.xml');
      const locs = Array.from(root.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1].replace(/&amp;/g, '&'));
      const pick = async (needle: string, path: string): Promise<string | null> => {
        const sub = locs.find((l) => l.includes(needle));
        if (!sub) return null;
        const xml = await get(sub);
        const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1].replace(/&amp;/g, '&'));
        return urls.find((u) => u.includes(path) && !/gift-card/i.test(u)) || null;
      };
      return {
        collectionUrl: await pick('sitemap_collections', '/collections/'),
        productUrl: await pick('sitemap_products', '/products/'),
      };
    });
  } catch {
    return { collectionUrl: null, productUrl: null };
  }
}

export const checks: Check[] = [
  {
    group: 'Navegación',
    label: 'La home carga',
    desc: 'Abre la página de inicio de la tienda y confirma que responde correctamente y muestra la cabecera.',
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
    desc: 'Entra en una colección real de la tienda (descubierta del propio menú) y verifica que muestra productos.',
    run: async ({ page, store, disco }) => {
      if (!disco.collectionUrl) return { ok: false, detail: 'no se descubrió ninguna colección en el tema' };
      const products = await countResilient(page, disco.collectionUrl, 'a[href*="/products/"]');
      const path = disco.collectionUrl.replace(store.baseUrl, '');
      return { ok: products > 0, detail: `${path} · ${products} productos (${disco.how})` };
    },
  },
  {
    group: 'Navegación',
    label: 'El mega-menú abre',
    desc: 'Pasa el ratón por el menú principal y comprueba que se despliega mostrando más categorías.',
    run: async ({ page, store }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      const visibleCols = () => page.locator('a[href*="/collections/"]:visible').count();
      const baseline = await visibleCols();
      const targets: Locator[] = store.navHover.map((l) =>
        page.getByText(new RegExp(`^\\s*${l}\\s*$`, 'i')).first(),
      );
      const navItems = page.locator('header a, header summary, header button, nav a, nav summary');
      const n = Math.min(await navItems.count(), 6);
      for (let i = 0; i < n; i++) targets.push(navItems.nth(i));

      let best = baseline;
      for (const t of targets) {
        try {
          await t.hover({ timeout: 2000 });
          await page.waitForTimeout(450);
          best = Math.max(best, await visibleCols());
          if (best > baseline + 3) break;
        } catch {
          /* prueba el siguiente */
        }
      }
      const opened = best > baseline + 3;
      return { ok: opened, detail: opened ? `${best} enlaces de submenú visibles` : `no se detectó submenú (base ${baseline})` };
    },
  },
  {
    group: 'PDP + carrito',
    label: 'La ficha de producto carga',
    desc: 'Abre la página de un producto real y confirma que tiene su botón de añadir al carrito.',
    run: async ({ page, store, disco }) => {
      if (!disco.productUrl) return { ok: false, detail: 'no se descubrió ningún producto en el tema' };
      await nav(page, disco.productUrl);
      await dismissPopups(page);
      const addBtn = await findAddToCart(page, store);
      const path = disco.productUrl.replace(store.baseUrl, '');
      return { ok: !!addBtn, detail: addBtn ? `${path} · con botón de añadir` : `${path} · sin botón de añadir` };
    },
  },
  {
    group: 'PDP + carrito',
    label: 'Añadir al carrito funciona',
    desc: 'Pulsa «añadir al carrito» en la ficha y verifica que el contador del carrito aumenta.',
    run: async ({ page, store, disco }) => {
      if (!disco.productUrl) return { ok: false, detail: 'sin producto que probar (no descubierto)' };
      await nav(page, disco.productUrl);
      await dismissPopups(page);
      const before = await cartCountDom(page);
      const addBtn = await findAddToCart(page, store);
      if (!addBtn) return { ok: false, detail: 'no se encontró el botón de añadir' };
      await addBtn.click({ timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(2500); // deja que el drawer/badge se actualicen
      let after = await cartCountDom(page);
      // Fallback: si el badge no refleja el cambio, míralo en la página /cart.
      if (after <= before) {
        await nav(page, `${store.baseUrl}/cart`);
        await dismissPopups(page);
        after = await cartLineItems(page);
        return { ok: after > 0, detail: `badge ${before}→${await cartCountDom(page)} · /cart ${after} línea(s)` };
      }
      return { ok: after > before, detail: `carrito ${before} → ${after}` };
    },
  },
  {
    group: 'PDP + carrito',
    label: 'El checkout es alcanzable',
    desc: 'Abre el carrito y confirma que aparece la línea de producto y el botón de pago (sin llegar a comprar).',
    run: async ({ page, store, disco }) => {
      await nav(page, `${store.baseUrl}${disco.prefix}/cart`);
      await dismissPopups(page);
      let lines = await cartLineItems(page);
      if (lines === 0) {
        await page.waitForTimeout(1500);
        lines = await cartLineItems(page);
      }
      const checkoutBtn = await page
        .locator(
          '[name="checkout"], button[name="checkout"], a[href*="/checkout"], ' +
            'button:has-text("Finalizar"), button:has-text("Tramitar"), ' +
            'button:has-text("Checkout"), button:has-text("Pagar"), button:has-text("Pago")',
        )
        .count();
      return {
        ok: lines > 0 && checkoutBtn > 0,
        detail: `carrito con ${lines} línea(s) · botón de pago ${checkoutBtn ? 'sí' : 'no'}`,
      };
    },
  },
  {
    group: 'Buscador',
    label: 'El buscador devuelve resultados',
    desc: 'Busca un término habitual en la tienda y comprueba que devuelve productos.',
    run: async ({ page, store, disco }) => {
      const url = `${store.baseUrl}${disco.prefix}/search?q=${encodeURIComponent(store.searchTerm)}`;
      const products = await countResilient(page, url, 'a[href*="/products/"]');
      return { ok: products > 0, detail: `"${store.searchTerm}" → ${products} resultados` };
    },
  },
  {
    group: 'Región',
    label: 'Moneda e idioma correctos',
    desc: 'Comprueba que la tienda muestra el idioma y la moneda que corresponden a su país.',
    run: async ({ page, store, disco }) => {
      // Se comprueba en una página CON precios (ficha o colección), no en la que quedara de antes.
      const target = disco.productUrl || disco.collectionUrl || store.baseUrl;
      await nav(page, target);
      await dismissPopups(page);
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

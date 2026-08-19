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
  /** Si el check se está ejecutando en la vista móvil (para adaptar interacciones, p. ej. el menú). */
  mobile: boolean;
}
export interface Check {
  group: string;
  label: string;
  /** Descripción breve, en lenguaje llano, de qué comprueba este test (se muestra en el informe). */
  desc: string;
  /** Solo tiene sentido una vez (no depende de la vista): se corre solo en Escritorio, no en Móvil. */
  once?: boolean;
  /** Métrica informativa: se muestra pero NO cuenta para el veredicto (ámbar/neutro, nunca rojo). */
  info?: boolean;
  /** Si se define, este check aparece como un CHIP propio en «¿qué quieres probar?» (correr solo él). */
  chip?: string;
  run: (c: CheckCtx) => Promise<{ ok: boolean; detail: string; extra?: string[] }>;
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

/**
 * ¿La página actual es una página-challenge anti-bot (Cloudflare/captcha/etc.) en vez del contenido
 * real? Algunas tiendas la sirven a IPs de datacenter en las peticiones profundas. Si es así, el check
 * no es un FALLO real de la tienda: es que no se puede verificar desde este servidor (se marca ámbar).
 */
export async function isChallenged(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // 1) Elementos del challenge de Cloudflare/captcha (robusto aunque el texto esté en un iframe).
      if (
        document.querySelector(
          'script[src*="challenges.cloudflare.com"], iframe[src*="challenges.cloudflare.com"], ' +
            'iframe[src*="challenge"], iframe[src*="turnstile"], iframe[src*="captcha"], ' +
            '.cf-turnstile, [id^="cf-chl"], #challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running',
        )
      ) {
        return true;
      }
      // 2) Texto de la página (inglés y español).
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').toLowerCase().slice(0, 4000);
      const hay = (s: string) => t.includes(s) || b.includes(s);
      if (hay('checking your browser') || hay('just a moment') || hay('attention required') || hay('un momento')) return true;
      if (hay('verify you are human') || hay('verifying you are human') || hay('enable javascript and cookies')) return true;
      if (hay('captcha') || hay('cf-challenge') || hay('access denied') || hay('acceso denegado') || hay('ray id')) return true;
      if (hay('verificar tu conexión') || hay('verificando') || hay('comprobando') || hay('cloudflare')) return true;
      if (hay('revisar la seguridad') || hay('espera mientras')) return true;
      return false;
    });
  } catch {
    return false;
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

/** Nº de PRODUCTOS ÚNICOS en la página (por handle), no de enlaces: cada ficha tiene varios enlaces
 *  al mismo producto (imagen, título, swatches…), así que contar enlaces infla el número. */
async function uniqueProducts(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const handles = new Set<string>();
      document.querySelectorAll('a[href*="/products/"]').forEach((a) => {
        const m = (a.getAttribute('href') || '').match(/\/products\/([a-z0-9._-]+)/i);
        if (m && m[1] !== 'gift-card') handles.add(m[1].toLowerCase());
      });
      return handles.size;
    });
  } catch {
    return 0;
  }
}

/** Navega y cuenta productos únicos, con espera-y-recuenta si sale 0 (contenido cargado por JS). */
async function countProducts(page: Page, url: string): Promise<number> {
  await nav(page, url);
  await dismissPopups(page);
  let n = await uniqueProducts(page);
  for (let i = 0; i < 2 && n === 0; i++) {
    await page.waitForTimeout(1500);
    n = await uniqueProducts(page);
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
    group: 'HOME',
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
    group: 'COLECCIONES',
    label: 'La colección carga con productos',
    desc: 'Entra en una colección real de la tienda (descubierta del propio menú) y verifica que muestra productos.',
    run: async ({ page, store, disco }) => {
      if (!disco.collectionUrl) return { ok: false, detail: 'no se descubrió ninguna colección en el tema' };
      const products = await countProducts(page, disco.collectionUrl);
      const path = disco.collectionUrl.replace(store.baseUrl, '');
      return { ok: products > 0, detail: `${path} · ${products} productos (${disco.how})` };
    },
  },
  {
    group: 'HOME',
    label: 'Sin imágenes rotas',
    desc: 'Comprueba que las imágenes de la home cargan (ninguna aparece rota). Se revisa en cada vista.',
    chip: 'Imágenes',
    run: async ({ page, store }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      // Dispara la carga perezosa: baja hasta el final y vuelve arriba.
      await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((r) => setTimeout(r, 1200));
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 300));
      });
      const r = await page.evaluate(() => {
        const imgs = Array.from(document.images).filter((im) => im.currentSrc || im.src);
        // Rota = terminó de cargar (complete) pero sin dimensiones (naturalWidth 0).
        const broken = imgs.filter((im) => im.complete && im.naturalWidth === 0);
        const clean = (u: string) => (u || '').split('?')[0].replace(location.origin, '');
        const list = Array.from(new Set(broken.map((im) => clean(im.currentSrc || im.src))));
        return { checked: imgs.length, broken: list.slice(0, 50) };
      });
      const ok = r.broken.length === 0;
      return {
        ok,
        detail: `${r.checked} imágenes · ${r.broken.length} rota(s)${r.broken.length ? ': ' + r.broken.slice(0, 2).join(', ') : ''}`,
        extra: r.broken.length ? r.broken.map((x) => '✗ ' + x) : undefined,
      };
    },
  },
  {
    group: 'HOME',
    label: 'El menú funciona',
    desc: 'Comprueba que el menú de la cabecera tiene categorías; e intenta desplegarlo (hover en escritorio, hamburguesa en móvil).',
    run: async ({ page, store, mobile }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      // Lo esencial (y lo que se rompe al desplegar): la cabecera tiene enlaces a categorías.
      const headerLinks = await page
        .locator('header a[href*="/collections/"], [role="banner"] a[href*="/collections/"], nav a[href*="/collections/"]')
        .count();

      // Señal extra (no obligatoria): que además se despliegue al interactuar.
      const visibleCols = () => page.locator('a[href*="/collections/"]:visible').count();
      const base = await visibleCols();
      let opened = false;
      try {
        if (mobile) {
          const toggles = [
            'button[aria-label*="menu" i]',
            'button[aria-label*="menú" i]',
            'button[aria-controls*="menu" i]',
            'summary[aria-haspopup]',
            '.header__icon--menu',
            '.mobile-nav-toggle',
            'button.js-mobile-nav-toggle',
            'header button:has(svg)',
            'header summary',
          ];
          for (const sel of toggles) {
            const b = page.locator(sel).first();
            if (await b.isVisible({ timeout: 400 }).catch(() => false)) {
              await b.click({ timeout: 1200 }).catch(() => undefined);
              await page.waitForTimeout(500);
              if ((await visibleCols()) > base + 2) { opened = true; break; }
            }
          }
        } else {
          for (const l of store.navHover) {
            const t = page.getByText(new RegExp(`^\\s*${l}\\s*$`, 'i')).first();
            try {
              await t.hover({ timeout: 1500 });
              await page.waitForTimeout(400);
              if ((await visibleCols()) > base + 3) { opened = true; break; }
            } catch {
              /* siguiente */
            }
          }
        }
      } catch {
        /* el despliegue es opcional */
      }

      const ok = headerLinks >= 2 || opened;
      return {
        ok,
        detail: `${headerLinks} categorías en el menú${opened ? ' · se despliega' : ''}`,
      };
    },
  },
  {
    group: 'PDP',
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
    group: 'PDP',
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
    group: 'OTROS',
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
      const checkoutSel =
        '[name="checkout"], button[name="checkout"], input[name="checkout"], [id*="checkout" i], ' +
        'a[href*="/checkout"], a[href*="/checkouts/"], ' +
        'button:has-text("Finalizar"), button:has-text("Tramitar"), button:has-text("Comprar"), ' +
        'button:has-text("Checkout"), button:has-text("Check out"), button:has-text("Pagar"), button:has-text("Pago")';
      let checkoutBtn = await page.locator(checkoutSel).count();
      if (checkoutBtn === 0) {
        await page.waitForTimeout(1200); // en móvil el botón (sticky) puede aparecer algo después
        checkoutBtn = await page.locator(checkoutSel).count();
      }
      return {
        ok: lines > 0 && checkoutBtn > 0,
        detail: `carrito con ${lines} línea(s) · botón de pago ${checkoutBtn ? 'sí' : 'no'}`,
      };
    },
  },
  {
    group: 'OTROS',
    label: 'El buscador devuelve resultados',
    desc: 'Busca un término habitual en la tienda y comprueba que devuelve productos.',
    run: async ({ page, store, disco }) => {
      const url = `${store.baseUrl}${disco.prefix}/search?q=${encodeURIComponent(store.searchTerm)}`;
      const products = await countProducts(page, url);
      return { ok: products > 0, detail: `"${store.searchTerm}" → ${products} resultados` };
    },
  },
  {
    group: 'OTROS',
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
  {
    group: 'OTROS',
    label: 'Sin enlaces rotos',
    desc: 'Revisa una muestra de enlaces internos (menú, footer…) y comprueba que ninguno lleva a un 404.',
    once: true,
    chip: 'Enlaces rotos',
    run: async ({ page, store }) => {
      // Configurable por env: pausa entre comprobaciones y nº de enlaces (para ajustar rate-limit vs
      // velocidad). Lo ESCALABLE de verdad es Web Bot Auth (autorizado = sin 429), no un gap enorme.
      const gapMs = Math.min(20000, Math.max(0, Number(process.env.LINK_CHECK_GAP_MS ?? 2500)));
      const maxLinks = Math.min(40, Math.max(1, Number(process.env.LINK_CHECK_MAX ?? 12)));
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      const r = await page.evaluate(
        async ({ gapMs, maxLinks }) => {
          const origin = location.origin;
          const skip = /\/cdn\/|\.(png|jpe?g|webp|svg|gif|css|js|pdf|ico)(\?|$)|^mailto:|^tel:|#/i;
          const hrefs = Array.from(document.querySelectorAll('a[href]'))
            .map((a) => (a as HTMLAnchorElement).href)
            .filter((h) => h.startsWith(origin) && !skip.test(h));
          const unique = Array.from(new Set(hrefs)).slice(0, maxLinks);
          const all: Array<{ p: string; status: number }> = [];
          for (const u of unique) {
            let status = 0;
            try {
              const resp = await fetch(u, { method: 'HEAD', redirect: 'follow' });
              status = resp.status;
            } catch {
              status = 0; // fallo de red puntual
            }
            all.push({ p: u.replace(origin, ''), status });
            await new Promise((res) => setTimeout(res, gapMs));
          }
          return { all };
        },
        { gapMs, maxLinks },
      );
      const isBroken = (s: number) => s === 404 || s === 410 || s >= 500;
      const isLimited = (s: number) => s === 429 || s === 403;
      const broken = r.all.filter((x) => isBroken(x.status));
      const limited = r.all.filter((x) => isLimited(x.status));
      let detail = `${r.all.length} revisados · ${broken.length} roto(s)`;
      if (broken.length) detail += ': ' + broken.slice(0, 3).map((x) => x.p + ' (' + x.status + ')').join(', ');
      if (limited.length) detail += ` · ${limited.length} no verificable(s) (la tienda limitó, no rotos)`;
      // Detalle desplegable: todos los enlaces revisados con su estado (roto / limitado / ok).
      const extra = r.all.map((x) => {
        const tag = isBroken(x.status) ? '✗ ROTO' : isLimited(x.status) ? '— limitado' : x.status === 0 ? '— sin respuesta' : '✓';
        return `${tag} · ${x.status || '—'} · ${x.p || '/'}`;
      });
      return { ok: broken.length === 0, detail, extra };
    },
  },
  {
    group: 'COLECCIONES',
    label: 'Disponibilidad de stock',
    desc: 'Cuenta cuántos productos de la colección aparecen agotados (informativo, no es un fallo).',
    once: true,
    info: true,
    chip: 'Stock',
    run: async ({ page, disco }) => {
      if (!disco.collectionUrl) return { ok: true, detail: 'sin colección que revisar' };
      await nav(page, disco.collectionUrl);
      await dismissPopups(page);
      const r = await page.evaluate(() => {
        const soldSel = '.sold-out, .badge--sold-out, [class*="sold-out"], [class*="soldout"], [data-sold-out]';
        const cards = Array.from(
          document.querySelectorAll('[class*="product-card"], [class*="product-item"], .grid__item, li[class*="product"]'),
        );
        let sold = 0;
        for (const c of cards) {
          if (c.querySelector(soldSel) || /\b(agotado|sold out)\b/i.test(c.textContent || '')) sold++;
        }
        return { total: cards.length, sold: sold || document.querySelectorAll(soldSel).length };
      });
      return { ok: true, detail: `${r.sold} agotado(s)${r.total ? ' de ~' + r.total + ' productos' : ''}` };
    },
  },
  {
    group: 'OTROS',
    label: 'Redirecciones correctas',
    desc: 'Comprueba que http lleva a https y muestra el mercado/idioma por región que aplica la tienda.',
    once: true,
    chip: 'Redirects',
    run: async ({ page, store, disco }) => {
      let httpsOk = false;
      let landed = '';
      try {
        const httpUrl = store.baseUrl.replace(/^https:/i, 'http:');
        await nav(page, httpUrl);
        landed = page.url();
        httpsOk = landed.startsWith('https://');
      } catch {
        /* si falla, httpsOk queda false */
      }
      const region = disco.prefix ? `mercado ${disco.prefix}` : 'sin prefijo de mercado';
      return { ok: httpsOk, detail: `http→https ${httpsOk ? 'sí' : 'no'} · ${region}` };
    },
  },
];

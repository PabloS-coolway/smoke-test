import type { Locator, Page } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { storage } from './storage';
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
  // Modal de geolocalización de Orbe ("Elige tu país de envío"): es un overlay a pantalla completa
  // que TAPA la página e intercepta el clic de "añadir al carrito" → el test fallaba (badge 0→0).
  // No hay botón de cierre fiable (una svg sin aria) y "Ir a la Tienda" puede redirigir de mercado,
  // así que lo ocultamos por JS (para el smoke no necesitamos Orbe) y liberamos el scroll.
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll('.md-app-embed, [class*="md-modal"], [class*="mdApp-modal"], [id*="orbe-modal"]')
        .forEach((e) => (e as HTMLElement).style.setProperty('display', 'none', 'important'));
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    });
  } catch {
    /* si no está Orbe, nada */
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

/**
 * Localiza el botón de añadir al carrito de forma robusta. En muchos temas (p. ej. el de Coolway)
 * el botón NO es descendiente de `<form action="/cart/add">` sino que va dentro de un web component
 * `<buy-buttons>` / `<product-form>` y se asocia al form por atributo `form=`. Además puede hidratar
 * tarde. Por eso el selector antiguo (submit descendiente + getByRole, que ignora ocultos y no espera)
 * fallaba en escritorio. Aquí: esperamos a la hidratación, cubrimos la asociación por `form=`, y
 * DESCARTAMOS el botón "agotado/avísame" (que no es de añadir). Prioriza el visible y habilitado.
 */
async function findAddToCart(page: Page, store: StoreConfig): Promise<Locator | null> {
  const ok = await page
    .waitForFunction(
      (texts) => {
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const addRx = new RegExp(texts.map(esc).join('|'), 'i');
        const badRx = /sold\s*out|agotad|notify me|av[ií]same|out of stock|unavailable/i;
        const forms = Array.from(document.querySelectorAll('form[action*="/cart/add"]'));
        const ids = new Set(forms.map((f) => f.id).filter(Boolean));
        const isSubmit = (e: Element) =>
          e.getAttribute('type') === 'submit' || e.getAttribute('name') === 'add';
        const assoc = (e: Element) =>
          !!e.closest('form[action*="/cart/add"]') ||
          !!e.closest('buy-buttons,product-form') ||
          ids.has(e.getAttribute('form') || '');
        const txt = (e: Element) =>
          `${e.textContent || ''} ${(e as HTMLInputElement).value || ''} ${e.getAttribute('aria-label') || ''}`;
        const shown = (e: Element) =>
          (e as HTMLElement).offsetParent !== null && !(e as HTMLButtonElement).disabled;
        const all = Array.from(document.querySelectorAll('button,input[type=submit],[role=button]'));
        const cands = all.filter(
          (e) => !badRx.test(txt(e)) && ((isSubmit(e) && assoc(e)) || addRx.test(txt(e))),
        );
        const pick =
          cands.find((e) => shown(e) && isSubmit(e) && assoc(e)) ||
          cands.find((e) => shown(e) && addRx.test(txt(e))) ||
          cands.find((e) => isSubmit(e) && assoc(e)) ||
          cands[0] ||
          null;
        if (!pick) return false;
        document.querySelectorAll('[data-smoke-atc]').forEach((e) => e.removeAttribute('data-smoke-atc'));
        pick.setAttribute('data-smoke-atc', '1');
        return true;
      },
      store.addToCart,
      { timeout: 6000 },
    )
    .then(() => true)
    .catch(() => false);
  return ok ? page.locator('[data-smoke-atc]').first() : null;
}

/**
 * Selecciona la primera talla/variante DISPONIBLE (no agotada) si hay selector, para que el botón
 * pase a "añadir al carrito" — los temas muestran "agotado/avísame" cuando la variante no tiene stock.
 */
async function selectAvailableVariant(page: Page): Promise<void> {
  try {
    const clicked = await page.evaluate(() => {
      const bad = /is-disabled|disabled|sold|agotad|unavailable|no-stock/i;
      const labels = Array.from(document.querySelectorAll('label[for]'));
      for (const lbl of labels) {
        if (bad.test(lbl.className)) continue;
        const input = document.getElementById(lbl.getAttribute('for') || '') as HTMLInputElement | null;
        if (input && input.type === 'radio' && !input.disabled && !input.checked) {
          (lbl as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    if (clicked) await page.waitForTimeout(700); // deja que el tema recomponga botón/variante
  } catch {
    /* sin selector de talla: seguimos */
  }
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

/**
 * Suma de CANTIDADES en la página /cart. Más fiable que el nº de líneas para confirmar un "añadir":
 * re-añadir la MISMA variante sube la cantidad de una línea existente pero no crea línea nueva.
 * Devuelve -1 si no encuentra inputs de cantidad (para caer al conteo de líneas).
 */
async function cartTotalQty(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      const sels = [
        'input[name="updates[]"]',
        'input[name^="updates"]',
        'input[name*="quantity" i]',
        '.quantity__input',
        '[data-quantity-input]',
      ];
      for (const s of sels) {
        const els = Array.from(document.querySelectorAll(s));
        if (!els.length) continue;
        let total = 0;
        for (const el of els) {
          const raw = (el as HTMLInputElement).value || el.getAttribute('value') || '0';
          const v = parseInt(raw, 10);
          if (!isNaN(v)) total += v;
        }
        return total;
      }
      return -1;
    });
  } catch {
    return -1;
  }
}

/**
 * Vacía el carrito (best-effort) para que la prueba de "añadir" arranque de 0 y sea fiable:
 * si no, el carrito arrastra items de checks/vistas anteriores y re-añadir la misma variante
 * no cambia el nº de líneas (y el badge de este tema no es fiable). Si el endpoint está
 * bloqueado por anti-bot, se ignora y se cae a la comparación por cantidad/líneas.
 */
async function clearCart(page: Page, store: StoreConfig): Promise<void> {
  try {
    await page.evaluate(async (base) => {
      await fetch(base + '/cart/clear.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => undefined);
    }, store.baseUrl);
  } catch {
    /* bloqueado → seguimos con el fallback por cantidad/líneas */
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

  // 2) Producto: elige el enlace de una CARD de la colección que NO esté agotada (así el test de
  //    añadir prueba un producto comprable). Se decide EN la propia colección → sin visitar PDPs
  //    (menos peticiones = menos throttling/anti-bot). Respaldo: el primer enlace a producto.
  try {
    if (d.collectionUrl) {
      await nav(page, d.collectionUrl);
      await dismissPopups(page);
    }
    const prod = await page.evaluate(() => {
      const soldSel =
        '.sold-out, .badge--sold-out, [class*="sold-out"], [class*="soldout"], [data-sold-out]';
      const soldRx = /\b(agotado|sold out)\b/i;
      const linkOf = (c: Element) => {
        const a = c.querySelector('a[href*="/products/"]');
        const h = a ? a.getAttribute('href') || '' : '';
        return h && !/gift-card/i.test(h) ? h : '';
      };
      const cards = Array.from(
        document.querySelectorAll(
          '[class*="product-card"], [class*="product-item"], .grid__item, li[class*="product"]',
        ),
      );
      for (const c of cards) {
        if (c.querySelector(soldSel) || soldRx.test(c.textContent || '')) continue; // agotada → salta
        const h = linkOf(c);
        if (h) return h;
      }
      // respaldo: cualquier enlace a producto (colección sin cards reconocibles)
      return (
        Array.from(document.querySelectorAll('a[href*="/products/"]'))
          .map((a) => a.getAttribute('href') || '')
          .find((h) => h.includes('/products/') && !/gift-card/i.test(h)) || null
      );
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
      await selectAvailableVariant(page);
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
      const cartUrl = `${store.baseUrl}${disco.prefix}/cart`;
      // Baseline (solo para el fallback por conteo). En US /cart/clear.js y /cart.js están bloqueados a
      // IPs de datacenter, por eso el conteo es poco fiable → la señal principal es la respuesta del add.
      await clearCart(page, store);
      await nav(page, cartUrl).catch(() => undefined);
      await dismissPopups(page);
      const beforeLines = await cartLineItems(page).catch(() => 0);
      const beforeQty = await cartTotalQty(page);
      await nav(page, disco.productUrl);
      await dismissPopups(page);
      await selectAvailableVariant(page);
      const before = await cartCountDom(page);
      const addBtn = await findAddToCart(page, store);
      if (!addBtn) return { ok: false, detail: 'no se encontró el botón de añadir' };
      // Señal ROBUSTA: la respuesta del servidor al POST de /cart/add al pulsar. Confirma que el add se
      // aceptó sin depender de vaciar el carrito, del badge ni del nº de líneas (frágiles/bloqueados en US).
      const addResp = page
        .waitForResponse(
          (r) => /\/cart\/add(\.js)?(\?|$)/i.test(r.url()) && r.request().method() === 'POST',
          { timeout: 9000 },
        )
        .catch(() => null);
      // Click de DOM directo (no el de Playwright): dispara el handler del botón aunque un overlay
      // residual lo tape — en US la click() de Playwright no llegaba a disparar el POST /cart/add.
      await addBtn.evaluate((el) => (el as HTMLElement).click()).catch(() => undefined);
      const resp = await addResp;
      if (resp && resp.status() >= 200 && resp.status() < 400) {
        return { ok: true, detail: `añadido · POST /cart/add → ${resp.status()}` };
      }
      // Fallback (submit sin AJAX o respuesta no capturada): compara el carrito como antes.
      await page.waitForTimeout(2000);
      const after = await cartCountDom(page);
      if (after > before) return { ok: true, detail: `carrito ${before} → ${after}` };
      await nav(page, cartUrl);
      await dismissPopups(page);
      const afterQty = await cartTotalQty(page);
      const afterLines = await cartLineItems(page);
      const grew =
        beforeQty >= 0 && afterQty >= 0 ? afterQty > beforeQty : afterLines > beforeLines;
      return {
        ok: grew,
        detail:
          `badge ${before}→${await cartCountDom(page)} · /cart ${beforeLines}→${afterLines} línea(s)` +
          (afterQty >= 0 ? ` · ${beforeQty}→${afterQty} uds` : '') +
          (resp ? ` · add→${resp.status()}` : ' · sin respuesta add'),
      };
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
    label: 'SEO básico',
    desc: 'Comprueba que la home tiene title, meta description y canonical, y que la ficha lleva datos estructurados (JSON-LD de producto).',
    once: true,
    chip: 'SEO',
    run: async ({ page, store, disco }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      const home = await page.evaluate(() => ({
        title: (document.title || '').trim().length > 0,
        desc: !!document.querySelector('meta[name="description"]')?.getAttribute('content'),
        canonical: !!document.querySelector('link[rel="canonical"]'),
        og: !!document.querySelector('meta[property="og:title"], meta[property="og:image"]'),
      }));
      let jsonld = false;
      if (disco.productUrl) {
        await nav(page, disco.productUrl);
        await dismissPopups(page);
        jsonld = await page.evaluate(() =>
          Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some((s) => /"@type"\s*:\s*"Product"/i.test(s.textContent || '')),
        );
      }
      const extra = [
        (home.title ? '✓' : '✗') + ' title',
        (home.desc ? '✓' : '✗') + ' meta description',
        (home.canonical ? '✓' : '✗') + ' canonical',
        (home.og ? '✓' : '✗') + ' Open Graph',
        (jsonld ? '✓' : '✗') + ' JSON-LD de producto (ficha)',
      ];
      const missing: string[] = [];
      if (!home.title) missing.push('title');
      if (!home.desc) missing.push('meta description');
      if (!home.canonical) missing.push('canonical');
      const ok = home.title && home.desc && home.canonical;
      return { ok, detail: ok ? 'title, meta y canonical OK' : 'falta: ' + missing.join(', '), extra };
    },
  },
  {
    group: 'OTROS',
    label: 'Analítica y píxeles',
    desc: 'Comprueba que la home carga las herramientas de medición (Google, Meta Pixel, Klaviyo…). Un deploy puede tirarlas y perderías tracking.',
    once: true,
    chip: 'Analytics',
    run: async ({ page, store }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      await page.waitForTimeout(1200); // deja que carguen los scripts de terceros
      const list = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const out: string[] = [];
        if (/googletagmanager\.com|google-analytics\.com|gtag\/js|\banalytics\.js\b/.test(html)) out.push('Google (GA/GTM)');
        if (/connect\.facebook\.net|fbevents\.js|fbq\(/.test(html)) out.push('Meta Pixel');
        if (/klaviyo/i.test(html)) out.push('Klaviyo');
        if (/analytics\.tiktok|tiktokcdn/.test(html)) out.push('TikTok');
        if (/static\.hotjar|hotjar\.com/.test(html)) out.push('Hotjar');
        if (/cdn\.shopify\.com\/shopifycloud\/(web-pixels|shopify-analytics)/.test(html)) out.push('Shopify');
        return out;
      });
      return {
        ok: list.length > 0,
        detail: list.length ? 'detectados: ' + list.join(', ') : 'no se detectó ninguna herramienta de medición',
        extra: list.length ? list.map((x) => '✓ ' + x) : undefined,
      };
    },
  },
  {
    group: 'PDP',
    label: 'Elegir variante funciona',
    desc: 'En la ficha, selecciona una variante disponible (p. ej. una talla) y comprueba que la selección se aplica y el producto sigue siendo comprable.',
    chip: 'Variantes',
    run: async ({ page, store, disco }) => {
      if (!disco.productUrl) return { ok: false, detail: 'sin producto que probar (no descubierto)' };
      await nav(page, disco.productUrl);
      await dismissPopups(page);
      // Selectores de variante AGNÓSTICOS al tema: los inputs de opción de Shopify se llaman siempre
      // name="option1/2/3", vengan en <variant-radios> (Dawn), <variant-picker> (Prestige/Impulse) o
      // .product-form__input. Nos ceñimos a name^="option" para no confundir con otros radios/selects.
      const RADIO = 'input[type="radio"][name^="option"]';
      const SELECT = 'select[name^="option"]';
      const counts = await page.evaluate(
        ({ RADIO, SELECT }) => ({
          radios: document.querySelectorAll(RADIO).length,
          selects: document.querySelectorAll(SELECT).length,
        }),
        { RADIO, SELECT },
      );
      if (counts.radios === 0 && counts.selects === 0) {
        return { ok: true, detail: 'producto de variante única (no hay opciones que elegir)' };
      }
      // Id de variante actual (input oculto [name="id"] del form, o el ?variant= de la URL).
      const variantId = () =>
        page.evaluate(
          () =>
            (document.querySelector('form[action*="/cart/add"] [name="id"]') as HTMLInputElement | null)?.value ||
            new URL(location.href).searchParams.get('variant') ||
            '',
        );
      const idBefore = await variantId();
      let picked = '';
      if (counts.radios > 0) {
        const radios = page.locator(RADIO);
        const n = await radios.count();
        for (let i = 0; i < n; i++) {
          const r = radios.nth(i);
          if (await r.isDisabled().catch(() => false)) continue; // agotada / no seleccionable
          if (await r.isChecked().catch(() => false)) continue; // ya era la marcada
          // El radio suele ser sr-only (oculto); el control visible es su <label>. Clicamos el label
          // (dispara el 'change' que el tema escucha); si no hay, forzamos el clic sobre el input.
          const id = await r.getAttribute('id');
          let clicked = false;
          if (id) {
            const label = page.locator(`label[for="${id}"]`).first();
            if (await label.count()) {
              await label.click({ timeout: 2500, force: true }).catch(() => undefined);
              clicked = true;
            }
          }
          if (!clicked) await r.click({ timeout: 2500, force: true }).catch(() => undefined);
          picked = (await r.getAttribute('value')) || 'opción';
          break;
        }
      } else {
        const sel = page.locator(SELECT).first();
        const opts = await sel.locator('option:not([disabled])').count();
        if (opts > 1) {
          await sel.selectOption({ index: 1 }).catch(() => undefined);
          picked = 'opción de lista';
        }
      }
      await page.waitForTimeout(1500); // deja que el tema actualice la variante seleccionada
      const idAfter = await variantId();
      const addBtn = await findAddToCart(page, store);
      const addable = addBtn ? !(await addBtn.isDisabled().catch(() => false)) : false;
      const changed = !!idAfter && idBefore !== idAfter;
      const ok = changed || (!!picked && addable);
      const opts = counts.radios || counts.selects;
      const detail = picked
        ? `${opts} opciones · seleccionada ${picked}${changed ? ` · variante ${idBefore || '—'}→${idAfter || '—'}` : ''}${addable ? ' · comprable' : ''}`
        : 'no se pudo seleccionar ninguna variante disponible';
      return { ok, detail };
    },
  },
  {
    group: 'OTROS',
    label: 'Páginas clave responden',
    desc: 'Comprueba que la página de error 404, el carrito vacío y una búsqueda sin resultados se muestran con el tema (no una pantalla en blanco ni un 500).',
    once: true,
    chip: 'Plantillas',
    run: async ({ page, store, disco }) => {
      const pfx = disco.prefix;
      const header = () => page.locator('header, [role="banner"], .header, .site-header').first().count();
      const probe = async (name: string, url: string, want404: boolean) => {
        try {
          const resp = await nav(page, url);
          await dismissPopups(page);
          const status = resp?.status() ?? 0;
          const hasHeader = (await header()) > 0;
          const ok = want404 ? status === 404 && hasHeader : status < 400 && hasHeader;
          return { name, ok, note: `HTTP ${status}${hasHeader ? ' · con tema' : ' · sin cabecera'}` };
        } catch {
          return { name, ok: false, note: 'error al cargar' };
        }
      };
      const results = [
        await probe('404', `${store.baseUrl}${pfx}/no-existe-smoke-test-404`, true),
        await probe('carrito vacío', `${store.baseUrl}${pfx}/cart`, false),
        await probe('búsqueda sin resultados', `${store.baseUrl}${pfx}/search?q=zzqxwk-smoke-no-result`, false),
      ];
      const bad = results.filter((r) => !r.ok);
      const extra = results.map((r) => (r.ok ? '✓ ' : '✗ ') + r.name + ' · ' + r.note);
      return {
        ok: bad.length === 0,
        detail: bad.length ? 'fallan: ' + bad.map((b) => b.name).join(', ') : 'todas correctas (404, carrito vacío, búsqueda sin resultados)',
        extra,
      };
    },
  },
  {
    group: 'HOME',
    label: 'Regresión visual (home)',
    desc: 'Compara la home con una referencia guardada y avisa si cambió mucho a nivel visual (informativo). La primera vez guarda la referencia; puedes reiniciarla en Ajustes tras un rediseño.',
    once: true,
    info: true,
    chip: 'Visual',
    run: async ({ page, store }) => {
      await nav(page, store.baseUrl);
      await dismissPopups(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(700); // deja asentar banners/animaciones de entrada
      const shot = await page.screenshot(); // viewport fijo 1366×900 (check `once` = escritorio)
      const key = `baseline/${store.id}-home.png`;
      const base = await storage.getImage(key).catch(() => null);
      if (!base) {
        await storage.putImage(key, shot);
        return { ok: true, detail: 'referencia guardada (primera vez) — nada que comparar todavía' };
      }
      try {
        const a = PNG.sync.read(base);
        const b = PNG.sync.read(shot);
        if (a.width !== b.width || a.height !== b.height) {
          await storage.putImage(key, shot);
          return { ok: true, detail: `tamaño distinto (${a.width}×${a.height} → ${b.width}×${b.height}) · referencia actualizada` };
        }
        const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
        const pct = (diff / (a.width * a.height)) * 100;
        const changed = pct >= 3; // umbral: por debajo es ruido (lazy-load, banners rotativos)
        return {
          ok: true,
          detail: `${pct.toFixed(1)}% de píxeles distintos a la referencia${changed ? ' — REVISAR (posible cambio visual)' : ' — sin cambios notables'}`,
        };
      } catch (e) {
        return { ok: true, detail: 'no se pudo comparar: ' + (e instanceof Error ? e.message : String(e)) };
      }
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

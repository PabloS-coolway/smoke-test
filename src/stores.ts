/**
 * Configuración de las tiendas a probar.
 *
 * PENSADO PARA ESCALA (12+ tiendas del MISMO tema, variantes por región): la lista de tiendas es
 * DATA-DRIVEN (variable `STORES`, un JSON) y los parámetros por región (idioma, moneda, etiquetas de
 * menú, texto del botón de añadir, término de búsqueda) se PLANTILLAN por idioma en `REGION_DEFAULTS`.
 * Así, dar de alta una tienda nueva = añadir una línea al JSON (+ su firma como secreto), sin tocar
 * código. Los checks ya son agnósticos al tema (descubren colección/producto en runtime), por lo que
 * la misma suite corre en todas las tiendas sin ajustes por tienda.
 *
 * `STORES` (JSON): [{ "id":"eu", "name":"Europa", "url":"https://coolway.com", "lang":"es" }, ...]
 *   - Campos obligatorios: id, name, url, lang.
 *   - Opcionales (override del default de región): currency, navHover, addToCart, searchTerm, proxy.
 * Secretos por tienda (NO en el JSON, van como env/secret aparte, por id en mayúsculas):
 *   - STORE_<ID>_SIGNATURE / STORE_<ID>_SIGNATURE_INPUT  → Shopify Web Bot Auth (bot autorizado).
 *   - STORE_<ID>_PROXY                                    → proxy residencial (alternativa a la firma).
 *
 * Compatibilidad: si `STORES` no está definida, se usa el modelo anterior de 2 tiendas (STORE_EU_URL /
 * STORE_US_URL), para no romper el despliegue actual.
 */
export interface StoreConfig {
  id: string;
  name: string;
  baseUrl: string;
  lang: string; // prefijo esperado de <html lang> (es, en…)
  currency: string; // símbolo esperado en los precios (€, $)
  navHover: string[]; // etiquetas de menú a las que hacer hover para abrir el mega-menú
  addToCart: string[]; // textos candidatos del botón de añadir al carrito
  searchTerm: string; // término que debería devolver resultados
  /**
   * Proxy opcional por el que enrutar TODO el tráfico del navegador de esta tienda. Algunas tiendas
   * bloquean con bot-challenge a las IPs de datacenter; un proxy RESIDENCIAL del país de la tienda lo
   * evita. Formato: `http://usuario:clave@host:puerto`. Se lee de `STORE_<ID>_PROXY`. Vacío = directo.
   */
  proxy?: string;
  /**
   * Shopify **Web Bot Auth**: firma que identifica al monitor como bot AUTORIZADO de la tienda (rate
   * limits altos, no lo challengea). Se genera en el Admin: Online Store → Preferences → Crawler access
   * → Create signature. Da `Signature` y `Signature-Input` (se envían con `Signature-Agent`). Caduca
   * (máx 3 meses). Se leen de `STORE_<ID>_SIGNATURE` y `STORE_<ID>_SIGNATURE_INPUT`.
   */
  sig?: string;
  sigInput?: string;
}

/** Parámetros por región (idioma). Al ser todas variantes del mismo tema, esto cubre casi todo; una
 *  tienda concreta puede sobreescribir cualquiera de estos campos en su entrada de `STORES`. */
type RegionDefaults = Pick<StoreConfig, 'currency' | 'navHover' | 'addToCart' | 'searchTerm'>;
const REGION_DEFAULTS: Record<string, RegionDefaults> = {
  es: { currency: '€', navHover: ['Hombre', 'Mujer'], addToCart: ['Añadir al carrito', 'Añadir', 'Agregar', 'Add to cart'], searchTerm: 'botas' },
  en: { currency: '$', navHover: ['Men', 'Women'], addToCart: ['Add to cart', 'Add to bag', 'Añadir'], searchTerm: 'boots' },
  fr: { currency: '€', navHover: ['Homme', 'Femme'], addToCart: ['Ajouter au panier', 'Ajouter', 'Add to cart'], searchTerm: 'bottes' },
  de: { currency: '€', navHover: ['Herren', 'Damen'], addToCart: ['In den Warenkorb', 'Hinzufügen', 'Add to cart'], searchTerm: 'stiefel' },
  it: { currency: '€', navHover: ['Uomo', 'Donna'], addToCart: ['Aggiungi al carrello', 'Aggiungi', 'Add to cart'], searchTerm: 'stivali' },
  pt: { currency: '€', navHover: ['Homem', 'Mulher'], addToCart: ['Adicionar ao carrinho', 'Adicionar', 'Add to cart'], searchTerm: 'botas' },
};
const DEFAULT_REGION = REGION_DEFAULTS.en;

const clean = (s?: string) => (s ?? '').trim().replace(/\/+$/, '');
const env = (s?: string) => (s ?? '').trim() || undefined;

/** Forma cruda de una tienda en el JSON `STORES` (todo opcional salvo lo básico; se valida al mapear). */
interface RawStore {
  id?: string;
  name?: string;
  url?: string;
  lang?: string;
  currency?: string;
  navHover?: string[];
  addToCart?: string[];
  searchTerm?: string;
  proxy?: string;
}

/** Lee la lista cruda de tiendas: de `STORES` (JSON) si existe; si no, el modelo compat de 2 tiendas. */
function rawStores(): RawStore[] {
  const raw = (process.env.STORES ?? '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as RawStore[];
    } catch {
      /* JSON inválido → cae al modelo compat */
    }
  }
  // Compatibilidad: las 2 tiendas históricas desde sus envs propias.
  return [
    { id: 'eu', name: 'Europa', url: process.env.STORE_EU_URL, lang: 'es' },
    { id: 'us', name: 'EE. UU.', url: process.env.STORE_US_URL, lang: 'en' },
  ];
}

/** Secretos por tienda (firma Web Bot Auth y/o proxy), leídos por id en mayúsculas. */
function storeSecrets(id: string): { sig?: string; sigInput?: string; proxy?: string } {
  const U = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    sig: env(process.env[`STORE_${U}_SIGNATURE`]),
    sigInput: env(process.env[`STORE_${U}_SIGNATURE_INPUT`]),
    proxy: env(process.env[`STORE_${U}_PROXY`]),
  };
}

export function stores(): StoreConfig[] {
  return rawStores()
    .filter((s) => s.id && s.url)
    .map((s) => {
      const lang = (s.lang || 'en').toLowerCase();
      const r = REGION_DEFAULTS[lang] ?? DEFAULT_REGION;
      const sec = storeSecrets(s.id as string);
      const cfg: StoreConfig = {
        id: s.id as string,
        name: s.name || (s.id as string),
        baseUrl: clean(s.url),
        lang,
        currency: s.currency || r.currency,
        navHover: s.navHover && s.navHover.length ? s.navHover : r.navHover,
        addToCart: s.addToCart && s.addToCart.length ? s.addToCart : r.addToCart,
        searchTerm: s.searchTerm || r.searchTerm,
        proxy: s.proxy || sec.proxy,
        sig: sec.sig,
        sigInput: sec.sigInput,
      };
      return cfg;
    })
    .filter((s) => s.baseUrl); // solo las que tienen URL válida
}

export function storeById(id: string): StoreConfig | undefined {
  return stores().find((s) => s.id === id);
}

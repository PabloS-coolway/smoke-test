/**
 * Configuración de cada tienda a probar. Las URLs vienen del `.env` (STORE_EU_URL / STORE_US_URL);
 * el resto son parámetros por región (idioma, moneda, etiquetas de menú, texto del botón de añadir,
 * término de búsqueda) que hacen que los checks funcionen aunque el idioma cambie entre tiendas.
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
   * (p. ej. la US) bloquean con bot-challenge a las IPs de datacenter en las peticiones profundas; un
   * proxy RESIDENCIAL del país de la tienda lo evita. Formato: `http://usuario:clave@host:puerto`.
   * Se lee de la env `STORE_<ID>_PROXY` (STORE_EU_PROXY, STORE_US_PROXY). Vacío = sin proxy (directo).
   */
  proxy?: string;
}

const clean = (s?: string) => (s ?? '').trim().replace(/\/+$/, '');
const env = (s?: string) => (s ?? '').trim() || undefined;

export function stores(): StoreConfig[] {
  const all: StoreConfig[] = [
    {
      id: 'eu',
      name: 'Europa',
      baseUrl: clean(process.env.STORE_EU_URL),
      lang: 'es',
      currency: '€',
      navHover: ['Hombre', 'Mujer'],
      addToCart: ['Añadir al carrito', 'Añadir', 'Agregar', 'Add to cart'],
      searchTerm: 'botas',
      proxy: env(process.env.STORE_EU_PROXY),
    },
    {
      id: 'us',
      name: 'EE. UU.',
      baseUrl: clean(process.env.STORE_US_URL),
      lang: 'en',
      currency: '$',
      navHover: ['Men', 'Women'],
      addToCart: ['Add to cart', 'Add to bag', 'Añadir'],
      searchTerm: 'boots',
      proxy: env(process.env.STORE_US_PROXY),
    },
  ];
  // Solo las que tienen URL configurada.
  return all.filter((s) => s.baseUrl);
}

export function storeById(id: string): StoreConfig | undefined {
  return stores().find((s) => s.id === id);
}

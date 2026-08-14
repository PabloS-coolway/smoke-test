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
}

const clean = (s?: string) => (s ?? '').trim().replace(/\/+$/, '');

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
    },
  ];
  // Solo las que tienen URL configurada.
  return all.filter((s) => s.baseUrl);
}

export function storeById(id: string): StoreConfig | undefined {
  return stores().find((s) => s.id === id);
}

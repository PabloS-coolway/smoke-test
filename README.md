# coolway-smoke

**Test automatizado de las tiendas Shopify de Coolway (EU y US).** Es una mini web-app: **Catalina
abre una página, pulsa "Probar" y ve un informe verde/rojo con capturas** — sin tocar código.
Pensado para lanzarlo **después de cada deploy** y saber en un par de minutos si algo se rompió.

No arregla el proceso de deploy (ramas sueltas, sin unificar); es la **red de seguridad** que avisa.

## Qué comprueba (por tienda)

- **Navegación** — la home carga; la colección carga con productos; el mega-menú abre.
- **PDP + carrito** — la ficha de producto carga; el botón de añadir existe; **añadir al carrito
  funciona** (vía `/cart.js`); el **checkout es alcanzable** (sin colocar ningún pedido).
- **Buscador** — devuelve resultados.
- **Región** — moneda e idioma correctos (€/es en EU, $/en en US) y **sin errores graves de JS**.

Corre contra la **tienda live**. Es tolerante a cambios de tema (usa selectores estándar de Shopify);
en la primera pasada real puede que haya que afinar algún selector o etiqueta de menú (`src/stores.ts`).

## Local

```bash
cp .env.example .env          # pon STORE_EU_URL y STORE_US_URL reales
npm install
npx playwright install --with-deps chromium
npm run dev                   # http://localhost:8080
```

También por terminal (para automatizar): `npm run cli` (todas) o `npm run cli -- eu` (una). Sale con
código ≠ 0 si algo falla — útil para engancharlo a un pipeline post-deploy.

## Desplegar en DigitalOcean

Trae **Dockerfile** (imagen oficial de Playwright, con los navegadores dentro).

**App Platform** (recomendado): crea una app desde este repo de GitHub, tipo **Dockerfile**, y define
las variables de entorno:

- `STORE_EU_URL` — home de la tienda EU (p. ej. `https://www.coolway.com`).
- `STORE_US_URL` — home de la tienda US.
- `SMOKE_PASSWORD` — (opcional) si se pone, la UI la pide antes de lanzar.
- `PORT` — `8080` (por defecto).

Puerto HTTP: **8080**. La app sirve la UI en `/` y la API en `/api`.

## Añadir tiendas / afinar

- **Tiendas y parámetros por región** (URL, idioma, moneda, etiquetas de menú, texto del botón de
  añadir, término de búsqueda): `src/stores.ts`.
- **Los checks**: `src/checks.ts`.

## Cómo lo usa Catalina

Abre la URL de la app → pulsa **Probar Europa** / **Probar EE. UU.** / **Probar todas** → espera ~1 min
por tienda → lee el informe: **TODO OK** o **HAY FALLOS**, con el detalle y la captura de cada paso.

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

## Historial duradero (importante)

Cada validación se guarda (informe + capturas) y aparece en la pestaña **Historial**. Hay dos backends,
que se eligen solos según el entorno:

- **Disco** (por defecto, solo desarrollo): guarda en `runs/`.
- **DO Spaces** (producción): guarda en un bucket S3-compatible. **Úsalo en DigitalOcean**, porque el
  disco de App Platform es **efímero** (se borra en cada redeploy) y el historial se perdería.

Para activar Spaces basta con definir `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET` y `SPACES_ENDPOINT`
(ver `.env.example`). Si no están, cae a disco. Al arrancar, el log dice cuál está usando.

## Desplegar en DigitalOcean

Trae **Dockerfile** (imagen oficial de Playwright, con los navegadores dentro) y un **App Spec** en
[`.do/app.yaml`](.do/app.yaml).

**Pasos (una vez):**

1. **Crea un Space** en DO (Storage > Spaces; p. ej. región `fra1`, nombre `coolway-smoke`) y una
   **Access Key** en *API > Spaces Keys*. Apunta key y secret.
2. **Sube este repo a GitHub** y en `.do/app.yaml` ajusta `github.repo` al owner real.
3. **Crea la app**: DO > Apps > *Create App* → importa `.do/app.yaml` (o `doctl apps create --spec .do/app.yaml`),
   tipo **Dockerfile**.
4. **Rellena los secretos** en el panel de DO (no en el YAML): `SPACES_KEY`, `SPACES_SECRET` y, si quieres,
   `SMOKE_PASSWORD`.

Con `deploy_on_push: true`, cada push a `main` redespliega. El historial vive en Spaces, así que **sobrevive
a los redeploys**.

Variables de entorno (todas en `.env.example` / `.do/app.yaml`):

- `STORE_EU_URL`, `STORE_US_URL` — homes de las tiendas.
- `SMOKE_PASSWORD` — (opcional) si se pone, la UI la pide antes de lanzar.
- `SPACES_KEY`, `SPACES_SECRET`, `SPACES_BUCKET`, `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_PREFIX` — historial duradero.
- `PORT` — `8080` (por defecto).

Puerto HTTP: **8080**. La app sirve la UI en `/`, la API en `/api` y las capturas en `/runs`.

## Tiendas que bloquean al servidor (Shopify Web Bot Auth) ← recomendado

Shopify aplica **rate limits/challenges** a las peticiones profundas (`/cart`, `/search`) desde IPs de
datacenter que no se identifican. La vía **oficial y gratis** para monitorizar **tu propia** tienda es
**Web Bot Auth**: firmas el tráfico como bot autorizado.

1. En el Admin de la tienda: **Online Store → Preferences → Crawler access → Create signature** (elige
   caducidad, máx 3 meses).
2. Copia los dos valores que da (**Signature** y **Signature-Input**) a las envs de esa tienda:
   `STORE_US_SIGNATURE` y `STORE_US_SIGNATURE_INPUT` (análogo para EU). El código añade
   `Signature-Agent: "https://shopify.com"` solo.
3. Redeploy. El monitor envía esas cabeceras en cada petición → tráfico autorizado, límites altos.

Es **por tienda** (cada firma va ligada a su dominio) y **caduca** (recordar renovar cada ≤3 meses).
No es un bypass del WAF ni del checkout: si aún queda algo bloqueado, el informe lo marca **ámbar
"no verificable"** (ver abajo), no rojo.

## Tiendas que bloquean IPs de datacenter (proxy)

Algunas tiendas Shopify tienen protección anti-bot que **desafía (challenge) a las IPs de datacenter**
en las peticiones profundas (`/cart`, `/search`) — las primeras páginas cargan, pero las siguientes
reciben una página-challenge y los checks salen vacíos. Se confirmó que **coolway-us.com lo hace desde
cualquier datacenter** (Frankfurt y Nueva York) — **no es geográfico**. La tienda EU no lo hace.

**Solución:** enrutar esa tienda por un **proxy residencial** de su país. Es por-tienda (escalable a las
12): define `STORE_<ID>_PROXY` con `http://usuario:clave@host:puerto`.

```
STORE_US_PROXY="http://user:pass@us.residential-proxy.example:8000"
```

Proveedores de proxy residencial: Bright Data, Oxylabs, IPRoyal, Webshare (tienen planes de pago; el
tráfico del smoke test es mínimo). La EU no necesita proxy (va 8/8 directa desde DO).

## Añadir tiendas / afinar

- **Tiendas y parámetros por región** (URL, idioma, moneda, etiquetas de menú, texto del botón de
  añadir, término de búsqueda): `src/stores.ts`.
- **Los checks**: `src/checks.ts`.

## Cómo lo usa Catalina

Abre la URL de la app → pulsa **Probar Europa** / **Probar EE. UU.** / **Probar todas** → espera ~1 min
por tienda → lee el informe: **TODO OK** o **HAY FALLOS**, con el detalle y la captura de cada paso.

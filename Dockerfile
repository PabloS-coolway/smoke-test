# Imagen oficial de Playwright: trae Node + los navegadores ya instalados.
# La versión DEBE cuadrar con la de `playwright` en package.json (pineada a 1.62.0),
# si no, el navegador de la imagen no coincide con el que espera playwright.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

WORKDIR /app

# Instala dependencias (incluye tsx para ejecutar TS sin build).
# Copia el lockfile para un install reproducible.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# `npm start` = tsx src/server.ts
CMD ["npm", "start"]

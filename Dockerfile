# Imagen oficial de Playwright: trae Node + los navegadores ya instalados.
# La versión debe cuadrar con la de `playwright` en package.json (v1.48).
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Instala dependencias (incluye tsx para ejecutar TS sin build).
COPY package.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# `npm start` = tsx src/server.ts
CMD ["npm", "start"]

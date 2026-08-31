# ─────────────────────────────────────────────────────────────────────────────
# Dos etapas por una razón concreta: `better-sqlite3` se compila —trae C++— y
# para eso hacen falta python3, make y g++. Si eso viviera en la imagen final,
# se llevaría un compilador entero a producción por nada.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS construir
WORKDIR /app

RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
# `npm ci` y no `install`: instala EXACTAMENTE lo del lock. Sin eso, una
# dependencia puede subir de versión sola entre tu prueba y el despliegue.
RUN npm ci --omit=dev

# ── La imagen que se despliega ──
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Sin usuario propio, todo corre como root: un fallo de la aplicación sería un
# fallo con permisos de root dentro del contenedor.
RUN addgroup -S sandbox && adduser -S sandbox -G sandbox

COPY --from=construir /app/node_modules ./node_modules
COPY --chown=sandbox:sandbox package.json ./
COPY --chown=sandbox:sandbox src ./src
COPY --chown=sandbox:sandbox public ./public

# Aquí vive todo lo que hay que conservar: la base, los archivos subidos y la
# clave de administración. Va en un volumen, no en la imagen.
RUN mkdir -p /app/datos && chown -R sandbox:sandbox /app/datos
VOLUME ["/app/datos"]

USER sandbox
EXPOSE 8095

# Comprueba lo que importa —que conteste—, no que el proceso exista: un Node
# vivo con la base rota sigue "arriba" y no sirve para nada.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8095/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

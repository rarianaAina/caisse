# ============================================================================
# Image de l'API.
#
# Base Debian (« bookworm-slim ») et non Alpine : `@node-rs/argon2` et les
# moteurs Prisma sont des binaires natifs, compilés pour la glibc. Sur Alpine
# (musl), ils se chargent parfois et échouent au premier hachage — au moment
# précis d'une connexion, donc en production. Les ~40 Mo de plus achètent une
# certitude.
# ============================================================================

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# Tout est installé ici, en une seule couche partagée par les deux étages :
#   openssl : sans lui, Prisma ne détermine pas la version de libssl et se
#             rabat sur un moteur prévu pour OpenSSL 1.1, absent de l'image —
#             l'erreur ne surviendrait qu'à la première requête, en production ;
#   curl    : sonde de disponibilité du conteneur ;
#   tini    : un vrai PID 1, qui transmet SIGTERM et récolte les orphelins,
#             sans quoi l'arrêt du conteneur coupe les requêtes en vol.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ─── Construction ──────────────────────────────────────────────────────────
FROM base AS build

# Les manifestes d'abord : tant qu'ils ne changent pas, Docker réutilise la
# couche d'installation, de loin la plus lente.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/api apps/api

# `prisma generate` avant la compilation : le code TypeScript importe les types
# du client engendré, qui n'existent pas encore dans une arborescence neuve.
RUN pnpm --filter @caisse/shared build \
  && pnpm --filter @caisse/api exec prisma generate \
  && pnpm --filter @caisse/api build

# `deploy` reconstruit une arborescence autonome (dépendances de production
# résolues, lien du paquet partagé remplacé par son contenu). `--legacy` parce
# que le dépôt n'utilise pas les dépendances injectées : sans ce drapeau, pnpm
# 11 refuse de déployer.
RUN pnpm --filter @caisse/api --prod --legacy deploy /deploy

# `--legacy` laisse le paquet partagé sous forme de lien vers le dépôt, qui
# n'existe plus dans l'image finale : l'API démarrait puis mourait sur
# « Cannot find module '@caisse/shared' ». On le remplace par son contenu.
RUN rm -rf /deploy/node_modules/@caisse/shared \
  && mkdir -p /deploy/node_modules/@caisse/shared \
  && cp -r packages/shared/dist packages/shared/package.json /deploy/node_modules/@caisse/shared/

# Le client Prisma est engendré APRÈS le déploiement, dans l'arborescence
# finale : `deploy` reconstruit un node_modules neuf, et un client engendré
# avant y disparaîtrait — l'API démarrerait puis échouerait à la première
# requête, avec un message parlant de client non initialisé.
RUN cd /deploy && node node_modules/prisma/build/index.js generate --schema prisma/schema.prisma

# ─── Exécution ─────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build --chown=node:node /deploy /app

# Jamais root : une faille dans une dépendance ne doit pas donner le conteneur.
USER node

EXPOSE 3000

# `ready` répond 503 quand PostgreSQL est injoignable : Docker cesse alors de
# considérer l'instance comme saine, et le proxy peut la retirer du service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health/ready || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]

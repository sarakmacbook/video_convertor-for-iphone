# Self-hosting the web app in a container.
#
# For Vercel, nothing in this file is used — see docs/VERCEL.md. This image is for running the
# whole thing on one machine (a NAS, a VPS, a Raspberry Pi), where SQLite and local storage are
# perfectly good choices.

# --------------------------------------------------------------------------- build ---------
FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Dependencies first, so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ----------------------------------------------------------------------------- run ---------
FROM node:22-bookworm-slim
WORKDIR /app

# ffmpeg is the only system dependency the app has.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/data/app.db \
    STORAGE_DRIVER=local \
    STORAGE_DIR=/data/storage \
    WORK_DIR=/data/tmp

# `npm run worker`, `npm run db:migrate` and the app itself all live in here.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/app ./app
COPY --from=build /app/components ./components
COPY --from=build /app/lib ./lib
COPY --from=build /app/cli ./cli
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/video_convertor_bot ./video_convertor_bot
COPY --from=build /app/worker ./worker

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]

# Create the schema (idempotent), then serve.
CMD ["sh", "-c", "npm run db:migrate && exec npm run start"]

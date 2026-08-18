# Localbots in a container: SimulationCraft is compiled in the first stage and
# only the finished binary (plus the data files Localbots reads) ships in the
# final image, so the runtime stays small and needs no build tools.
#
# Build:  docker build -t localbots .
# Run:    docker run -d -p 4747:4747 -v localbots-cache:/app/data/cache localbots

# ---------- stage 1: compile simc ----------
FROM debian:bookworm-slim AS simc

# simc renames its branch each expansion — override with --build-arg when it changes
ARG SIMC_BRANCH=midnight

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates cmake ninja-build g++ libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
RUN git clone --depth 1 --branch "${SIMC_BRANCH}" https://github.com/simulationcraft/simc.git simc
WORKDIR /opt/simc
RUN cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_GUI=OFF \
    && ninja -C build simc

# ---------- stage 2: the app ----------
FROM node:22-bookworm-slim

# simc links against libcurl even though Localbots always sims with
# item_db_source=local (it never calls out for item data)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libcurl4 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The layout here is load-bearing: Localbots finds simc's talent tables by
# resolving the binary and walking up two directories, so the binary must stay
# at <simc>/build/simc with engine/dbc/generated alongside it.
COPY --from=simc /opt/simc/build/simc                              /opt/simc/build/simc
COPY --from=simc /opt/simc/engine/dbc/generated/trait_data.inc     /opt/simc/engine/dbc/generated/trait_data.inc
COPY --from=simc /opt/simc/engine/dbc/generated/trait_data_ptr.inc /opt/simc/engine/dbc/generated/trait_data_ptr.inc
# item stat scaling curves, read the same way (see server/itemStats.js)
COPY --from=simc /opt/simc/engine/dbc/generated/sc_scale_data.inc     /opt/simc/engine/dbc/generated/sc_scale_data.inc
COPY --from=simc /opt/simc/engine/dbc/generated/sc_scale_data_ptr.inc /opt/simc/engine/dbc/generated/sc_scale_data_ptr.inc
ENV SIMC_PATH=/opt/simc/build/simc

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Game data and saved sims live in volumes; everything else is rebuilt with the
# image. Owned by the unprivileged user the app runs as.
RUN mkdir -p data/cache data/history jobs && chown -R node:node /app
USER node

ENV PORT=4747
# A shared server should not be killable from anyone's browser tab — rebuild or
# `docker compose restart` instead. Set to 1 to put the button back.
ENV LOCALBOTS_ALLOW_SHUTDOWN=0

EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4747)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]

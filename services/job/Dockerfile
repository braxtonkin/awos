ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u1 tini=0.19.0-1+b3 libcap2-bin=1:2.66-4+deb12u3+b1 \
 && groupadd --gid 10001 bridge && useradd --uid 10001 --gid bridge --create-home --shell /usr/sbin/nologin bridge \
 && groupadd --gid 10002 codex && useradd --uid 10002 --gid codex --create-home --shell /bin/sh codex \
 && install -o root -g bridge -m 0750 /usr/local/bin/node /usr/local/bin/node-bridge \
 && setcap cap_setuid,cap_setgid,cap_kill=ep /usr/local/bin/node-bridge \
 && apt-get purge -y libcap2-bin && rm -rf /var/lib/apt/lists/* \
 && install -d -o codex -g codex -m 0755 /workspace \
 && install -d -o bridge -g bridge -m 0755 /var/lib/autoworker
RUN npm install --global @openai/codex@0.156.0 && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY shared shared
COPY features features
COPY services/job services/job
USER 10001:10001
ENTRYPOINT ["tini", "--", "node-bridge", "/app/services/job/main.ts"]

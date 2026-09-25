ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM eclipse-temurin:21-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f AS java

FROM ${NODE_IMAGE} AS docker-cli
ADD --checksum=sha256:d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70 https://download.docker.com/linux/static/stable/x86_64/docker-29.8.1.tgz /docker.tgz
RUN tar -xzf /docker.tgz --no-same-owner --strip-components=1 -C /usr/local/bin docker/docker

FROM ${NODE_IMAGE} AS browser
RUN apt-get update && apt-get install -y --no-install-recommends unzip=6.0-28+deb12u1 && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip /shell.zip
ADD --checksum=sha256:ebc74fc5b94830176a3c2914ae96bd8bc7f6a91f4f33890230f84a172ee61ccc https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux.zip /ffmpeg.zip
RUN mkdir -p /ms-playwright && unzip -q /shell.zip -d /ms-playwright/chromium_headless_shell-1243 \
 && unzip -q /ffmpeg.zip -d /ms-playwright/ffmpeg-1011 \
 && touch /ms-playwright/chromium_headless_shell-1243/INSTALLATION_COMPLETE /ms-playwright/ffmpeg-1011/INSTALLATION_COMPLETE

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u1 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ADD --chmod=755 --checksum=sha256:aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64 /usr/local/bin/kind
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
ADD --chmod=644 --checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88 https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar /opt/tla/tla2tools.jar
RUN npm install --global @openai/codex@0.156.0 && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2=1.2.8-1+b1 libatk-bridge2.0-0=2.46.0-5 libatk1.0-0=2.46.0-5 libatspi2.0-0=2.46.0-5 libcairo2=1.16.0-7 \
    libcups2=2.4.2-3+deb12u9 libdbus-1-3=1.14.10-1~deb12u1 libdrm2=2.4.114-1+b1 libgbm1=22.3.6-1+deb12u2 libglib2.0-0=2.74.6-2+deb12u9 \
    libnspr4=2:4.35-1 libnss3=2:3.87.1-1+deb12u4 libpango-1.0-0=1.50.12+ds-1 libx11-6=2:1.8.4-2+deb12u2 libxcb1=1.15-1 \
    libxcomposite1=1:0.4.5-1 libxdamage1=1:1.1.6-1 libxext6=2:1.3.4-1+b1 libxfixes3=1:6.0.0-2 libxkbcommon0=1.5.0-1 \
    libxrandr2=2:1.5.2-2+b1 libfontconfig1=2.14.1-4 libfreetype6=2.12.1+dfsg-5+deb12u4 fonts-liberation=1:1.07.4-11 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=browser /ms-playwright /opt/ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
WORKDIR /repo

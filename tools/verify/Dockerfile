ARG NODE_IMAGE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

FROM eclipse-temurin:21-jre-noble@sha256:7739f0ffce786528961eea6bf46d9610ee968ac6127c9b2e93494757bdecce9f AS java

FROM ${NODE_IMAGE} AS docker-cli
ADD --checksum=sha256:d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70 https://download.docker.com/linux/static/stable/x86_64/docker-29.8.1.tgz /docker.tgz
RUN tar -xzf /docker.tgz --no-same-owner --strip-components=1 -C /usr/local/bin docker/docker

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 ca-certificates=20250419~deb12u1 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ADD --chmod=755 --checksum=sha256:aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64 /usr/local/bin/kind
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
ADD --chmod=644 --checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88 https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar /opt/tla/tla2tools.jar
WORKDIR /repo

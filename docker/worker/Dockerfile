FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── 1. System packages + language runtimes ──────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ \
    openjdk-17-jdk-headless \
    python3 \
    ca-certificates curl gnupg \
    unzip bash time \
    make git pkg-config libcap-dev libsystemd-dev \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Node.js 20 (app runtime) ────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── 3. TypeScript compiler ──────────────────────────────────────────────────
RUN npm install -g typescript

# ── 4. Compile and install isolate (binaries only, skip man pages) ─────────
RUN git clone --depth 1 https://github.com/ioi/isolate.git /tmp/isolate \
    && cd /tmp/isolate \
    && make isolate isolate-cg-keeper \
    && cp isolate isolate-cg-keeper /usr/local/bin/ \
    && chmod 4755 /usr/local/bin/isolate \
    && rm -rf /tmp/isolate \
    && mkdir -p /usr/local/etc \
    && printf 'box_root=/var/local/lib/isolate\ncg_root=/sys/fs/cgroup\nfirst_uid=60000\nfirst_gid=60000\nnum_boxes=1000\n' \
       > /usr/local/etc/isolate

# ── 5. Create runner user (for non-isolate fallback) ───────────────────────
RUN useradd -m -u 1001 -s /bin/bash runner

# ── 6. Application setup ───────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/

EXPOSE 3000

CMD ["node", "src/index.js"]

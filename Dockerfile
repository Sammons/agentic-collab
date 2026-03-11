FROM node:24-slim

# curl is needed for HEALTHCHECK (node:24-slim includes it)
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy source (no build step needed, Node 24 runs .ts natively)
COPY src/ src/
COPY package.json .

# Resolve git commit SHA from build context so the version handshake works
# even when COMMIT_SHA isn't explicitly passed (i.e., raw `docker compose up --build`).
# .git/HEAD is either a raw SHA or "ref: refs/heads/<branch>".
COPY .git/HEAD .git/HEAD
COPY .git/refs/ .git/refs/
RUN COMMIT_SHA_RESOLVED="$(cat .git/HEAD)"; \
    if echo "$COMMIT_SHA_RESOLVED" | grep -q '^ref:'; then \
      REF_PATH="$(echo "$COMMIT_SHA_RESOLVED" | sed 's/^ref: //')"; \
      if [ -f ".git/$REF_PATH" ]; then \
        COMMIT_SHA_RESOLVED="$(cat ".git/$REF_PATH")"; \
      fi; \
    fi; \
    echo "${COMMIT_SHA_RESOLVED}" | cut -c1-7 > /app/.build-version; \
    rm -rf .git

# Data directory for SQLite — writable by any UID (container runs as host user via docker-compose user:)
RUN mkdir -p /data/.agentic-collab && chmod 777 /data/.agentic-collab

ARG COMMIT_SHA=
ENV COMMIT_SHA=${COMMIT_SHA}
ENV PORT=3000
ENV DB_PATH=/data/.agentic-collab/orchestrator.db
ENV HOME=/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:${PORT}/api/orchestrator/status || exit 1

CMD ["node", "src/orchestrator/main.ts"]

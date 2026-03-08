FROM node:24-slim

# curl is needed for HEALTHCHECK (node:24-slim includes it)
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy source (no build step needed, Node 24 runs .ts natively)
COPY src/ src/
COPY package.json .

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

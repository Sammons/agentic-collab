FROM node:24-slim

WORKDIR /app

# Copy source (no build step needed, Node 24 runs .ts natively)
COPY src/ src/
COPY package.json .

# Data directory for SQLite
RUN mkdir -p /data/.agentic-collab

ENV PORT=3000
ENV DB_PATH=/data/.agentic-collab/orchestrator.db
ENV HOME=/data

EXPOSE 3000

CMD ["node", "src/orchestrator/main.ts"]

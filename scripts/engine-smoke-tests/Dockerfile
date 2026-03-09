# Lightweight container for running engine smoke tests in isolation.
#
# The container provides: tmux, bash, clean env (no CLAUDECODE).
# The host provides: CLI binaries, auth, config — via bind mounts and PATH.
#
# Build:  docker build -t engine-smoke-tests scripts/engine-smoke-tests/
# Run:    bash scripts/engine-smoke-tests/run-docker.sh
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux bash sed grep uuid-runtime ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Match host UID so bind-mounted files are readable
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN if getent passwd ${HOST_UID} >/dev/null; then \
      existing=$(getent passwd ${HOST_UID} | cut -d: -f1); \
      usermod -d /home/smoketest -m "$existing" 2>/dev/null; \
      usermod -l smoketest "$existing" 2>/dev/null; \
    else \
      groupadd -g ${HOST_GID} smoketest 2>/dev/null || true; \
      useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash smoketest; \
    fi \
    && mkdir -p /home/smoketest && chown ${HOST_UID}:${HOST_GID} /home/smoketest

USER ${HOST_UID}
WORKDIR /tmp
ENTRYPOINT ["bash", "/smoke-tests/run-all.sh"]

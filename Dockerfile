# AgentKitAuto hosted Fargate worker image.
#
# ── BUILD CONTEXT (IMPORTANT) ────────────────────────────────────────────────
# `@agentkitforge/auto-core` depends on `@agentkitforge/gateway-core` via a
# `file:../agentkitgateway-core` link — a SIBLING repo. A build context of just
# `agentkitauto-core` CANNOT see that sibling, so this Dockerfile is written to
# build from the PARENT workspace dir that contains BOTH repos:
#
#     <workspaceRoot>/
#       ├── agentkitauto-core/        (this repo; Dockerfile lives here)
#       └── agentkitgateway-core/     (the file: dependency)
#
# Build it like this (note: context is the PARENT, -f points at this file):
#
#     docker build -f agentkitauto-core/Dockerfile -t agentkitauto-worker \
#       /Users/jag8765/ws/agentkit
#
# A `.dockerignore` at the auto-core root only takes effect when the context is
# auto-core itself; since the context here is the parent, the operator may also
# want a workspace-root `.dockerignore` to keep the context small (node_modules,
# dist, .git of both repos). This Dockerfile does its own cleanup regardless.
#
# Do NOT bake any secrets — runtime config (RUN_ID, AUTO_* tables, resolve URL +
# service key, ANTHROPIC_API_KEY, AWS creds) is injected by ECS at task launch.
# AWS access uses the task ROLE (default credential chain), never static keys.
# ─────────────────────────────────────────────────────────────────────────────

# ---- Builder stage: compile gateway-core, then auto-core --------------------
FROM node:22-slim AS builder
WORKDIR /workspace

# Build the file: dependency first (auto-core's install resolves it locally).
COPY agentkitgateway-core/ ./agentkitgateway-core/
WORKDIR /workspace/agentkitgateway-core
RUN npm ci && npm run build

# Build auto-core (its `file:../agentkitgateway-core` now resolves to the sibling).
WORKDIR /workspace
COPY agentkitauto-core/ ./agentkitauto-core/
WORKDIR /workspace/agentkitauto-core
RUN npm ci && npm run build

# Prune to production deps for the runtime stage.
RUN npm prune --omit=dev

# ---- Runtime stage: dist + production node_modules only ---------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Phase D (hardened isolation): install `gosu`, a tiny privilege-drop tool. The
# hosted Fargate task runs with a READ-ONLY root filesystem; the only writable
# path is a scratch volume mounted at /scratch, but Fargate mounts volumes
# ROOT-owned. Since the final worker process runs as non-root `node`, the
# container must (a) start as root, (b) chown the scratch mount to node, then
# (c) exec the node app AS node. `gosu` performs that final clean drop (no
# lingering setuid-root, none of su's TTY/signal quirks). See docker-entrypoint.sh.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends gosu; \
    rm -rf /var/lib/apt/lists/*; \
    gosu nobody true

# gateway-core is a file: dependency; auto-core's node_modules contains a symlink
# (or copy) to it, so we ship both build outputs to satisfy the link at runtime.
COPY --from=builder /workspace/agentkitgateway-core/dist ./agentkitgateway-core/dist
COPY --from=builder /workspace/agentkitgateway-core/package.json ./agentkitgateway-core/package.json
COPY --from=builder /workspace/agentkitgateway-core/node_modules ./agentkitgateway-core/node_modules

COPY --from=builder /workspace/agentkitauto-core/dist ./agentkitauto-core/dist
COPY --from=builder /workspace/agentkitauto-core/package.json ./agentkitauto-core/package.json
COPY --from=builder /workspace/agentkitauto-core/node_modules ./agentkitauto-core/node_modules

WORKDIR /app/agentkitauto-core

# Phase D (hardened isolation): entrypoint that makes the root-owned scratch
# mount writable by `node`, then drops privileges to `node` for the worker.
COPY agentkitauto-core/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# IMPORTANT: the container starts as ROOT (no `USER node` here) so the entrypoint
# can chown the Fargate-mounted scratch volume. The entrypoint then EXECs the
# worker via `gosu node`, so the LONG-LIVED worker process is NON-ROOT. Combined
# with the task-def's readonlyRootFilesystem + dropped ALL caps, the final
# process is unprivileged, capability-less, and runs on an immutable rootfs;
# only the momentary chown step is root. Do NOT add `USER node` above this line —
# that would start PID 1 as node and break the chown of the root-owned mount.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# The compiled Fargate task main (exec'd as node by the entrypoint).
CMD ["node", "dist/entrypoints/run-task.js"]

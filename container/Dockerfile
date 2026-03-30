# EJClaw Reviewer Container
# Runs Claude/Codex agent in read-only isolated environment for code review.
# Build from project root: docker build -f container/Dockerfile -t ejclaw-reviewer:latest .

FROM node:22-slim

# System dependencies — verification/review tools included
RUN apt-get update --fix-missing && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    curl \
    git \
    # Media
    ffmpeg \
    sox \
    mediainfo \
    imagemagick \
    # Build
    make \
    gcc \
    g++ \
    python3 \
    python3-pip \
    # Utils
    jq \
    file \
    sqlite3 \
    rsync \
    zip \
    unzip \
    strace \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Chromium paths for Playwright/agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install Claude Code and Codex CLI globally (requires Node.js)
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Install Bun runtime (EJClaw runner uses bun:sqlite and runs via bun)
ENV BUN_INSTALL="/usr/local"
RUN curl -fsSL https://bun.sh/install | bash

# Create app directory
WORKDIR /app

# Copy host's agent-runner (same code, same SDK version)
COPY runners/agent-runner/package*.json ./
RUN bun install
COPY runners/agent-runner/ ./
RUN bun run build

# Create workspace directories
RUN mkdir -p /workspace/project /workspace/group /workspace/global \
    /workspace/ipc/messages /workspace/ipc/input

# Create entrypoint script
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nbun /app/dist/index.js < /tmp/input.json\n' \
    > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root)
RUN chown -R node:node /workspace /home/node

# Switch to non-root user
USER node

# Working directory is the read-only project mount
WORKDIR /workspace/project

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

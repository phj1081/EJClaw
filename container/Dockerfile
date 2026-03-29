# EJClaw Reviewer Container
# Runs Claude/Codex agent in read-only isolated environment for code review.

FROM node:22-slim

# System dependencies for Chromium (E2E tests, screenshots)
RUN apt-get update --fix-missing && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Chromium paths for Playwright/agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install Claude Code and Codex CLI globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Create app directory
WORKDIR /app

# Copy and install agent runner
COPY agent-runner/package*.json ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/project /workspace/group /workspace/global \
    /workspace/ipc/messages /workspace/ipc/input

# Create entrypoint script
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' \
    > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root)
RUN chown -R node:node /workspace /home/node

# Switch to non-root user
USER node

# Working directory is the read-only project mount
WORKDIR /workspace/project

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

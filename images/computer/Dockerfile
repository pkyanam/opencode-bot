# Cloudflare Sandbox image. Keep its /container-server entrypoint: Sandbox
# uses that process for exec/startProcess/containerFetch. The runner is started
# as a child process by the Sandbox Durable Object on RUNNER_PORT.
FROM docker.io/cloudflare/sandbox:0.12.9

ENV NODE_ENV=production \
    NODE_VERSION=24.8.0 \
    RUNTIME_ROOT=/workspace/state \
    WORKSPACE_DIRECTORY=/workspace/shared \
    RUNNER_PORT=8787 \
    RUNNER_HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    OPENCODE_BOT_BROWSER=1 \
    OPENCODE_BOT_DESKTOP=1 \
    OPENCODE_BOT_CDP_ENDPOINT=http://127.0.0.1:9222 \
    DISPLAY=:99

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 ca-certificates curl xz-utils xvfb fluxbox x11-apps imagemagick xdotool xclip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace/state /workspace/shared /workspace/browser /opt/opencode-bot

# Sandbox 0.12.9 currently ships Node 22. Install the pinned Node 24 runtime
# required by this image while preserving the Sandbox container entrypoint.
RUN arch=x64 \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz \
  && tar -xJf /tmp/node.tar.xz -C /opt \
  && ln -sf "/opt/node-v${NODE_VERSION}-linux-${arch}/bin/node" /usr/local/bin/node \
  && ln -sf "/opt/node-v${NODE_VERSION}-linux-${arch}/bin/npm" /usr/local/bin/npm \
  && ln -sf "/opt/node-v${NODE_VERSION}-linux-${arch}/bin/npx" /usr/local/bin/npx \
  && rm /tmp/node.tar.xz

WORKDIR /opt/opencode-bot
COPY runner/package.json runner/package-lock.json* ./runner/
COPY packages/runtime-opencode2/package.json ./packages/runtime-opencode2/
RUN cd runner && npm_config_ignore_scripts=false npm ci --omit=dev --include=optional \
  && npm_config_ignore_scripts=false npm rebuild @opencode/cli \
  && npx playwright install --with-deps chromium \
  && test -x /opt/opencode-bot/runner/node_modules/@opencode/cli-linux-x64/bin/opencode \
  && test -x /opt/opencode-bot/runner/node_modules/.bin/playwright-mcp \
  && ln -sf /opt/opencode-bot/runner/node_modules/@opencode/cli-linux-x64/bin/opencode /usr/local/bin/opencode \
  && ln -sf /opt/opencode-bot/runner/node_modules/.bin/playwright-mcp /usr/local/bin/playwright-mcp \
  && ln -s /opt/opencode-bot/runner/node_modules /opt/opencode-bot/node_modules
COPY runner ./runner
COPY packages/runtime-opencode2 ./packages/runtime-opencode2
COPY packages/browser ./packages/browser

# 3000 belongs to the Sandbox container server. The application runner is
# reached through startProcess/containerFetch on 8787.
EXPOSE 8787

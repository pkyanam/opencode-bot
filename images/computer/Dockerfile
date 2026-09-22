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
  && apt-get install -y --no-install-recommends git python3 python3-pip libgssapi-krb5-2 ca-certificates curl xz-utils xvfb fluxbox x11-apps imagemagick ffmpeg xdotool xclip \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace/state /workspace/shared /workspace/browser /opt/opencode-bot \
  && useradd --create-home --home-dir /workspace/state/hindsight-home --shell /usr/sbin/nologin hindsight \
  && chown -R hindsight:hindsight /workspace/state

# Hindsight is the complete upstream memory engine.  Its embedded pg0 store is
# intentionally only a disposable projection; the Worker registry remains the
# authoritative source and can rebuild this instance after a replacement.
# Keep the package and ML dependencies pinned so an image rebuild is reviewable.
# Sandbox is Ubuntu 22.04 with Python 3.10. Hindsight requires Python >=3.11;
# isolate it from system Python instead of replacing Sandbox dependencies.
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN python3 -m pip install --no-cache-dir 'uv==0.8.22' \
  && uv python install 3.11.13 \
  && uv venv --python 3.11.13 /opt/hindsight-venv \
  && uv pip install --no-cache --python /opt/hindsight-venv/bin/python \
      'hindsight-api-slim[embedded-db,local-onnx]==0.10.1' \
      'flashrank==0.2.10'
ENV PATH=/opt/hindsight-venv/bin:$PATH

# Bake the exact default CPU models into the image so first memory use does
# not depend on Hugging Face availability.  Hindsight's FlashRank provider
# uses its own compact cross-encoder model; the embedder is 384-dimensional.
ENV HF_HOME=/opt/huggingface
ENV HINDSIGHT_RUN_AS_USER=hindsight
ENV HINDSIGHT_PG0_LAUNCHER=/opt/opencode-bot/runner/hindsight-launcher.py
RUN python3 -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='intfloat/multilingual-e5-small', local_dir='/opt/huggingface/intfloat-multilingual-e5-small', allow_patterns=['onnx/model.onnx', '*.json', 'tokenizer*', 'sentencepiece.bpe.model']); from flashrank import Ranker; Ranker(model_name='ms-marco-MiniLM-L-12-v2', cache_dir='/opt/flashrank')"
RUN chown -R hindsight:hindsight /opt/huggingface /opt/flashrank

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
# The headed browser is required by the desktop and browser MCP. The Chromium
# headless shell is a separate download and is never launched.
RUN cd runner && npm_config_ignore_scripts=false npm ci --omit=dev --include=optional \
  && npm_config_ignore_scripts=false npm rebuild @opencode/cli \
  && npx playwright install --with-deps --no-shell chromium \
  && test -x /opt/opencode-bot/runner/node_modules/@opencode/cli-linux-x64/bin/opencode \
  && test -x /opt/opencode-bot/runner/node_modules/.bin/playwright-mcp \
  && ln -sf /opt/opencode-bot/runner/node_modules/@opencode/cli-linux-x64/bin/opencode /usr/local/bin/opencode \
  && ln -sf /opt/opencode-bot/runner/node_modules/.bin/playwright-mcp /usr/local/bin/playwright-mcp \
  && ln -s /opt/opencode-bot/runner/node_modules /opt/opencode-bot/node_modules \
  && rm -rf /var/lib/apt/lists/* \
  && npm cache clean --force \
  && rm -rf /tmp/*
RUN npm install --global --prefix /usr/local wrangler@4.135.0 && npm cache clean --force
COPY skills ./skills
COPY docs ./docs
COPY README.md SECURITY.md ./
COPY runner ./runner
RUN chmod 0755 /opt/opencode-bot/runner/hindsight-launcher.py
COPY packages/runtime-opencode2 ./packages/runtime-opencode2
COPY packages/browser ./packages/browser

# 3000 belongs to the Sandbox container server. The application runner is
# reached through startProcess/containerFetch on 8787.
EXPOSE 8787
EXPOSE 8790

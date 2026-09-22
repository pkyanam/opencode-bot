FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm libgssapi-krb5-2 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --home-dir /workspace/state/hindsight-home --shell /usr/sbin/nologin hindsight && mkdir -p /workspace/state && chown -R hindsight:hindsight /workspace/state
RUN pip install --no-cache-dir 'hindsight-api-slim[embedded-db,local-onnx]==0.10.1'
RUN pip install --no-cache-dir 'flashrank==0.2.10'
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download(repo_id='intfloat/multilingual-e5-small', local_dir='/opt/huggingface/intfloat-multilingual-e5-small', allow_patterns=['onnx/model.onnx', '*.json', 'tokenizer*', 'sentencepiece.bpe.model']); from flashrank import Ranker; Ranker(model_name='ms-marco-MiniLM-L-12-v2', cache_dir='/opt/flashrank')"
RUN chown -R hindsight:hindsight /opt/huggingface /opt/flashrank
WORKDIR /opt/test
COPY runner/hindsight-service.mjs /opt/test/hindsight-service.mjs
COPY runner/hindsight-launcher.py /opt/test/hindsight-launcher.py
RUN chmod 0755 /opt/test/hindsight-launcher.py
ENV HINDSIGHT_API_EMBEDDINGS_PROVIDER=onnx \
    HINDSIGHT_API_DATABASE_URL=pg0 \
    HINDSIGHT_RUN_AS_USER=hindsight \
    HINDSIGHT_PG0_LAUNCHER=/opt/test/hindsight-launcher.py \
    HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH=/opt/huggingface/intfloat-multilingual-e5-small/onnx/model.onnx \
    HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH=/opt/huggingface/intfloat-multilingual-e5-small \
    HINDSIGHT_API_RERANKER_PROVIDER=rrf \
    HINDSIGHT_API_LLM_PROVIDER=openai \
    HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:9998/v1 \
    HINDSIGHT_API_LLM_API_KEY=test \
    HINDSIGHT_API_LLM_MODEL=test \
    RUNNER_TOKEN=test-token \
    HINDSIGHT_SERVICE_PORT=8790
EXPOSE 8790
CMD ["node", "/opt/test/hindsight-service.mjs"]

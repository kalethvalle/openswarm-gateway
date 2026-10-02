FROM python:3.11-slim
WORKDIR /app
COPY requirements-laya.txt .
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir -r requirements-laya.txt
RUN useradd --create-home --uid 10001 laya && mkdir -p /home/laya/.cache/huggingface && chown -R laya:laya /home/laya/.cache
USER laya
ENV HF_HOME=/home/laya/.cache/huggingface LAYA_DEVICE=cpu LAYA_MODELS=multilingual LAYA_DEFAULT_MODEL=multilingual LAYA_PRELOAD=1 LAYA_THREADS=2 LAYA_PORT=8001 LAYA_REVISION=reviewed TORCH_DISABLE_NATIVE_JIT=1
EXPOSE 8001
CMD ["laya-serve"]

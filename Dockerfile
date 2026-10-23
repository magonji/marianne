# Marianne en un contenedor: docker compose up -d  (ver README, "Con Docker")
FROM python:3.12-slim

# tzdata: las horas ("hoy", "desde las 12:32"...) se calculan en la zona de TZ.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.26 /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    TZ=Europe/London

WORKDIR /app

# Primero solo las dependencias, para que cambiar el código no las vuelva a instalar.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY README.md ./
COPY src ./src
RUN uv sync --locked --no-dev

RUN useradd --system --uid 1000 marianne
USER marianne

EXPOSE 8080
# La configuración se monta en /config/config.yaml.
CMD ["marianne", "--config", "/config/config.yaml", "--host", "0.0.0.0", "--port", "8080"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/layout', timeout=4)"

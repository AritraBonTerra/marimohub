FROM ghcr.io/astral-sh/uv:0.11.8 AS uv
FROM python:3.13-slim@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb
WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev && useradd --no-create-home --uid 10001 dashboard
COPY gateway.py /app/
COPY release /release
ENV HOME=/tmp MARIMO_SKIP_UPDATE_CHECK=1 PYTHONDONTWRITEBYTECODE=1
USER 10001
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "gateway:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--ws-max-size", "1048576"]

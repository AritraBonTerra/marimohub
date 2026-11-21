FROM ghcr.io/astral-sh/uv:0.11.8@sha256:3b7b60a81d3c57ef471703e5c83fd4aaa33abcd403596fb22ab07db85ae91347 AS uv
# `base` is the curated runtime that managed releases append a /release layer to.
FROM python:3.13-slim@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb AS base
WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
# Root owns /app and /release; the gateway refuses a release its own user could change.
RUN uv sync --locked --no-dev && useradd --no-create-home --uid 10001 dashboard \
	&& install -d -m 0555 /release
COPY gateway.py /app/
ENV HOME=/tmp MARIMO_SKIP_UPDATE_CHECK=1 PYTHONDONTWRITEBYTECODE=1
# JSON array of the installed distributions; the hub refuses notebooks that need others.
ARG INSTALLED_PACKAGES=""
LABEL io.marimohub.installed-packages=$INSTALLED_PACKAGES
USER 10001
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "gateway:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--ws-max-size", "1048576"]

FROM base
# Manual releases are copied as root. The gateway refuses world-writable files.
COPY --chown=0:0 release /release

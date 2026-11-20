FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --disable-pip-version-check --no-cache-dir -r requirements.txt

RUN useradd --no-create-home --uid 10001 --user-group ease
COPY --chown=ease:ease ease_api ./ease_api
USER ease

EXPOSE 8000
CMD ["uvicorn", "ease_api.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

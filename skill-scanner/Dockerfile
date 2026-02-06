FROM python:3.12-slim

RUN pip install --no-cache-dir cisco-ai-skill-scanner

RUN useradd -m -u 1000 scanner
USER scanner

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

ENTRYPOINT ["skill-scanner-api", "--host", "0.0.0.0", "--port", "8000"]

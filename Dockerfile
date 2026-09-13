# chess-review: static review UI + on-demand Stockfish analysis, stdlib server on :8123.
# State lives in /app/data (mount it). Build: docker compose build   Run: docker compose up -d
FROM python:3.12-slim

# avx2 runs on any x86-64 CPU from 2013 on; bmi2 is ~10% faster on Intel / AMD Zen3+.
ARG SF_BUILD=x86-64-avx2
ARG SF_TAG=sf_18

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates     && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN curl -sSL -o /tmp/sf.tar "https://github.com/official-stockfish/Stockfish/releases/download/${SF_TAG}/stockfish-ubuntu-${SF_BUILD}.tar"     && mkdir -p bin && tar -xf /tmp/sf.tar -C /tmp     && mv "/tmp/stockfish/stockfish-ubuntu-${SF_BUILD}" bin/stockfish && chmod +x bin/stockfish && rm -rf /tmp/sf.tar /tmp/stockfish

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY chess_review chess_review
COPY scripts scripts
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh scripts/*.sh

ENV STOCKFISH=/app/bin/stockfish CHESS_REVIEW_DATA=/app/data PYTHONUNBUFFERED=1
VOLUME /app/data
EXPOSE 8123
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "chess_review", "serve", "--host", "0.0.0.0", "--port", "8123"]

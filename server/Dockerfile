FROM node:20-bookworm-slim

# Audio preprocessing (same filter chain as the old audio-cleaner service)
# Debian/glibc base (not alpine) — claude-code ships native binaries (e.g. ripgrep)
# built against glibc; musl-based alpine fails with "exec format error" at spawn time.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# LLM CLI — selected at build time via --build-arg LLM_CLI=<choice>
ARG LLM_CLI=claude
RUN case "$LLM_CLI" in \
      claude) npm install -g @anthropic-ai/claude-code ;; \
      gemini) npm install -g @google/gemini-cli ;; \
      codex)  npm install -g @openai/codex ;; \
      none|custom|api) echo "No LLM CLI to install." ;; \
      *) echo "Unknown LLM_CLI: $LLM_CLI" && exit 1 ;; \
    esac

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# PECHPECH_HOST=0.0.0.0 is safe here because docker-compose maps the host
# port to 127.0.0.1 only: ports: ["127.0.0.1:3456:3456"]
ENV PECHPECH_HOST=0.0.0.0
ENV PECHPECH_PORT=3456
ENV DATA_DIR=/app/data

EXPOSE 3456
CMD ["node", "src/server.js"]

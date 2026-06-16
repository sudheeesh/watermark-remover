# Watermark Remover backend — lean image for Render's free tier.
# ffmpeg engines only (delogo / removelogo). The LaMa AI engine is disabled
# here because PyTorch needs ~4 GB RAM, which the free tier (512 MB) can't give.
FROM node:20-bookworm-slim

# ffmpeg powers the delogo / removelogo engines + frame extraction.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The AI (LaMa) engine is opt-in via ENABLE_LAMA and stays OFF here — this image
# has no Python/torch, and the free tier (512 MB) can't host PyTorch (~4 GB) anyway.

# Node deps (cached separately from source).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Render injects $PORT (server.js reads it); EXPOSE is documentation only.
EXPOSE 5200
CMD ["node", "server.js"]

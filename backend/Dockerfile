# Watermark Remover backend — Node API + ffmpeg + Python(LaMa) in one image.
FROM node:20-bookworm-slim

# System deps:
#   ffmpeg            -> delogo / removelogo engines + LaMa frame I/O
#   python3 + venv    -> the LaMa inpainting worker
#   libgl1 libglib2.0 -> runtime libs OpenCV needs
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 python3-venv python3-pip \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Isolated Python env (Debian's system pip is externally-managed / PEP 668).
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
# server.js / removal.js spawn `process.env.PYTHON || "python"` — point at the venv.
ENV PYTHON="$VIRTUAL_ENV/bin/python"

WORKDIR /app

# Python deps. Install the CPU-only torch build FIRST so simple-lama-inpainting
# doesn't drag in the multi-GB CUDA wheel.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt

# Bake the LaMa model weights into the image. Otherwise they download on the
# first request — and again on every cold start, since the disk is ephemeral.
RUN python -c "from simple_lama_inpainting import SimpleLama; SimpleLama()"

# Node deps (cached separately from source).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Render injects $PORT (server.js reads it); EXPOSE is documentation only.
EXPOSE 5200
CMD ["node", "server.js"]

FROM node:20-slim

# Outils de base + Python pour que Claude puisse generer/executer des scripts
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    ripgrep \
    jq \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Rien ne persiste a l'execution : toute dependance doit etre ajoutee ici.
RUN pip3 install --no-cache-dir --break-system-packages \
    requests \
    pandas \
    numpy

# Version figee : un rebuild dans plusieurs mois ne doit pas installer une
# version differente sans prevenir. Verifier le changelog avant de bumper.
RUN npm install -g @anthropic-ai/claude-code@2.1.273

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server

# Ne rien installer dans /root : monte en tmpfs, donc masque a l'execution.
EXPOSE 8787
CMD ["node", "server/server.js"]

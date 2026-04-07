# =============================================
# FILE: ts-cloud/Dockerfile
# PURPOSE: Lightweight Cloud Run container for ts-cloud
# =============================================
FROM node:24-slim

# Install system dependencies (SSL for Turso/External APIs)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the bundled Cloud Run server output and chunks
COPY dist/cloudrun/ ./

# Expose the port Cloud Run expects
EXPOSE 3000
ENV PORT=3000

# Run the server
CMD ["node", "server.js"]

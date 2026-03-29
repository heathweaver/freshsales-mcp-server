# HTTP-based Freshsales MCP Server with Docker deployment
FROM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json .

# Install dependencies, ignoring scripts to skip "prepare"
RUN npm install --ignore-scripts

# Copy the rest of the application code
COPY src ./src
COPY tsconfig.json .

# Build the project
RUN npm run build

# Use a smaller Node.js image for the runtime
FROM node:22-alpine AS release

# Set working directory
WORKDIR /app

# Copy the built files and node_modules from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .
COPY --from=builder /app/package-lock.json .

# Create persistent data directory for OAuth state
RUN mkdir -p /app/data

# Install production dependencies
RUN npm ci --omit=dev

# Install cloudflared
RUN wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O cloudflared && \
    chmod +x cloudflared && \
    mv cloudflared /usr/local/bin/

# Add health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "console.log('OK')" || exit 1

# Copy cloudflared startup script
COPY cloudflared.sh /usr/local/bin/cloudflared.sh
RUN chmod +x /usr/local/bin/cloudflared.sh

# Expose the port that the server listens to
EXPOSE 8768

# Start cloudflared (if certs exist) and the node server
CMD ["/bin/sh", "-c", "/usr/local/bin/cloudflared.sh; node dist/index.js"]

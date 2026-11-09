# Bitfunded Trading Cockpit (test build). No npm dependencies: Node's built-in SQLite, HTTP and WebSocket.
FROM node:22-bookworm-slim
ENV NODE_ENV=production NODE_NO_WARNINGS=1 PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY server/ /app/
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV KEYHOLE_DATA_DIR=/data PORT=8080 NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "src/server.ts"]

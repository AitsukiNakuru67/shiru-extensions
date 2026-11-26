FROM node:22-alpine
WORKDIR /app
COPY package.json index.json index.d.ts ./
COPY sources ./sources
COPY src ./src
COPY server ./server
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server/local-index.mjs"]

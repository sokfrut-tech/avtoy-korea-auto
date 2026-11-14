FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node storage ./storage
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

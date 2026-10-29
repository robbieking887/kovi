FROM node:22-slim
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY web/ /app/web/
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]

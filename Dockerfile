FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
USER node
EXPOSE 3000
CMD ["node", "bin/server.js"]

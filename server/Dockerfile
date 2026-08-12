# Dev-mode image: runs the same `nodemon` dev workflow as local development,
# with server/src bind-mounted by docker-compose for hot reload.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci

COPY server ./server

USER node

EXPOSE 4000

CMD ["npm", "run", "dev", "-w", "server"]

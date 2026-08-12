# Dev-mode image: runs the Vite dev server with HMR, matching local `npm run dev`.
# client/src is bind-mounted by docker-compose for hot reload.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci

COPY client ./client

# Vite's ESM config loader writes a transient bundled-config file next to
# vite.config.js at startup, so only this dir (not node_modules or package.json)
# needs to be writable by the non-root runtime user.
RUN chown -R node:node /app/client

USER node

EXPOSE 5173

CMD ["npm", "run", "dev", "-w", "client", "--", "--host", "0.0.0.0"]

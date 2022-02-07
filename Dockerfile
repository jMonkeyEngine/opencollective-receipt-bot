FROM node:16

RUN mkdir -p /app/
WORKDIR /app

COPY package*.json  /app/
COPY *.js  /app/
RUN cd /app&&npm ci --only=production&&chown 1000:1000 -Rf /app

USER node

CMD [ "node", "/app/main.js" ]

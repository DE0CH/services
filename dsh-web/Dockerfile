# The persistent dsh web UI (k8s/dsh-web/dsh-web.yaml). Build context = this directory (.github/workflows/dsh-web.yml).
# No dependencies (Node's standard library only); the tests run in the build.
FROM node:22-bookworm-slim
COPY package.json /app/
COPY lib /app/lib
COPY test /app/test
RUN cd /app && node --test test/server.test.js
USER 65532:65532
WORKDIR /app
CMD ["node", "/app/lib/server.js"]

FROM node:22-alpine

# The watermark needs a real font file. Without one, fillText draws nothing
# and pages would ship unwatermarked — the renderer refuses to start rather
# than let that happen silently (§4.1).
RUN apk add --no-cache font-dejavu

WORKDIR /app

# Full install first: the client build needs vite, which is a devDependency.
# (Installing --omit=dev here and then calling vite fails with exit 127, and
# only appears to work if the host's node_modules leaks in through COPY.)
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run web:build

# Drop the build-time dependencies now that dist/ exists.
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV WATERMARK_FONT=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf
EXPOSE 3000

# The source folder must be mounted read-only:
#   -v /srv/service-records:/srv/service-records:ro
CMD ["node", "--experimental-strip-types", "src/server.ts"]

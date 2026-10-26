FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/schema/package.json packages/schema/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/app/package.json packages/app/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages ./packages
COPY tsconfig.json ./
RUN bun run build:web
# Bundle dependencies so the runtime needs no workspace or node_modules tree.
RUN bun build packages/app/src/index.ts --target=bun --outfile=/runtime/packages/app/src/index.ts

FROM oven/bun:1.4.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
COPY --from=build /runtime/packages/app/src/index.ts ./packages/app/src/index.ts
COPY --from=build /app/packages/app/dist ./packages/app/dist
USER bun
VOLUME ["/data"]
EXPOSE 3000 3001
CMD ["bun", "packages/app/src/index.ts"]

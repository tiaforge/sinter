# The RealWorld example with its data in the page: the app built with SINTER_EMBED=1, served by sinter-axum's example
# server (packages/sinter-axum/examples/realworld.rs), which fetches each page's API data and writes it into the HTML.
#
#   docker run --rm -p 8080:8080 ghcr.io/tiaforge/sinter-realworld
#   docker build -f examples/realworld/Dockerfile -t sinter-realworld .      (from the repository's root)
#
# Environment: PORT (8080), HOST (0.0.0.0) and API (https://api.realworld.show: the origin the app's build names, which the
# server allows and fetches from; the browser calls it too).

# 1. sinter, then the app (SINTER_EMBED=1: the build describes each page's data for the server)
FROM node:24-bookworm-slim AS app
WORKDIR /repo
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY packages/sinter-markdown ./packages/sinter-markdown
COPY examples/realworld ./examples/realworld
RUN npm ci --ignore-scripts && npm run build
WORKDIR /repo/examples/realworld
# `file:` dependencies linked, not copied: the build must use the sinter just built
RUN npm ci --install-links=false && SINTER_EMBED=1 npx vite build

# 2. the server: one static binary (musl, on Alpine's Rust, whichever architecture the build runs on). examples/realworld/server
# builds sinter-axum's example with only the dependencies it runs on (`cargo build --example` would add the crate's dev-dependencies)
FROM rust:1-alpine AS server
# cmake, make, g++, perl: rustls's crypto library; ca-certificates: the bundle the final image takes
RUN apk add --no-cache musl-dev cmake make g++ perl ca-certificates
WORKDIR /src
COPY packages/sinter-axum ./packages/sinter-axum
COPY examples/realworld/server ./examples/realworld/server
WORKDIR /src/examples/realworld/server
ENV CARGO_PROFILE_RELEASE_STRIP=symbols
RUN cargo build --release --locked

# 3. nothing but the binary, the app's files and the certificates the server's HTTPS requests to the API need
FROM scratch
COPY --from=server /src/examples/realworld/server/target/release/realworld /realworld
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=app /repo/examples/realworld/dist /srv/realworld
ENV HOST=0.0.0.0 PORT=8080 API=https://api.realworld.show SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/realworld", "/srv/realworld"]

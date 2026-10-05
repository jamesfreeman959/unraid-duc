# Builds a fully static x86_64 duc binary suitable for Unraid (Slackware based).
#
#   docker buildx build --platform linux/amd64 -f build/Dockerfile --output out .
#
# The result is written to out/duc.

FROM alpine:3.22 AS build

ARG DUC_VERSION=1.4.6
ARG DUC_SHA256=e91592e367f3f8be671899660756b25e2c37f316c42ebd2a36dd684be3e2f25a
ARG TC_VERSION=1.4.48
ARG TC_SHA256=a003f47c39a91e22d76bc4fe68b9b3de0f38851b160bbb1ca07a4f6441de1f90

RUN apk add --no-cache build-base curl patch pkgconf \
      zlib-dev zlib-static bzip2-dev bzip2-static \
      ncurses-dev ncurses-static

WORKDIR /src

# Tokyo Cabinet (duc's default backend) is not packaged by Alpine, so build it
# statically from the Debian source mirror.
RUN curl -fsSL -o tc.tar.gz \
      https://deb.debian.org/debian/pool/main/t/tokyocabinet/tokyocabinet_${TC_VERSION}.orig.tar.gz \
 && echo "${TC_SHA256}  tc.tar.gz" | sha256sum -c - \
 && tar xzf tc.tar.gz \
 && cd tokyocabinet-${TC_VERSION} \
 && ./configure --prefix=/usr/local \
 && make -j"$(nproc)" libtokyocabinet.a tokyocabinet.pc \
 && mkdir -p /usr/local/lib/pkgconfig /usr/local/include \
 && cp libtokyocabinet.a /usr/local/lib/ \
 && cp tcutil.h tchdb.h tcbdb.h tcfdb.h tctdb.h tcadb.h /usr/local/include/ \
 && install -D -m 644 tokyocabinet.pc /usr/local/lib/pkgconfig/tokyocabinet.pc

COPY patches /patches

RUN curl -fsSL -o duc.tar.gz \
      https://github.com/zevv/duc/releases/download/${DUC_VERSION}/duc-${DUC_VERSION}.tar.gz \
 && echo "${DUC_SHA256}  duc.tar.gz" | sha256sum -c - \
 && tar xzf duc.tar.gz \
 && cd duc-${DUC_VERSION} \
 && for p in /patches/*.patch; do patch -p1 < "$p"; done \
 && PKG_CONFIG="pkg-config --static" ./configure \
      --with-db-backend=tokyocabinet \
      --disable-cairo --disable-x11 --disable-opengl \
      LDFLAGS="-static" \
 && make -j"$(nproc)" \
 && strip duc \
 && ./duc --version \
 && file_out="$(readelf -d duc 2>&1 || true)" \
 && echo "$file_out" | grep -q "no dynamic section" \
 && install -D -m 755 duc /out/duc

FROM scratch
COPY --from=build /out/duc /duc

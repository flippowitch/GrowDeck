# Spider Farmer MQTT proxy from Schedule 4 Real (https://github.com/EddiePiazza/schedule-4-real).
# The binary is NOT part of GrowDeck. It is downloaded from the official public
# repository at a pinned commit while the image is built on your NAS.
FROM ubuntu:24.04

ARG S4R_COMMIT=9c8108435bfc207700cc19f22dd7354fe2573d7d
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/spiderproxy
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) file=spiderproxy ;; \
      arm64) file=spiderproxy-arm64 ;; \
      *) echo "Architektur ${TARGETARCH} wird vom spiderproxy nicht unterstützt" >&2; exit 1 ;; \
    esac; \
    mkdir -p proxy; \
    curl -fsSL -o proxy/spiderproxy \
      "https://raw.githubusercontent.com/EddiePiazza/schedule-4-real/${S4R_COMMIT}/schedule-4-real/proxy/${file}"; \
    chmod +x proxy/spiderproxy

# The proxy always connects to 127.0.0.1; only the port is configurable.
# docker-compose therefore runs it inside the network namespace of Mosquitto.
ENV MQTT_PORT=1883
CMD ["./proxy/spiderproxy"]

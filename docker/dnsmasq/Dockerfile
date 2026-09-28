# Optional DNS server that points sf.mqtt.spider-farmer.com to the NAS and
# forwards every other query to public resolvers.
FROM alpine:3.20
RUN apk add --no-cache dnsmasq
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 53/udp 53/tcp
ENTRYPOINT ["/entrypoint.sh"]

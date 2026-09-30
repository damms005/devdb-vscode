#!/usr/bin/env bash
# Generates a private CA + a server cert for the "neon-like" TLS Postgres.
# SANs: localhost, 127.0.0.1, and a fake Neon hostname (map it in /etc/hosts to exercise the .env Neon provider).
set -euo pipefail
cd "$(dirname "$0")"
[ -f server.crt ] && { echo "certs exist"; exit 0; }
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=DevDb Local Test CA" \
  -keyout ca.key -out ca.crt >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr >/dev/null 2>&1
cat > san.ext <<SAN
subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:ep-local-devdb-123456.us-east-2.aws.neon.tech,DNS:ep-local-devdb-123456-pooler.us-east-2.aws.neon.tech
extendedKeyUsage=serverAuth
SAN
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -extfile san.ext -out server.crt >/dev/null 2>&1
rm -f server.csr san.ext ca.srl
echo "certs generated in $(pwd)"

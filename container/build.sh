#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

PROXY_URL="http://192.168.64.1:8463"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Pass forward proxy so apt-get/pip/npm can reach the internet during build.
# The proxy must be running (start NanoClaw first, or run the proxy standalone).
# If the proxy is unavailable, build falls back to direct connections (works on Docker/Linux).
${CONTAINER_RUNTIME} build \
  --build-arg http_proxy="${PROXY_URL}" \
  --build-arg https_proxy="${PROXY_URL}" \
  -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"

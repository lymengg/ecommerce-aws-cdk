#!/usr/bin/env bash
#
# Builds the storefront image, pushes it, and rolls the ECS service that serves it.
#
# Usage:
#   ECOMMERCE_DEV_DOMAIN=dev.example.com ./scripts/deploy.sh dev
#
# The API's public origin is baked into the bundle at build time (the app is a static SPA, so there
# is no server to read runtime configuration from), which is why the environment has to be known
# here. The image itself is environment-agnostic: nginx renders its Content-Security-Policy from the
# API_ORIGIN the task definition passes it.
set -euo pipefail

ENVIRONMENT="${1:-dev}"
REGION="${AWS_REGION:-ap-southeast-1}"
EXPORT_PREFIX="ecommerce-${ENVIRONMENT}"
IMAGE_TAG="${IMAGE_TAG:-v0.1.0}"

case "$ENVIRONMENT" in
  dev) DOMAIN="${ECOMMERCE_DEV_DOMAIN:-}" ;;
  uat) DOMAIN="${ECOMMERCE_UAT_DOMAIN:-}" ;;
  prod) DOMAIN="${ECOMMERCE_PROD_DOMAIN:-}" ;;
  *) echo "Unknown environment '${ENVIRONMENT}'. Expected dev, uat or prod." >&2; exit 1 ;;
esac

if [[ -z "$DOMAIN" ]]; then
  echo "Set ECOMMERCE_${ENVIRONMENT^^}_DOMAIN to the delegated subdomain before deploying." >&2
  exit 1
fi

export_url() {
  aws cloudformation list-exports --region "$REGION" \
    --query "Exports[?Name=='${EXPORT_PREFIX}-$1'].Value" --output text
}

REPOSITORY="$(export_url ecr-frontend-repository-uri)"
CLUSTER="$(export_url ecs-cluster-name)"
SERVICE="$(export_url frontend-service-name)"

for value in "$REPOSITORY" "$CLUSTER" "$SERVICE"; do
  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "Could not find the ${EXPORT_PREFIX} exports. Deploy ecommerce-ecr-${ENVIRONMENT} and ecommerce-frontend-${ENVIRONMENT} first." >&2
    exit 1
  fi
done

echo "Building the storefront against https://api.${DOMAIN} ..."
docker build --build-arg "NUXT_PUBLIC_API_BASE_URL=https://api.${DOMAIN}" -t "ecommerce-frontend:${IMAGE_TAG}" .

echo "Pushing to ${REPOSITORY}:${IMAGE_TAG} ..."
REGISTRY="${REPOSITORY%%/*}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker tag "ecommerce-frontend:${IMAGE_TAG}" "${REPOSITORY}:${IMAGE_TAG}"
docker push "${REPOSITORY}:${IMAGE_TAG}"

# A task definition that names an immutable tag does not change when the tag is re-pushed, so the
# service is asked for a new deployment explicitly.
echo "Rolling ${SERVICE} ..."
aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"

echo "Deployed. Open https://${DOMAIN}"

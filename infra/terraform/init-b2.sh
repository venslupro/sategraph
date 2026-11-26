#!/usr/bin/env bash
set -euo pipefail

: "${B2_STATE_BUCKET:?缺少 B2 状态桶名称（不是桶 ID）}" "${B2_STATE_KEY:?缺少生产 state 的对象键}"
: "${B2_STATE_REGION:?缺少 B2 状态桶区域}" "${AWS_ACCESS_KEY_ID:?缺少 state 应用密钥 ID}" "${AWS_SECRET_ACCESS_KEY:?缺少 state 应用密钥}"
[[ "$B2_STATE_REGION" =~ ^[a-z0-9]+(-[a-z0-9]+)+$ ]] || { echo 'B2_STATE_REGION 必须是 B2 区域名，不是 URL' >&2; exit 1; }

cd -- "$(dirname -- "$0")"
exec terraform init -input=false \
  -backend-config="bucket=$B2_STATE_BUCKET" \
  -backend-config="key=$B2_STATE_KEY" \
  -backend-config="region=$B2_STATE_REGION" \
  -backend-config="endpoints={s3=\"https://s3.$B2_STATE_REGION.backblazeb2.com\"}"

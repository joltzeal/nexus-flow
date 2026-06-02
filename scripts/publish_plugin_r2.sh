#!/usr/bin/env sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  scripts/publish_plugin_r2.sh <plugin_dir> [version]

Example:
  R2_BUCKET=u-card-plugins \
  R2_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  PLUGIN_PUBLIC_BASE_URL=https://plugins.example.com/plugin-repo \
  scripts/publish_plugin_r2.sh backend/app/task_modules/uber 0.1.40

Required environment:
  R2_BUCKET                 Cloudflare R2 bucket name.

Optional environment:
  PLUGIN_R2_UPLOADER        auto, wrangler, or aws. Defaults to auto.
  R2_ACCOUNT_ID             Required by aws mode unless R2_ENDPOINT_URL is set.
  R2_ACCESS_KEY_ID          Required by aws mode unless AWS_ACCESS_KEY_ID is set.
  R2_SECRET_ACCESS_KEY      Required by aws mode unless AWS_SECRET_ACCESS_KEY is set.
  R2_ENDPOINT_URL           Defaults to https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
  PLUGIN_REPO_PREFIX        Defaults to plugin-repo
  PLUGIN_PUBLIC_BASE_URL    Public HTTP base URL for frontend downloads.
  PLUGIN_REPOSITORY_NAME    Defaults to default
  PLUGIN_DRY_RUN            Set to 1 to package and generate index without upload.
EOF
}

fail() {
  echo "publish_plugin_r2: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

PLUGIN_DIR=${1:-}
VERSION_ARG=${2:-}

[ -n "$PLUGIN_DIR" ] || {
  usage
  exit 2
}
[ -d "$PLUGIN_DIR" ] || fail "plugin directory not found: $PLUGIN_DIR"
[ -f "$PLUGIN_DIR/manifest.json" ] || fail "manifest.json not found in: $PLUGIN_DIR"

require_cmd python3
require_cmd zip
require_cmd shasum
require_cmd wc

R2_BUCKET=${R2_BUCKET:-}
R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-}
R2_ENDPOINT_URL=${R2_ENDPOINT_URL:-}
PLUGIN_R2_UPLOADER=${PLUGIN_R2_UPLOADER:-auto}
PLUGIN_REPO_PREFIX=${PLUGIN_REPO_PREFIX:-plugin-repo}
PLUGIN_PUBLIC_BASE_URL=${PLUGIN_PUBLIC_BASE_URL:-}
PLUGIN_REPOSITORY_NAME=${PLUGIN_REPOSITORY_NAME:-default}
PLUGIN_DRY_RUN=${PLUGIN_DRY_RUN:-0}

[ -n "$R2_BUCKET" ] || fail "R2_BUCKET is required"

if [ "$PLUGIN_DRY_RUN" = "1" ]; then
  PLUGIN_R2_UPLOADER=dry-run
elif [ "$PLUGIN_R2_UPLOADER" = "auto" ]; then
  if command -v aws >/dev/null 2>&1; then
    PLUGIN_R2_UPLOADER=aws
  elif command -v wrangler >/dev/null 2>&1; then
    PLUGIN_R2_UPLOADER=wrangler
  else
    fail "missing uploader: install aws CLI or wrangler"
  fi
fi

case "$PLUGIN_R2_UPLOADER" in
  aws)
    require_cmd aws
    if [ -z "$R2_ENDPOINT_URL" ]; then
      [ -n "$R2_ACCOUNT_ID" ] || fail "R2_ACCOUNT_ID or R2_ENDPOINT_URL is required in aws mode"
      R2_ENDPOINT_URL="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    fi
    export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-${R2_ACCESS_KEY_ID:-}}
    export AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-${R2_SECRET_ACCESS_KEY:-}}
    export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-auto}
    [ -n "$AWS_ACCESS_KEY_ID" ] || fail "R2_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID is required in aws mode"
    [ -n "$AWS_SECRET_ACCESS_KEY" ] || fail "R2_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY is required in aws mode"
    ;;
  wrangler)
    require_cmd wrangler
    ;;
  dry-run)
    ;;
  *)
    fail "PLUGIN_R2_UPLOADER must be auto, aws, wrangler, or dry-run"
    ;;
esac

r2_get() {
  object_key=$1
  local_path=$2
  case "$PLUGIN_R2_UPLOADER" in
    aws)
      aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp "s3://${R2_BUCKET}/${object_key}" "$local_path"
      ;;
    wrangler)
      wrangler r2 object get "${R2_BUCKET}/${object_key}" --file "$local_path" --remote
      ;;
    dry-run)
      return 1
      ;;
  esac
}

r2_put() {
  local_path=$1
  object_key=$2
  content_type=$3
  case "$PLUGIN_R2_UPLOADER" in
    aws)
      aws --endpoint-url "$R2_ENDPOINT_URL" s3 cp \
        "$local_path" \
        "s3://${R2_BUCKET}/${object_key}" \
        --content-type "$content_type"
      ;;
    wrangler)
      wrangler r2 object put "${R2_BUCKET}/${object_key}" \
        --file "$local_path" \
        --content-type "$content_type" \
        --remote
      ;;
    dry-run)
      echo "dry-run upload: ${local_path} -> s3://${R2_BUCKET}/${object_key} (${content_type})"
      ;;
  esac
}

PLUGIN_META=$(
  python3 - "$PLUGIN_DIR/manifest.json" "$VERSION_ARG" <<'PY'
import json
import shlex
import sys

manifest_path, version_arg = sys.argv[1], sys.argv[2]
with open(manifest_path, "r", encoding="utf-8") as fh:
    manifest = json.load(fh)

key = str(manifest.get("key") or "").strip()
name = str(manifest.get("name") or key).strip()
version = str(version_arg or manifest.get("version") or "").strip()
description = str(manifest.get("description") or "").strip()

if not key:
    raise SystemExit("manifest key is required")
if not version:
    raise SystemExit("version argument or manifest version is required")

for var, value in {
    "PLUGIN_KEY": key,
    "PLUGIN_NAME": name,
    "PLUGIN_VERSION": version,
    "PLUGIN_DESCRIPTION": description,
}.items():
    print(f"{var}={shlex.quote(value)}")
PY
)
eval "$PLUGIN_META"

ROOT_DIR=$(pwd)
PLUGIN_DIR_ABS=$(cd "$PLUGIN_DIR" && pwd)
PLUGIN_PARENT=$(dirname "$PLUGIN_DIR_ABS")
PLUGIN_ROOT=$(basename "$PLUGIN_DIR_ABS")
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/plugin-r2.XXXXXX")
ZIP_NAME="${PLUGIN_KEY}-${PLUGIN_VERSION}.plugin.zip"
ZIP_PATH="${WORK_DIR}/${ZIP_NAME}"
INDEX_PATH="${WORK_DIR}/index.json"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

echo "Packaging ${PLUGIN_KEY} ${PLUGIN_VERSION}..."
(
  cd "$PLUGIN_PARENT"
  zip -rq "$ZIP_PATH" "$PLUGIN_ROOT" \
    -x "${PLUGIN_ROOT}/__pycache__/*" \
    -x "${PLUGIN_ROOT}/.DS_Store" \
    -x "${PLUGIN_ROOT}/*.pyc" \
    -x "${PLUGIN_ROOT}/*/__pycache__/*"
)

SHA256=$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')
SIZE=$(wc -c < "$ZIP_PATH" | tr -d ' ')
OBJECT_FILE="${PLUGIN_REPO_PREFIX}/plugins/${PLUGIN_KEY}/${ZIP_NAME}"
INDEX_OBJECT="${PLUGIN_REPO_PREFIX}/index.json"

if [ -n "$PLUGIN_PUBLIC_BASE_URL" ]; then
  PUBLIC_BASE=$(printf "%s" "$PLUGIN_PUBLIC_BASE_URL" | sed 's:/*$::')
  PUBLIC_URL="${PUBLIC_BASE}/plugins/${PLUGIN_KEY}/${ZIP_NAME}"
else
  PUBLIC_URL=""
fi

echo "Downloading current index.json if it exists..."
if ! r2_get "$INDEX_OBJECT" "$INDEX_PATH" >/dev/null 2>&1; then
  printf '{"schema_version":1,"name":"%s","plugins":[]}\n' "$PLUGIN_REPOSITORY_NAME" > "$INDEX_PATH"
fi

python3 - "$INDEX_PATH" \
  "$PLUGIN_REPOSITORY_NAME" \
  "$PLUGIN_KEY" \
  "$PLUGIN_NAME" \
  "$PLUGIN_VERSION" \
  "$PLUGIN_DESCRIPTION" \
  "$OBJECT_FILE" \
  "$PUBLIC_URL" \
  "$SHA256" \
  "$SIZE" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone

(
    index_path,
    repo_name,
    key,
    name,
    version,
    description,
    file_path,
    url,
    sha256,
    size,
) = sys.argv[1:]

def version_key(value: str):
    parts = re.split(r"[^0-9A-Za-z]+", value)
    normalized = []
    for part in parts:
        if not part:
            continue
        normalized.append((0, int(part)) if part.isdigit() else (1, part))
    return normalized

try:
    with open(index_path, "r", encoding="utf-8") as fh:
        index = json.load(fh)
except Exception:
    index = {}

now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
index.setdefault("schema_version", 1)
index["name"] = index.get("name") or repo_name
index["updated_at"] = now
plugins = index.setdefault("plugins", [])

entry = {
    "key": key,
    "name": name,
    "version": version,
    "file": file_path,
    "url": url,
    "sha256": sha256,
    "size": int(size),
    "description": description,
    "updated_at": now,
}

plugin = next((item for item in plugins if item.get("key") == key), None)
if plugin is None:
    plugin = {"key": key, "name": name, "versions": []}
    plugins.append(plugin)

versions = plugin.setdefault("versions", [])
versions[:] = [item for item in versions if item.get("version") != version]
versions.append(dict(entry))
versions.sort(key=lambda item: version_key(str(item.get("version") or "")), reverse=True)

latest = versions[0]
plugin.update(latest)
plugin["versions"] = versions

plugins.sort(key=lambda item: str(item.get("key") or ""))

with open(index_path, "w", encoding="utf-8") as fh:
    json.dump(index, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

echo "Uploading plugin zip to R2..."
r2_put "$ZIP_PATH" "$OBJECT_FILE" application/zip

echo "Uploading index.json to R2..."
r2_put "$INDEX_PATH" "$INDEX_OBJECT" application/json

echo
echo "Published:"
echo "  plugin:  ${PLUGIN_KEY}"
echo "  version: ${PLUGIN_VERSION}"
echo "  object:  s3://${R2_BUCKET}/${OBJECT_FILE}"
echo "  index:   s3://${R2_BUCKET}/${INDEX_OBJECT}"
echo "  uploader:${PLUGIN_R2_UPLOADER}"
echo "  sha256:  ${SHA256}"
echo "  size:    ${SIZE}"
if [ -n "$PUBLIC_URL" ]; then
  echo "  url:     ${PUBLIC_URL}"
else
  echo "  url:     <not set; configure PLUGIN_PUBLIC_BASE_URL for frontend downloads>"
fi

cd "$ROOT_DIR"

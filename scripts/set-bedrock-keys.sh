#!/bin/bash
# Inject AWS Bedrock credentials into the Atlas Keychain (atlas-core/secrets-import).
# The app merges this on next launch — see secrets.rs load_or_migrate().
#
# Usage:
#   ./scripts/set-bedrock-keys.sh <ACCESS_KEY_ID> <SECRET_ACCESS_KEY>
#   ./scripts/set-bedrock-keys.sh   (prompts interactively)

set -euo pipefail

if [[ ${1:-} ]]; then
  KEY_ID="$1"
  SECRET="${2:?Usage: $0 <ACCESS_KEY_ID> <SECRET_ACCESS_KEY>}"
else
  read -rp "AWS_ACCESS_KEY_ID: " KEY_ID
  read -rsp "AWS_SECRET_ACCESS_KEY: " SECRET
  echo
fi

PAYLOAD=$(printf '{"aws_access_key_id":"%s","aws_secret_access_key":"%s","atlas_ai_provider":"bedrock"}' "$KEY_ID" "$SECRET")

/usr/bin/security delete-generic-password -s atlas-core -a secrets-import 2>/dev/null || true
/usr/bin/security add-generic-password -s atlas-core -a secrets-import -w "$PAYLOAD" -A -U

echo "Done — AWS credentials staged. Relaunch Atlas to activate Bedrock."

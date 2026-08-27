#!/bin/sh
set -eu

: "${MACOS_CERTIFICATE_BASE64:?MACOS_CERTIFICATE_BASE64 is required}"
: "${MACOS_CERTIFICATE_PASSWORD:?MACOS_CERTIFICATE_PASSWORD is required}"
: "${MACOS_SIGNING_IDENTITY:?MACOS_SIGNING_IDENTITY is required}"
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/sign-macos.sh <sheppard-executable>" >&2
  exit 2
fi

executable="$1"
if [ ! -x "${executable}" ]; then
  echo "The Sheppard executable does not exist: ${executable}" >&2
  exit 1
fi

temporary_directory="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sheppard-sign.XXXXXX")"
keychain_path="${temporary_directory}/signing.keychain-db"
keychain_password="sheppard-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
certificate_path="${temporary_directory}/certificate.p12"
notary_archive="${temporary_directory}/sheppard-notary.zip"
trap 'security delete-keychain "${keychain_path}" >/dev/null 2>&1 || true; rm -rf "${temporary_directory}"' EXIT HUP INT TERM

printf '%s' "${MACOS_CERTIFICATE_BASE64}" | /usr/bin/base64 -D > "${certificate_path}"
security create-keychain -p "${keychain_password}" "${keychain_path}"
security set-keychain-settings -lut 21600 "${keychain_path}"
security unlock-keychain -p "${keychain_password}" "${keychain_path}"
security import "${certificate_path}" -P "${MACOS_CERTIFICATE_PASSWORD}" -A -t cert -f pkcs12 -k "${keychain_path}"
security list-keychain -d user -s "${keychain_path}"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${keychain_password}" "${keychain_path}"

codesign \
  --entitlements packaging/macos-entitlements.plist \
  --force \
  --options runtime \
  --sign "${MACOS_SIGNING_IDENTITY}" \
  --timestamp \
  "${executable}"
codesign --strict --verbose=2 --verify "${executable}"

ditto -c -k --keepParent "${executable}" "${notary_archive}"
xcrun notarytool submit "${notary_archive}" \
  --apple-id "${APPLE_ID}" \
  --password "${APPLE_APP_PASSWORD}" \
  --team-id "${APPLE_TEAM_ID}" \
  --wait


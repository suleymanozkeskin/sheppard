#!/bin/sh
set -eu

REPOSITORY="suleymanozkeskin/sheppard"
INSTALL_DIRECTORY="${SHEPPARD_INSTALL_DIR:-${HOME}/.local/bin}"
REQUESTED_VERSION="${SHEPPARD_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) operating_system="darwin" ;;
  Linux) operating_system="linux" ;;
  *)
    echo "Sheppard supports macOS and Linux." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) architecture="arm64" ;;
  x86_64|amd64) architecture="x64" ;;
  *)
    echo "Sheppard supports arm64 and x64 processors." >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install Sheppard." >&2
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required to install Sheppard." >&2
  exit 1
fi

archive_name="sheppard-${operating_system}-${architecture}.tar.gz"
case "${REQUESTED_VERSION}" in
  latest) release_root="https://github.com/${REPOSITORY}/releases/latest/download" ;;
  v*) release_root="https://github.com/${REPOSITORY}/releases/download/${REQUESTED_VERSION}" ;;
  *) release_root="https://github.com/${REPOSITORY}/releases/download/v${REQUESTED_VERSION}" ;;
esac
release_root="${SHEPPARD_RELEASE_ROOT:-${release_root}}"

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/sheppard-install.XXXXXX")"
trap 'rm -rf "${temporary_directory}"' EXIT HUP INT TERM

archive_path="${temporary_directory}/${archive_name}"
checksums_path="${temporary_directory}/checksums.txt"
curl --fail --location --silent --show-error "${release_root}/${archive_name}" --output "${archive_path}"
curl --fail --location --silent --show-error "${release_root}/checksums.txt" --output "${checksums_path}"

expected_checksum="$(awk -v file="${archive_name}" '$2 == file || $2 == "*" file { print $1; exit }' "${checksums_path}")"
if [ -z "${expected_checksum}" ]; then
  echo "checksums.txt does not contain ${archive_name}." >&2
  exit 1
fi

case "${operating_system}" in
  darwin) actual_checksum="$(shasum -a 256 "${archive_path}" | awk '{ print $1 }')" ;;
  linux)
    if ! command -v sha256sum >/dev/null 2>&1; then
      echo "sha256sum is required to verify Sheppard on Linux." >&2
      exit 1
    fi
    actual_checksum="$(sha256sum "${archive_path}" | awk '{ print $1 }')"
    ;;
esac

if [ "${actual_checksum}" != "${expected_checksum}" ]; then
  echo "Checksum verification failed for ${archive_name}." >&2
  exit 1
fi

extracted_directory="${temporary_directory}/release"
mkdir -p "${extracted_directory}"
tar -xzf "${archive_path}" -C "${extracted_directory}"

if [ ! -x "${extracted_directory}/sheppard" ] || [ ! -x "${extracted_directory}/msgr" ]; then
  echo "The release archive does not contain the required commands." >&2
  exit 1
fi

"${extracted_directory}/sheppard" --version >/dev/null
mkdir -p "${INSTALL_DIRECTORY}"

staged_sheppard="${INSTALL_DIRECTORY}/.sheppard-install.$$"
staged_msgr="${INSTALL_DIRECTORY}/.msgr-install.$$"
cp "${extracted_directory}/sheppard" "${staged_sheppard}"
cp "${extracted_directory}/msgr" "${staged_msgr}"
chmod 755 "${staged_sheppard}" "${staged_msgr}"
mv -f "${staged_sheppard}" "${INSTALL_DIRECTORY}/sheppard"
mv -f "${staged_msgr}" "${INSTALL_DIRECTORY}/msgr"

echo "Installed $("${INSTALL_DIRECTORY}/sheppard" --version) in ${INSTALL_DIRECTORY}."
case ":${PATH}:" in
  *":${INSTALL_DIRECTORY}:"*) ;;
  *)
    echo "Add ${INSTALL_DIRECTORY} to PATH, then run: sheppard"
    ;;
esac

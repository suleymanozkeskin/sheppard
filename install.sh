#!/bin/sh
set -eu

REPOSITORY="suleymanozkeskin/sheppard"
INSTALL_DIRECTORY="${SHEPPARD_INSTALL_DIR:-${HOME}/.local/bin}"
REQUESTED_VERSION="${SHEPPARD_VERSION:-latest}"
PATH_LINK_LIMIT=8

physical_path() {
  (
    current="$1"
    step=0
    while [ -L "${current}" ]; do
      step=$((step + 1))
      if [ "${step}" -gt "${PATH_LINK_LIMIT}" ]; then
        break
      fi
      target="$(readlink "${current}")"
      case "${target}" in
        /*) current="${target}" ;;
        *)
          directory="$(dirname "${current}")"
          current="$(CDPATH= cd "${directory}" && pwd)/${target}"
          ;;
      esac
    done
    directory="$(dirname "${current}")"
    if [ -d "${directory}" ]; then
      current="$(CDPATH= cd "${directory}" && pwd)/$(basename "${current}")"
    fi
    printf '%s\n' "${current}"
  )
}

resolved_command() {
  command -v "$1" 2>/dev/null || true
}

same_command() {
  [ "$(physical_path "$1")" = "$(physical_path "$2")" ]
}

sheppard_version_line() {
  case "$1" in
    "sheppard "[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

point_command_at() {
  link_path="$1"
  target="$2"
  if same_command "${link_path}" "${target}"; then
    return 0
  fi
  link_directory="$(dirname "${link_path}")"
  if [ ! -w "${link_directory}" ]; then
    echo "Sheppard could not replace ${link_path}." >&2
    return 1
  fi
  ln -sfn "${target}" "${link_path}" || return 1
}

adopt_earlier_commands() {
  install_directory="$1"
  installed_sheppard="${install_directory}/sheppard"
  installed_msgr="${install_directory}/msgr"
  step=0
  while [ "${step}" -lt "${PATH_LINK_LIMIT}" ]; do
    step=$((step + 1))
    resolved_sheppard="$(resolved_command sheppard)"
    if [ -z "${resolved_sheppard}" ] || same_command "${resolved_sheppard}" "${installed_sheppard}"; then
      return 0
    fi
    version_line="$("${resolved_sheppard}" --version 2>/dev/null || true)"
    if ! sheppard_version_line "${version_line}"; then
      return 0
    fi
    shadow_directory="$(dirname "${resolved_sheppard}")"
    point_command_at "${resolved_sheppard}" "${installed_sheppard}" || return 1
    if [ -e "${shadow_directory}/msgr" ] || [ -L "${shadow_directory}/msgr" ]; then
      point_command_at "${shadow_directory}/msgr" "${installed_msgr}" || return 1
    fi
  done
}

stop_running_sheppard() {
  install_directory="$1"
  stop_status=0
  stop_output="$("${install_directory}/sheppard" stop 2>&1)" || stop_status=$?
  if [ "${stop_output}" = "Sheppard is not running." ]; then
    return 0
  fi
  printf '%s\n' "${stop_output}"
  return "${stop_status}"
}

report_install_commands() {
  install_directory="$1"
  installed_sheppard="${install_directory}/sheppard"
  installed_msgr="${install_directory}/msgr"
  blocking_directory=""

  resolved_sheppard="$(resolved_command sheppard)"
  if [ -z "${resolved_sheppard}" ]; then
    printf 'Add %s to PATH, then run: sheppard\n' "${install_directory}"
  elif [ "$(physical_path "${resolved_sheppard}")" != "$(physical_path "${installed_sheppard}")" ]; then
    printf 'The command sheppard runs %s.\n' "${resolved_sheppard}"
    version_line="$("${resolved_sheppard}" --version 2>/dev/null || true)"
    if [ -n "${version_line}" ]; then
      printf 'That command reports %s.\n' "${version_line}"
    fi
    blocking_directory="$(dirname "${resolved_sheppard}")"
  fi

  resolved_msgr="$(resolved_command msgr)"
  if [ -n "${resolved_msgr}" ] && [ "$(physical_path "${resolved_msgr}")" != "$(physical_path "${installed_msgr}")" ]; then
    printf 'The command msgr runs %s.\n' "${resolved_msgr}"
    if [ -z "${blocking_directory}" ]; then
      blocking_directory="$(dirname "${resolved_msgr}")"
    fi
  fi

  if [ -n "${blocking_directory}" ]; then
    printf 'Run %s.\n' "${installed_sheppard}"
    printf 'Put %s before %s on PATH.\n' "${install_directory}" "${blocking_directory}"
  fi
}

if [ "${SHEPPARD_INSTALL_PATH_CHECK:-}" = "1" ]; then
  adopt_earlier_commands "${INSTALL_DIRECTORY}"
  report_install_commands "${INSTALL_DIRECTORY}"
  exit 0
fi

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
adopt_earlier_commands "${INSTALL_DIRECTORY}" || true
stop_running_sheppard "${INSTALL_DIRECTORY}" || true
report_install_commands "${INSTALL_DIRECTORY}"

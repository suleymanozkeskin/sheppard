# Releasing Sheppard

GitHub Releases are the source for standalone archives. The direct installer and `sheppard update` download from the latest published release. Homebrew and npm are optional distribution adapters.

## Release requirements

Complete these items before the first public release:

- Make the repository public.
- Keep the MIT license in `LICENSE` and `package.json`.
- Configure macOS Developer ID signing and notarization.
- Confirm that the `sheppard` npm name and Homebrew tap are owned by the maintainer.

The release preflight stops when `LICENSE` is absent. It also requires the tag to match the version in `package.json`.

Add these GitHub Actions secrets before a release:

- `MACOS_CERTIFICATE_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `MACOS_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_PASSWORD`
- `APPLE_TEAM_ID`

The certificate secret contains the base64 form of the Developer ID Application `.p12` file. The workflow stops instead of creating unsigned macOS archives when any signing value is absent.

## Build an archive locally

Install both dependency sets:

```sh
bun install --frozen-lockfile
bun install --cwd web --frozen-lockfile
```

Build one target:

```sh
bun run build:release --target darwin-arm64
```

Valid targets are:

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`

The command builds the Vite application, embeds every file from `web/dist`, compiles one standalone executable, and creates `release/sheppard-<target>.tar.gz`. Each archive contains the commands, the agent skill, the product documents, the screenshots, and `LICENSE`.

## Create a draft release

Set the version in `package.json`. Commit the release state before creating the tag.

```sh
git tag v0.1.0
git push origin v0.1.0
```

The Release workflow performs these operations:

1. Check that the tag matches the package version.
2. Check that `LICENSE` exists.
3. Run lint, server tests, web tests, and browser tests.
4. Build on native macOS and Linux runners for both CPU architectures.
5. Check the compiled `--version` command, the `msgr` wrapper, and standalone uninstall behavior.
6. Create SHA-256 checksums.
7. Create a draft GitHub Release.

Inspect every draft asset and release note before publication. Publishing the draft makes it available to `install.sh` and `sheppard update`.

## Asset contract

Do not change these asset names without updating both `install.sh` and `src/distribution.ts`:

```text
sheppard-darwin-arm64.tar.gz
sheppard-darwin-x64.tar.gz
sheppard-linux-arm64.tar.gz
sheppard-linux-x64.tar.gz
checksums.txt
```

`checksums.txt` uses the standard `<sha256>  <filename>` format.

## npm package

The npm package is an optional source distribution for users who already have Bun. Review its contents before publication:

```sh
npm pack --dry-run
npm publish
```

The first npm publication permanently reserves the package name and version. Do not publish until the public repository, license, and release documentation are correct.

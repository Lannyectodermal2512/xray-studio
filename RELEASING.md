# Releasing

One command. Everything else is automatic.

```bash
scripts/release.sh 0.2.0
```

That is the whole procedure. The rest of this file is what it does and what to do when
it stops you.

## What happens

1. **`scripts/release.sh 0.2.0`** checks the release is worth making, sets the version
   in `package.json` and `app/package.json`, commits, creates the annotated tag `v0.2.0`
   and pushes both.
2. **Pushing the tag starts the release workflow.** It builds on macOS, Windows and
   Linux in parallel, and each runner builds the sidecar for *every* target — so a break
   on a platform you are not releasing still fails the build that introduced it.
3. **The workflow creates a draft release** with the installers attached and this
   version's `CHANGELOG.md` section as the body.
4. **You publish it.** Nothing is downloadable until you open the draft, look at the
   files and press Publish. That is the only manual step, and it is manual on purpose.

Roughly fifteen minutes from command to draft.

## Before you run it

Write the `CHANGELOG.md` section first. The script refuses without one, because that
section becomes the release page — a release whose notes say nothing is a release nobody
can decide whether to install.

```markdown
## 0.2.0

One or two sentences on what this release is for.

### Fixed

- What was broken, and what it did to you when it was broken.
```

Add the section, commit it, then run the script.

## Choosing the number

[Semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`, no leading `v` — the
script adds that for the tag.

| | |
|---|---|
| `0.2.1` | fixes only |
| `0.3.0` | new capability, or a change in how something already behaves |
| `1.0.0` | the formats and interfaces are ones you are prepared to keep |
| `0.3.0-beta.1` | a prerelease. GitHub files it under *Pre-release* and leaves *Latest* on the last stable build, so a first-time visitor is not handed a beta |

A version is never reused. Once a tag is pushed, someone may have downloaded what it
pointed at, so the fix for a bad release is the next number — not a moved tag.

## What the script refuses, and why

Each of these is something that has to be true for the tag to mean what it says. A tag
is the one part of the process that cannot be quietly corrected afterwards.

| It says | Do this |
|---|---|
| `tag v0.2.0 already exists` | use the next number; released versions are immutable |
| `on 'x'; releases are cut from main` | `git switch main` |
| `working tree is dirty` | commit or stash — otherwise the tag would not describe what you built |
| `main is behind origin` | `git pull` |
| `add a '## 0.2.0' section to CHANGELOG.md` | write the notes |
| `the xray-core checkout drifted from xray/PIN` | `scripts/bootstrap-xray.sh` |
| `tests failed — nothing was tagged` | fix them; nothing was changed |

To see whether a release would go through without doing anything:

```bash
DRY_RUN=1 scripts/release.sh 0.2.0
```

## If the build fails after tagging

The tag exists but no release was published, so nothing is public yet.

1. Read the failure at `Actions → release`.
2. Fix it on `main`.
3. Delete the tag and cut the same version again — it was never released, so the number
   is still free:

```bash
git push --delete origin v0.2.0 && git tag -d v0.2.0
```

If a draft release was created before the failure, delete that too, or `release.sh` will
be creating a release that already exists.

## What each artefact is

| file | for |
|---|---|
| `XrayStudio-<v>-macos-universal.dmg` | macOS, Intel and Apple Silicon in one build |
| `XrayStudio-<v>-win-x64.zip` | Windows, portable. The one most people want |
| `XrayStudio-<v>-win-arm64.zip` | Windows on ARM, native |
| `XrayStudio-<v>-linux-<arch>.pkg.tar.zst` | Arch Linux, `pacman -U` |
| `XrayStudio-<v>-linux-<arch>.AppImage` | every other Linux — no install, no dependency resolution |
| `XrayStudio-<v>-src.tar.gz` | the sources this release was built from, from `git archive` at the tag |
| `*.blockmap` | not for downloading. Chunk hashes a future updater uses to fetch only what changed |

The workflow fails the build if any of those is missing, rather than publishing a
release that looks complete because the files it does have are the ones people check.

`src.tar.gz` is also how the release satisfies MPL-2.0 for the patched Xray-core: the
patched tree is *reproducible* from `xray/PIN` and `xray/patches/`, not merely available.

## Signing

Nothing is signed. macOS users clear the quarantine flag once and Windows warns about an
unknown publisher; both are in the README so nobody has to guess whether the download is
broken.

Changing that means an Apple Developer account and a Windows code-signing certificate,
their secrets in the repository settings, and signing steps in the workflow. Worth doing
before asking people who do not know you to run this.

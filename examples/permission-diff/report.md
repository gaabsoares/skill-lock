# skill-lock diff

Comparing `examples/permission-diff/before.lock` to `examples/permission-diff/after.lock`.

## Permission additions (4)

New capability an extension did not previously declare. Review before accepting the update.

| Extension | Axis | Added |
| --- | --- | --- |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `config:github.token` |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `config:github.username` |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `env:GITHUB_TOKEN` |
| `clawhub:conorkenn/openclaw-github-assistant@1.0.2` | secrets | `env:GITHUB_USERNAME` |

## Summary

- entries added: 0
- entries removed: 0
- entries changed: 1
- entries unchanged: 0
- permission additions: 4
- high severity changes: 4

## Changes by extension

### clawhub:conorkenn/openclaw-github-assistant@1.0.1 to clawhub:conorkenn/openclaw-github-assistant@1.0.2

Status: changed (clawhub)

- [high] **permission added** (secrets): `config:github.token`
- [high] **permission added** (secrets): `config:github.username`
- [high] **permission added** (secrets): `env:GITHUB_TOKEN`
- [high] **permission added** (secrets): `env:GITHUB_USERNAME`
- [medium] version: `1.0.1` to `1.0.2`
- [medium] digest changed: `sha256:f591ec9af05a74e85aaa8bf1bf41fe86ddb08a3c7ae5df4bcd7e031f2de93f18` to `sha256:5d41cebca6336a26bb468134742c01cec214ee72f1a20d230f5828e08abf9b26`
- [medium] manifest field `file_count`: `4` to `5`
- [medium] manifest field `openclaw_metadata_sha256`: `986ec53fb09b67fc219f76841eb37ca59a9a341f636a3d06c2ce9086ecab5deb` to `76208b237a33200810d52e5a4cb74ffba2e814b61dddee723563848473acf11c`
- [medium] manifest field `skill_md_sha256`: `c0c595879dceab5751d1f84ce33c7a2c2562f5b0b0ae0afdd227367be7a256e3` to `5ca3719ecf549de931b4f6ff6e31bcd6433a6daac2f20139c10ba708fd254318`
- [medium] manifest field `version`: `1.0.1` to `1.0.2`
- [info] secrets is now declared (was undeclared)
  - this axis had no declaration before

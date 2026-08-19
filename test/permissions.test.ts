import assert from "node:assert/strict";
import test from "node:test";
import { extractMcpPermissions } from "../src/manifests/mcp.ts";
import { parseOpenClawManifest } from "../src/manifests/openclaw.ts";
import { PermissionBuilder } from "../src/permissions.ts";

const skill = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# body\n`;

test("an untouched axis is null (undeclared), a touched empty axis is an empty list", () => {
  const permissions = new PermissionBuilder("m").touch("network").build();
  assert.deepEqual(permissions.network, []);
  assert.equal(permissions.secrets, null);
  assert.equal(permissions.status, "declared");
});

test("a builder with nothing touched reports undeclared and a null manifest", () => {
  const permissions = new PermissionBuilder("m").build();
  assert.equal(permissions.status, "undeclared");
  assert.equal(permissions.manifest, null);
});

test("openclaw requires blocks map onto secrets and exec", () => {
  const { permissions } = parseOpenClawManifest(
    skill(`name: demo
metadata:
  openclaw:
    requires:
      env:
        - OPENAI_API_KEY
        - OTHER_KEY
      bins:
        - curl
        - jq
      plugins:
        - memory-lancedb`),
    "SKILL.md",
  );
  assert.deepEqual(permissions.secrets, ["env:OPENAI_API_KEY", "env:OTHER_KEY"]);
  assert.deepEqual(permissions.exec, ["bin:curl", "bin:jq", "plugin:memory-lancedb"]);
  assert.equal(permissions.filesystem, null, "no install block means filesystem is undeclared");
  assert.equal(permissions.manifest, "SKILL.md:metadata.openclaw");
});

test("the pre-rename clawdbot metadata key is read, not treated as undeclared", () => {
  const { permissions } = parseOpenClawManifest(
    skill(`name: demo
metadata:
  clawdbot:
    requires:
      env:
        - OPENAI_API_KEY`),
    "SKILL.md",
  );
  assert.equal(permissions.status, "declared");
  assert.deepEqual(permissions.secrets, ["env:OPENAI_API_KEY"]);
  assert.equal(permissions.manifest, "SKILL.md:metadata.clawdbot");
});

test("install steps split into network, filesystem and exec", () => {
  const { permissions } = parseOpenClawManifest(
    skill(`name: demo
metadata:
  openclaw:
    install:
      - kind: download
        url: "https://example.com/tool.tar.gz"
        targetDir: ~/.local/bin
        bins: [tool]`),
    "SKILL.md",
  );
  assert.deepEqual(permissions.network, ["url:https://example.com/tool.tar.gz"]);
  assert.deepEqual(permissions.filesystem, ["path:~/.local/bin"]);
  assert.deepEqual(permissions.exec, ["bin:tool", "install:download"]);
});

test("allowed-tools is recognised even without an openclaw block", () => {
  const { permissions } = parseOpenClawManifest(skill(`name: d\nallowed-tools: [Bash, Read]`), "SKILL.md");
  assert.deepEqual(permissions.exec, ["tool:Bash", "tool:Read"]);
  assert.equal(permissions.secrets, null);
});

test("a manifest that declares nothing is undeclared but records where we looked", () => {
  const { permissions } = parseOpenClawManifest(skill(`name: demo\ndescription: nothing declared`), "SKILL.md");
  assert.equal(permissions.status, "undeclared");
  assert.equal(permissions.manifest, "SKILL.md", "distinguishes 'read it, declares nothing' from 'no manifest'");
});

test("a file with no frontmatter at all has a null manifest", () => {
  const { permissions } = parseOpenClawManifest("# just markdown\n", "SKILL.md");
  assert.equal(permissions.status, "undeclared");
  assert.equal(permissions.manifest, null);
});

test("an unrecognised list shape is surfaced as a value, not dropped", () => {
  const { permissions, warnings } = parseOpenClawManifest(
    skill(`name: d
metadata:
  openclaw:
    requires:
      env:
        - {weird: shape}`),
    "SKILL.md",
  );
  assert.equal(warnings.length, 1);
  assert.equal(permissions.secrets?.length, 1);
  assert.match(permissions.secrets![0]!, /^unrecognized:requires\.env=/);
});

test("the metadata block digest changes when any field changes, including ones we do not model", () => {
  const a = parseOpenClawManifest(skill(`name: d\nmetadata:\n  openclaw:\n    emoji: "a"`), "SKILL.md");
  const b = parseOpenClawManifest(skill(`name: d\nmetadata:\n  openclaw:\n    emoji: "b"`), "SKILL.md");
  assert.notEqual(a.fields["openclaw_metadata_sha256"], b.fields["openclaw_metadata_sha256"]);
});

test("mcp env vars split by isSecret, and filesystem stays undeclared", () => {
  const { permissions } = extractMcpPermissions({
    name: "io.example/server",
    version: "1.0.0",
    packages: [
      {
        registryType: "npm",
        identifier: "example-server",
        version: "1.0.0",
        runtimeHint: "npx",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "API_KEY", isSecret: true },
          { name: "LOG_LEVEL" },
        ],
      },
    ],
  });
  assert.deepEqual(permissions.secrets, ["env:LOG_LEVEL", "secret:API_KEY"]);
  assert.deepEqual(permissions.exec, ["package:npm/example-server@1.0.0", "runtime:npx"]);
  assert.equal(
    permissions.filesystem,
    null,
    "the MCP server schema has no filesystem field, so it must read as undeclared",
  );
});

test("mcp remotes contribute urls and secret headers", () => {
  const { permissions } = extractMcpPermissions({
    name: "io.example/remote",
    version: "1.0.0",
    remotes: [
      {
        type: "streamable-http",
        url: "https://server.example.com/mcp",
        headers: [
          { name: "Authorization", isSecret: true },
          { name: "X-Trace" },
        ],
      },
    ],
  });
  assert.deepEqual(permissions.network, [
    "header:X-Trace",
    "transport:streamable-http",
    "url:https://server.example.com/mcp",
  ]);
  assert.deepEqual(permissions.secrets, ["header-secret:Authorization"]);
});

test("a server declaring neither packages nor remotes warns instead of reporting a clean bill", () => {
  const { permissions, warnings } = extractMcpPermissions({ name: "io.example/empty", version: "1.0.0" });
  assert.equal(permissions.status, "undeclared");
  assert.equal(warnings.length, 1);
});

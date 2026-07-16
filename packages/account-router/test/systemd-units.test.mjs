import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const systemdRoot = path.join(repositoryRoot, "systemd");
const serviceNames = [
  "codex-account-router.service",
  "codex-app-server.service",
  "codex-web.service",
];

function parseUnit(content) {
  const parsed = new Map();
  let section = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `invalid unit line: ${line}`);
    const key = `${section}.${line.slice(0, separator)}`;
    const values = parsed.get(key) ?? [];
    values.push(line.slice(separator + 1));
    parsed.set(key, values);
  }
  return parsed;
}

async function loadUnit(name) {
  const content = await fs.readFile(path.join(systemdRoot, name), "utf8");
  return { content, unit: parseUnit(content) };
}

function only(unit, key) {
  const values = unit.get(key);
  assert.equal(values?.length, 1, `${key} must appear exactly once`);
  return values[0];
}

test("services use one non-root identity and a common least-privilege baseline", async () => {
  const required = new Map([
    ["Service.User", "codex"],
    ["Service.Group", "codex"],
    ["Service.UMask", "0077"],
    ["Service.NoNewPrivileges", "true"],
    ["Service.PrivateTmp", "true"],
    ["Service.PrivateDevices", "true"],
    ["Service.ProtectSystem", "strict"],
    ["Service.ProtectHome", "true"],
    ["Service.ProtectKernelTunables", "true"],
    ["Service.ProtectKernelModules", "true"],
    ["Service.ProtectControlGroups", "true"],
    ["Service.ProtectClock", "true"],
    ["Service.RestrictSUIDSGID", "true"],
    ["Service.LockPersonality", "true"],
    ["Service.RestrictRealtime", "true"],
    ["Service.CapabilityBoundingSet", ""],
    ["Service.AmbientCapabilities", ""],
    ["Service.RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6"],
    ["Service.Restart", "on-failure"],
  ]);
  for (const name of serviceNames) {
    const { unit } = await loadUnit(name);
    for (const [key, value] of required) assert.equal(only(unit, key), value, `${name}: ${key}`);
    assert.match(only(unit, "Service.RestartSec"), /^[1-9][0-9]*s$/);
    assert.match(only(unit, "Service.TimeoutStopSec"), /^[1-9][0-9]*s$/);
  }
});

test("stack dependency topology permits every service to restart independently", async () => {
  for (const name of serviceNames) {
    const { unit } = await loadUnit(name);
    for (const key of ["Unit.Requires", "Unit.BindsTo", "Unit.PartOf", "Unit.PropagatesReloadTo", "Unit.PropagatesStopTo"]) {
      assert.equal(unit.has(key), false, `${name} must not set ${key}`);
    }
    assert.deepEqual(unit.get("Install.WantedBy"), ["codex-stack.target"]);
  }
  const { unit: target } = await loadUnit("codex-stack.target");
  assert.deepEqual(
    new Set(only(target, "Unit.Wants").split(/\s+/)),
    new Set(serviceNames),
  );
  assert.equal(only(target, "Install.WantedBy"), "multi-user.target");
});

test("router uses the M5.1 launcher, loopback listeners, and credential file paths", async () => {
  const { content, unit } = await loadUnit("codex-account-router.service");
  assert.equal(only(unit, "Service.ExecStart"), "/opt/codex-account-router/current/bin/codex-account-router");
  assert.equal(only(unit, "Service.WorkingDirectory"), "/var/lib/codex-account-router");
  assert.deepEqual(new Set(unit.get("Service.Environment")), new Set([
    "CODEX_ROUTER_ADMIN_HOST=127.0.0.1",
    "CODEX_ROUTER_ADMIN_PORT=18318",
    "CODEX_ROUTER_MODEL_HOST=127.0.0.1",
    "CODEX_ROUTER_MODEL_PORT=18317",
    "CODEX_ROUTER_ACCOUNTS_FILE=/etc/codex-account-router/accounts.json",
    "CODEX_ROUTER_CREDENTIAL_ROOT=%d",
    "CODEX_ROUTER_ADMIN_TOKEN_FILE=%d/admin-token",
  ]));
  assert.deepEqual(unit.get("Service.LoadCredential"), [
    "admin-token:/etc/codex-account-router/credentials/admin-token",
  ]);
  assert.deepEqual(unit.get("Service.ImportCredential"), ["codex-account-router.auth.*"]);
  assert.doesNotMatch(content, /0\.0\.0\.0|\[::\]|ws:\/\//);
});

test("App Server owns a private Unix socket and receives auth only as a credential file", async () => {
  const { content, unit } = await loadUnit("codex-app-server.service");
  const command = only(unit, "Service.ExecStart");
  assert.match(command, /^\/usr\/local\/bin\/codex /);
  assert.match(command, /openai_base_url=.*http:\/\/127\.0\.0\.1:18317\/backend-api\/codex/);
  assert.match(command, /app-server .*--listen unix:\/\/\/run\/codex-app-server\/app-server\.sock$/);
  assert.deepEqual(unit.get("Service.LoadCredential"), [
    "codex-auth:/etc/codex-account-router/credentials/app-server-auth.json",
  ]);
  assert.equal(only(unit, "Service.ExecStartPre"), "/usr/bin/ln -sfn %d/codex-auth /var/lib/codex-app-server/auth.json");
  assert.equal(only(unit, "Service.ExecStopPost"), "/usr/bin/rm -f /var/lib/codex-app-server/auth.json");
  assert.equal(only(unit, "Service.RuntimeDirectory"), "codex-app-server");
  assert.doesNotMatch(content, /0\.0\.0\.0|\[::\]|--listen (?:stdio|ws):/);
});

test("codex-web is loopback-only and proxies stdio to the supervised Unix socket", async () => {
  const { content, unit } = await loadUnit("codex-web.service");
  assert.equal(only(unit, "Service.ExecStart"), "/usr/bin/node /opt/codex-web/src/server/main.js --host 127.0.0.1 --port 8214");
  assert.deepEqual(new Set(unit.get("Service.Environment")), new Set([
    "HOME=/var/lib/codex-web",
    "CODEX_HOME=/var/lib/codex-web",
    "CODEX_CLI_PATH=/opt/codex-account-router/current/bin/codex-router-cli",
    "CODEX_REAL_CLI_PATH=/usr/local/bin/codex",
    "CODEX_APP_SERVER_SOCKET=/run/codex-app-server/app-server.sock",
    "CODEX_ROUTER_ADMIN_ORIGIN=http://127.0.0.1:18318",
    "CODEX_ROUTER_ADMIN_TOKEN_FILE=%d/router-admin-token",
  ]));
  assert.deepEqual(unit.get("Service.LoadCredential"), [
    "router-admin-token:/etc/codex-account-router/credentials/admin-token",
  ]);
  assert.doesNotMatch(content, /0\.0\.0\.0|\[::\]|ws:\/\//);
});

test("unit command lines and environments contain paths/configuration, never secret values", async () => {
  for (const name of serviceNames) {
    const { unit } = await loadUnit(name);
    const publicConfiguration = [
      ...(unit.get("Service.ExecStart") ?? []),
      ...(unit.get("Service.Environment") ?? []),
    ].join("\n");
    assert.doesNotMatch(publicConfiguration, /(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{12,})/i, name);
    for (const line of unit.get("Service.Environment") ?? []) {
      if (/(?:TOKEN|AUTH|CREDENTIAL)/.test(line)) {
        assert.match(line, /(?:_FILE=|_ROOT=)(?:%d(?:\/[^\s]+)?|\/[^\s]+)/, `${name}: ${line}`);
      }
    }
  }
});

test("provisioning files create only a locked service identity and private directories", async () => {
  const [sysusers, tmpfiles] = await Promise.all([
    fs.readFile(path.join(systemdRoot, "codex-stack.sysusers.conf"), "utf8"),
    fs.readFile(path.join(systemdRoot, "codex-stack.tmpfiles.conf"), "utf8"),
  ]);
  assert.equal(sysusers, 'u codex - "Codex service account" /nonexistent /usr/sbin/nologin\n');
  assert.equal(tmpfiles, [
    "d /etc/codex-account-router 0750 root codex -",
    "d /etc/codex-account-router/credentials 0700 root root -",
    "d /srv/codex-workspaces 0750 codex codex -",
    "",
  ].join("\n"));
  assert.doesNotMatch(`${sysusers}\n${tmpfiles}`, /(?:token|cookie|authorization|@)/i);
});

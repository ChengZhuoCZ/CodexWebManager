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

async function loadIsolatedUnit(name) {
  const content = await fs.readFile(path.join(systemdRoot, "8216-fixture", name), "utf8");
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
    ["Service.LimitCORE", "0"],
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
    "CODEX_ROUTER_STATE_DIRECTORY=/var/lib/codex-account-router",
    "CODEX_ROUTER_FAILOVER_MAX_ATTEMPTS=3",
    "CODEX_ROUTER_FAILOVER_TOTAL_DEADLINE_MS=120000",
    "CODEX_ROUTER_FAILOVER_BASE_BACKOFF_MS=100",
    "CODEX_ROUTER_FAILOVER_MAX_BACKOFF_MS=2000",
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
  assert.equal(
    only(unit, "Service.ReadOnlyPaths"),
    "/run/codex-browser-uploads",
  );
  assert.doesNotMatch(content, /0\.0\.0\.0|\[::\]|--listen (?:stdio|ws):/);
});

test("standalone upstream App Server remains isolated from the account router", async () => {
  const { content, unit } = await loadUnit("codex-web-upstream-app-server.service");
  assert.deepEqual(only(unit, "Unit.After"), "network-online.target");
  assert.deepEqual(only(unit, "Unit.Wants"), "network-online.target");
  const command = only(unit, "Service.ExecStart");
  assert.match(command, /^\/usr\/local\/bin\/codex /);
  assert.doesNotMatch(command, /openai_base_url|18317|codex-account-router/);
  assert.match(
    command,
    /app-server .*--listen unix:\/\/\/run\/codex-web-upstream-app-server\/app-server\.sock$/,
  );
  assert.deepEqual(unit.get("Service.LoadCredential"), [
    "codex-auth:/etc/codex-account-router/credentials/app-server-auth.json",
  ]);
  assert.doesNotMatch(content, /0\.0\.0\.0|\[::\]|--listen (?:stdio|ws):/);
  assert.doesNotMatch(command, /(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/i);
});

test("optional 8215 full-access override disables both Codex and systemd sandboxes", async () => {
  const overridePath = path.join(
    systemdRoot,
    "codex-web-upstream-app-server.service.d",
    "full-access.conf",
  );
  const content = await fs.readFile(overridePath, "utf8");
  const unit = parseUnit(content);
  const commands = unit.get("Service.ExecStart");

  assert.deepEqual(commands?.slice(0, 1), [""]);
  assert.equal(commands?.length, 2);
  assert.match(commands[1], /^\/usr\/local\/bin\/codex /);
  assert.match(commands[1], /sandbox_mode="danger-full-access"/);
  assert.match(commands[1], /approval_policy="never"/);
  assert.doesNotMatch(commands[1], /openai_base_url|18317|codex-account-router/);
  assert.match(
    commands[1],
    /--listen unix:\/\/\/run\/codex-web-upstream-app-server\/app-server\.sock$/,
  );

  for (const key of [
    "Service.ReadWritePaths",
    "Service.RestrictAddressFamilies",
  ]) {
    assert.equal(only(unit, key), "", `${key} must reset the base restriction`);
  }
  for (const key of [
    "Service.NoNewPrivileges",
    "Service.PrivateTmp",
    "Service.PrivateDevices",
    "Service.PrivateMounts",
    "Service.ProtectSystem",
    "Service.ProtectHome",
    "Service.RestrictSUIDSGID",
  ]) {
    assert.equal(only(unit, key), "false", `${key} must be disabled for 8215`);
  }
  assert.doesNotMatch(
    content,
    /(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/i,
  );
});

test("8215 full-access deployment is rollback-capable and never restarts 8216", async () => {
  const script = await fs.readFile(
    path.join(repositoryRoot, "evidence", "M6.9", "deploy-8215-full-access.sh"),
    "utf8",
  );
  const restartedUnits = [
    ...script.matchAll(/systemctl restart ([A-Za-z0-9@_.-]+\.service)/g),
  ].map((match) => match[1]);

  assert.deepEqual(
    new Set(restartedUnits),
    new Set(["codex-web-upstream-app-server.service"]),
  );
  assert.match(script, /trap 'rollback' ERR INT TERM/);
  assert.match(script, /assert_8216_unchanged/);
  assert.match(
    script,
    /DESTINATION="\/etc\/systemd\/system\/codex-web-upstream-app-server\.service\.d\/full-access\.conf"/,
  );
  assert.doesNotMatch(
    script,
    /(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/i,
  );
});

test("standalone upstream codex-web never journals verbose IPC or model bodies", async () => {
  const { content, unit } = await loadUnit("codex-web-upstream.service");
  assert.equal(
    only(unit, "Service.StandardOutput"),
    "null",
    "the upstream Electron compatibility layer must not journal IPC or model bodies",
  );
  assert.equal(only(unit, "Service.StandardError"), "journal");
  assert.equal(
    only(unit, "Service.ExecStart"),
    "/usr/bin/node /opt/0xcaff-codex-web/current/src/server/main.js --host 127.0.0.1 --port 8215",
  );
  assert.doesNotMatch(
    content,
    /0\.0\.0\.0|\[::\]|(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/i,
  );
});

test("routed upstream codex-web uses separate state, socket, and port without touching 8215", async () => {
  const [
    { content: appContent, unit: app },
    { content: webContent, unit: web },
  ] = await Promise.all([
    loadUnit("codex-web-router-app-server.service"),
    loadUnit("codex-web-router.service"),
  ]);

  assert.deepEqual(
    new Set(only(app, "Unit.After").split(/\s+/)),
    new Set(["network-online.target", "codex-account-router.service"]),
  );
  assert.deepEqual(
    new Set(only(app, "Unit.Wants").split(/\s+/)),
    new Set(["network-online.target", "codex-account-router.service"]),
  );
  assert.match(
    only(app, "Service.ExecStart"),
    /openai_base_url=.*http:\/\/127\.0\.0\.1:18317\/backend-api\/codex/,
  );
  assert.match(
    only(app, "Service.ExecStart"),
    /--listen unix:\/\/\/run\/codex-web-router-app-server\/app-server\.sock$/,
  );
  assert.equal(
    only(app, "Service.StateDirectory"),
    "codex-web-router-app-server",
  );
  assert.equal(
    only(web, "Service.StandardOutput"),
    "null",
    "the upstream Electron compatibility layer must not journal IPC or model bodies",
  );
  assert.equal(only(web, "Service.StandardError"), "journal");
  assert.equal(
    only(web, "Service.ExecStart"),
    "/usr/bin/node /opt/0xcaff-codex-web-router/current/src/server/main.js --host 127.0.0.1 --port 8216",
  );
  assert.equal(only(web, "Service.StateDirectory"), "codex-web-router");
  assert.ok(
    web.get("Service.Environment")?.includes(
      "CODEX_UNIX_SOCKET=/run/codex-web-router-app-server/app-server.sock",
    ),
  );
  assert.ok(
    web.get("Service.Environment")?.includes(
      "CODEX_CLI_PATH=/opt/0xcaff-codex-web-router/bin/codex-remote-proxy-fast.mjs",
    ),
  );
  assert.deepEqual(new Set(web.get("Service.Environment")), new Set([
    "NODE_ENV=production",
    "HOME=/var/lib/codex-web-router",
    "CODEX_HOME=/var/lib/codex-web-router",
    "CODEX_CLI_PATH=/opt/0xcaff-codex-web-router/bin/codex-remote-proxy-fast.mjs",
    "CODEX_REAL_CLI_PATH=/usr/local/bin/codex",
    "CODEX_UNIX_SOCKET=/run/codex-web-router-app-server/app-server.sock",
    "CODEX_ROUTER_ADMIN_ORIGIN=http://127.0.0.1:18318",
    "CODEX_ROUTER_ADMIN_TOKEN_FILE=%d/router-admin-token",
    "CODEX_WEB_PUBLIC_ORIGIN=http://100.95.50.98:8216",
    "CODEX_WEB_TRUSTED_TAILNET_ACCESS=1",
    "CODEX_WEB_CODEX_HOME=/var/lib/codex-web-router-app-server",
    "CODEX_WEB_WORKSPACE_ROOTS=/srv/codex-workspaces",
    "CODEX_WEB_UPLOAD_ROOT=/run/codex-web-router-browser-uploads",
  ]));
  assert.deepEqual(web.get("Service.LoadCredential"), [
    "router-admin-token:/etc/codex-account-router/credentials/admin-token",
  ]);
  assert.equal(
    only(web, "Service.RuntimeDirectory"),
    "codex-web-router codex-web-router-browser-uploads",
  );
  assert.equal(
    only(web, "Service.ReadWritePaths"),
    "/srv/codex-workspaces /var/lib/codex-web-router /run/codex-web-router-browser-uploads",
  );
  assert.equal(
    only(app, "Service.ReadOnlyPaths"),
    "/run/codex-web-router-browser-uploads",
  );
  assert.doesNotMatch(
    `${appContent}\n${webContent}`,
    /(?:\/run|\/var\/lib)\/codex-web-upstream(?:-app-server)?|--port 8215/,
  );
  assert.doesNotMatch(
    `${appContent}\n${webContent}`,
    /0\.0\.0\.0|\[::\]|(?:Bearer\s+|Authorization=|refresh_token|access_token|sk-[A-Za-z0-9_-]{12,})/i,
  );
});

test("8216 account manager is socket-activated and confined to its credential mutation boundary", async () => {
  const [
    { content: socketContent, unit: socket },
    { content: serviceContent, unit: service },
    { content: webContent, unit: web },
  ] = await Promise.all([
    loadIsolatedUnit("codex-router-account-manager.socket"),
    loadIsolatedUnit("codex-router-account-manager.service"),
    loadIsolatedUnit("codex-web-router.service"),
  ]);
  assert.equal(only(socket, "Socket.ListenStream"), "/run/codex-router-account-manager.sock");
  assert.equal(only(socket, "Socket.SocketUser"), "root");
  assert.equal(only(socket, "Socket.SocketGroup"), "codex8216");
  assert.equal(only(socket, "Socket.SocketMode"), "0660");
  assert.equal(only(service, "Service.User"), "root");
  assert.equal(only(service, "Service.Group"), "codex8216");
  assert.equal(
    only(service, "Service.ExecStart"),
    "/opt/codex-account-router/current/bin/codex-router-account-manager",
  );
  assert.equal(only(service, "Service.NoNewPrivileges"), "true");
  assert.equal(only(service, "Service.ProtectSystem"), "strict");
  assert.equal(only(service, "Service.CapabilityBoundingSet"), "CAP_DAC_READ_SEARCH");
  assert.equal(only(service, "Service.AmbientCapabilities"), "");
  assert.equal(only(service, "Service.RestrictAddressFamilies"), "AF_UNIX AF_INET");
  assert.equal(only(service, "Service.IPAddressDeny"), "any");
  assert.equal(only(service, "Service.IPAddressAllow"), "localhost");
  assert.equal(
    only(service, "Service.ReadWritePaths"),
    "/etc/codex-account-router /etc/credstore",
  );
  assert.equal(
    only(service, "Service.ReadOnlyPaths"),
    "/etc/codex-account-router/credentials /var/lib/codex-web-router-account-auth",
  );
  assert.ok(web.get("Service.Environment")?.includes(
    "CODEX_ROUTER_ACCOUNT_MANAGER_SOCKET=/run/codex-router-account-manager.sock",
  ));
  assert.ok(web.get("Service.Environment")?.includes(
    "CODEX_ROUTER_ACCOUNT_AUTH_ROOT=/var/lib/codex-web-router-account-auth",
  ));
  assert.equal(
    only(web, "Service.StateDirectory"),
    "codex-web-router codex-web-router-account-auth",
  );
  assert.match(only(web, "Unit.After"), /codex-router-account-manager\.socket/u);
  assert.match(only(web, "Unit.Wants"), /codex-router-account-manager\.socket/u);
  assert.doesNotMatch(
    `${socketContent}\n${serviceContent}\n${webContent}`,
    /codex-web-upstream|--port 8215|sudo|\/bin\/(?:ba)?sh/u,
  );
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
    "CODEX_WEB_PUBLIC_ORIGIN=http://127.0.0.1:8214",
    "CODEX_WEB_ACCESS_TOKEN_FILE=%d/browser-access-token",
    "CODEX_WEB_CODEX_HOME=/var/lib/codex-app-server",
    "CODEX_WEB_WORKSPACE_ROOTS=/srv/codex-workspaces",
    "CODEX_WEB_UPLOAD_ROOT=/run/codex-browser-uploads",
  ]));
  assert.deepEqual(unit.get("Service.LoadCredential"), [
    "router-admin-token:/etc/codex-account-router/credentials/admin-token",
    "browser-access-token:/etc/codex-web/credentials/browser-access-token",
  ]);
  assert.equal(
    only(unit, "Service.RuntimeDirectory"),
    "codex-web codex-browser-uploads",
  );
  assert.equal(
    only(unit, "Service.ReadWritePaths"),
    "/srv/codex-workspaces /run/codex-browser-uploads",
  );
  assert.doesNotMatch(content, /0\.0\.0\.0|\[::\]|ws:\/\//);
});

test("unit command lines and environments contain paths/configuration, never secret values", async () => {
  for (const name of serviceNames) {
    const { unit } = await loadUnit(name);
    const publicConfiguration = [
      ...(unit.get("Service.ExecStart") ?? []),
      ...(unit.get("Service.Environment") ?? []),
    ].join("\n");
    assert.doesNotMatch(publicConfiguration, /(?:Bearer\s+|Authorization=|refresh_token|access_token(?!_file)|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{12,})/i, name);
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
    "d /etc/codex-web 0750 root codex -",
    "d /etc/codex-web/credentials 0700 root root -",
    "d /run/codex-browser-uploads 0700 codex codex -",
    "d /run/codex-web-router-browser-uploads 0700 codex codex -",
    "d /srv/codex-workspaces 0750 codex codex -",
    "",
  ].join("\n"));
  assert.doesNotMatch(`${sysusers}\n${tmpfiles}`, /(?:token|cookie|authorization|@)/i);
});

test("PrivateTmp services share attachments only through the explicit private upload directory", async () => {
  const [{ unit: web }, { unit: appServer }] = await Promise.all([
    loadUnit("codex-web.service"),
    loadUnit("codex-app-server.service"),
  ]);
  assert.equal(only(web, "Service.PrivateTmp"), "true");
  assert.equal(only(appServer, "Service.PrivateTmp"), "true");
  assert.match(
    only(web, "Service.ReadWritePaths"),
    /(?:^| )\/run\/codex-browser-uploads(?: |$)/,
  );
  assert.equal(
    only(appServer, "Service.ReadOnlyPaths"),
    "/run/codex-browser-uploads",
  );
  assert.doesNotMatch(
    `${only(web, "Service.ReadWritePaths")}\n${only(appServer, "Service.ReadOnlyPaths")}`,
    /\/tmp(?:\/|$)/,
  );
});

test("isolated 8216 opts into persistent uploads without changing standalone services", async () => {
  const fixtureRoot = path.join(systemdRoot, "8216-fixture");
  const [web, app] = await Promise.all([
    fs.readFile(
      path.join(
        fixtureRoot,
        "codex-web-router.service.d",
        "upload-persistence.conf",
      ),
      "utf8",
    ),
    fs.readFile(
      path.join(
        fixtureRoot,
        "codex-web-router-app-server.service.d",
        "upload-persistence.conf",
      ),
      "utf8",
    ),
  ]);
  assert.match(
    web,
    /^Environment=CODEX_WEB_UPLOAD_ROOT=\/var\/lib\/codex-web-router\/uploads$/m,
  );
  assert.match(web, /^Environment=CODEX_WEB_UPLOAD_PERSIST=1$/m);
  assert.match(
    web,
    /^ExecStartPre=\/usr\/bin\/install -d -m 0700 \/var\/lib\/codex-web-router\/uploads$/m,
  );
  assert.match(
    web,
    /^ReadWritePaths=\/var\/lib\/codex-web-router\/uploads$/m,
  );
  assert.match(
    app,
    /^ReadOnlyPaths=\/var\/lib\/codex-web-router\/uploads$/m,
  );
  assert.doesNotMatch(`${web}\n${app}`, /codex-web-upstream|8215|\/tmp(?:\/|$)/);
});

test("native systemd workflow provisions the browser credential without exposing its value", async () => {
  const workflow = await fs.readFile(
    path.resolve(repositoryRoot, ".github/workflows/systemd-units.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /openssl rand -hex 32 \| tr -d '\\n' \| sudo tee \/etc\/codex-web\/credentials\/browser-access-token >\/dev\/null/,
  );
  assert.match(
    workflow,
    /sudo chmod 0600 \/etc\/codex-web\/credentials\/browser-access-token/,
  );
});

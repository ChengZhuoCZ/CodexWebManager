"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRouterStatusBridge = registerRouterStatusBridge;
const node_fs_1 = require("node:fs");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_net_1 = __importDefault(require("node:net"));
const node_path_1 = __importDefault(require("node:path"));
const ws_1 = __importDefault(require("ws"));
const STATUS_PATH = "/__backend/codex-router/status";
const EVENTS_PATH = "/__backend/codex-router/events";
const SWITCH_PATH = "/__backend/codex-router/switch";
const QUOTA_REFRESH_PATH = "/__backend/codex-router/quota-refresh";
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ACCOUNT_STATES = new Set([
    "healthy",
    "cooling_down",
    "half_open",
    "auth_expired",
    "quota_exhausted",
    "disabled",
    "unknown",
]);
const SWITCH_REASONS = new Set([
    "manual",
    "startup",
    "quota_exhausted",
    "rate_limited",
    "auth_expired",
    "network_error",
    "upstream_5xx",
]);
const ROUTER_STATUSES = new Set(["ready", "degraded", "unavailable"]);
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_SWITCH_BYTES = 8 * 1024;
const MAX_APP_SERVER_BYTES = 64 * 1024;
const SWITCH_ERRORS = new Set([
    "active_semantic_stream",
    "switch_not_available",
    "switch_rejected",
    "switch_target_mismatch",
    "switch_state_rejected",
]);
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function alias(value) {
    if (typeof value !== "string" ||
        value.trim() !== value ||
        [...value].length < 1 ||
        [...value].length > 64) {
        throw new Error("invalid bridge payload");
    }
    return value;
}
function nullableRatio(value) {
    if (value !== null &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error("invalid bridge payload");
    }
    return value;
}
function nullableTimestamp(value) {
    if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
        throw new Error("invalid bridge payload");
    }
    return value;
}
function sanitizeStatus(value) {
    if (!isRecord(value) ||
        !ROUTER_STATUSES.has(String(value.status)) ||
        value.architecture_mode !== "LIMITED_MODE" ||
        value.cross_account_e2e_verified !== false ||
        !Number.isSafeInteger(value.active_streams) ||
        Number(value.active_streams) < 0 ||
        Number(value.active_streams) > 1_000_000 ||
        !Array.isArray(value.accounts) ||
        value.accounts.length > 1_000) {
        throw new Error("invalid bridge payload");
    }
    const accounts = value.accounts.map((account) => {
        if (!isRecord(account) ||
            !ACCOUNT_STATES.has(String(account.state)) ||
            typeof account.enabled !== "boolean" ||
            (account.last_switch_reason !== null &&
                !SWITCH_REASONS.has(String(account.last_switch_reason)))) {
            throw new Error("invalid bridge payload");
        }
        return {
            alias: alias(account.alias),
            state: account.state,
            enabled: account.enabled,
            five_hour_remaining_ratio: nullableRatio(account.five_hour_remaining_ratio),
            weekly_remaining_ratio: nullableRatio(account.weekly_remaining_ratio),
            weekly_resets_at: account.weekly_resets_at === undefined
                ? null
                : nullableTimestamp(account.weekly_resets_at),
            snapshot_observed_at: nullableTimestamp(account.snapshot_observed_at),
            cooldown_until: nullableTimestamp(account.cooldown_until),
            last_switch_reason: account.last_switch_reason,
        };
    });
    let currentRoute = null;
    if (value.current_route !== null) {
        if (!isRecord(value.current_route) || value.current_route.continuity !== "new_backend_session") {
            throw new Error("invalid bridge payload");
        }
        currentRoute = {
            account_alias: alias(value.current_route.account_alias),
            continuity: "new_backend_session",
        };
    }
    return {
        status: value.status,
        architecture_mode: "LIMITED_MODE",
        cross_account_e2e_verified: false,
        active_streams: value.active_streams,
        current_route: currentRoute,
        accounts,
    };
}
function sanitizeSwitchEvent(id, type, value) {
    if (!CURSOR_PATTERN.test(id) ||
        type !== "router.switch" ||
        !isRecord(value) ||
        (value.from_alias !== null && typeof value.from_alias !== "string") ||
        !SWITCH_REASONS.has(String(value.reason)) ||
        value.continuity !== "new_backend_session" ||
        value.architecture_mode !== "LIMITED_MODE" ||
        typeof value.timestamp !== "string" ||
        Number.isNaN(Date.parse(value.timestamp))) {
        throw new Error("invalid bridge event");
    }
    return {
        id,
        type: "router.switch",
        data: {
            from_alias: value.from_alias === null ? null : alias(value.from_alias),
            to_alias: alias(value.to_alias),
            reason: value.reason,
            continuity: "new_backend_session",
            architecture_mode: "LIMITED_MODE",
            timestamp: value.timestamp,
        },
    };
}
function loadConfig(environment) {
    const rawOrigin = environment.CODEX_ROUTER_ADMIN_ORIGIN;
    const tokenFile = environment.CODEX_ROUTER_ADMIN_TOKEN_FILE;
    if (rawOrigin === undefined && tokenFile === undefined) {
        return { enabled: false };
    }
    if (rawOrigin === undefined || tokenFile === undefined || !node_path_1.default.isAbsolute(tokenFile)) {
        throw new Error("codex router status bridge configuration is incomplete");
    }
    let origin;
    try {
        origin = new URL(rawOrigin);
    }
    catch {
        throw new Error("codex router status bridge configuration is invalid");
    }
    if (origin.protocol !== "http:" ||
        !new Set(["127.0.0.1", "[::1]"]).has(origin.hostname) ||
        origin.port === "" ||
        origin.username !== "" ||
        origin.password !== "" ||
        origin.pathname !== "/" ||
        origin.search !== "" ||
        origin.hash !== "") {
        throw new Error("codex router status bridge configuration is invalid");
    }
    const credentialsDirectory = environment.CREDENTIALS_DIRECTORY;
    if (credentialsDirectory !== undefined) {
        const relative = node_path_1.default.relative("/run/credentials", credentialsDirectory);
        if (!node_path_1.default.isAbsolute(credentialsDirectory) ||
            node_path_1.default.dirname(tokenFile) !== credentialsDirectory ||
            relative === "" ||
            relative.startsWith(`..${node_path_1.default.sep}`) ||
            relative.includes(node_path_1.default.sep) ||
            !/^[A-Za-z0-9:_.@-]+\.(?:service|scope)$/.test(relative)) {
            throw new Error("codex router status bridge configuration is invalid");
        }
    }
    return {
        enabled: true,
        adminOrigin: origin.origin,
        tokenFile,
        credentialsDirectory,
    };
}
function loadQuotaRefreshConfig(environment) {
    const socketPath = environment.CODEX_UNIX_SOCKET;
    const accountAlias = environment.CODEX_ROUTER_QUOTA_ACCOUNT_ALIAS;
    if (accountAlias === undefined)
        return { enabled: false };
    if (socketPath === undefined ||
        !node_path_1.default.isAbsolute(socketPath) ||
        !socketPath.startsWith(`/run${node_path_1.default.sep}`) ||
        !socketPath.endsWith(".sock") ||
        socketPath.includes("\0") ||
        socketPath.includes("\n") ||
        socketPath.length > 160) {
        throw new Error("codex router quota refresh configuration is invalid");
    }
    return {
        enabled: true,
        socketPath: node_path_1.default.normalize(socketPath),
        accountAlias: alias(accountAlias),
    };
}
function mergeWeeklyQuotaSnapshot(status, snapshot) {
    if (snapshot === null)
        return status;
    const accounts = status.accounts.map((account) => {
        if (account.alias !== snapshot.accountAlias)
            return account;
        const routerObservedAt = account.snapshot_observed_at === null
            ? Number.NEGATIVE_INFINITY
            : Date.parse(account.snapshot_observed_at);
        if (routerObservedAt > Date.parse(snapshot.observedAt))
            return account;
        return {
            ...account,
            weekly_remaining_ratio: snapshot.weeklyRemainingRatio,
            weekly_resets_at: snapshot.weeklyResetsAt,
            snapshot_observed_at: snapshot.observedAt,
        };
    });
    return { ...status, accounts };
}
function assertPrivate(stat, systemdCredential, directory) {
    const ownerIsInvalid = systemdCredential
        ? Number(stat.uid) !== 0
        : typeof process.getuid === "function" && Number(stat.uid) !== process.getuid();
    const forbiddenMode = systemdCredential ? (directory ? 0o027 : 0o337) : 0o077;
    if (ownerIsInvalid || (Number(stat.mode) & forbiddenMode) !== 0) {
        throw new Error("admin token is unavailable");
    }
}
async function withAdminToken(tokenFile, credentialsDirectory, callback) {
    let handle;
    let bytes;
    const systemdCredential = credentialsDirectory !== undefined;
    try {
        const directoryStat = await promises_1.default.lstat(node_path_1.default.dirname(tokenFile));
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            throw new Error("admin token is unavailable");
        }
        assertPrivate(directoryStat, systemdCredential, true);
        handle = await promises_1.default.open(tokenFile, node_fs_1.constants.O_RDONLY | (node_fs_1.constants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 24 || stat.size > 4_096) {
            throw new Error("admin token is unavailable");
        }
        assertPrivate(stat, systemdCredential, false);
        bytes = await handle.readFile();
        const token = bytes.toString("utf8");
        if (token.length < 24 || token.length > 4_096 || !TOKEN_PATTERN.test(token)) {
            throw new Error("admin token is unavailable");
        }
        return await callback(token);
    }
    catch {
        throw new Error("admin token is unavailable");
    }
    finally {
        bytes?.fill(0);
        await handle?.close().catch(() => undefined);
    }
}
async function boundedText(response, maxBytes = MAX_STATUS_BYTES) {
    if (!response.body) {
        throw new Error("router response is unavailable");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            length += next.value.byteLength;
            if (length > maxBytes)
                throw new Error("router response is too large");
            chunks.push(next.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
}
function manualSwitchBody(value) {
    if (!isRecord(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "account_alias") ||
        !Object.hasOwn(value, "reason") ||
        value.reason !== "manual") {
        throw new Error("invalid switch request");
    }
    return { account_alias: alias(value.account_alias), reason: "manual" };
}
async function forwardManualSwitch(config, requestBody) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
        const response = await withAdminToken(config.tokenFile, config.credentialsDirectory, (token) => fetch(`${config.adminOrigin}/v1/switch`, {
            method: "POST",
            headers: {
                accept: "application/json",
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        }));
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
            throw new Error("router switch response is unavailable");
        }
        const body = JSON.parse(await boundedText(response, MAX_SWITCH_BYTES));
        if (response.status === 200) {
            if (!isRecord(body) ||
                body.accepted !== true ||
                body.account_alias !== requestBody.account_alias ||
                body.continuity !== "new_backend_session" ||
                body.architecture_mode !== "LIMITED_MODE") {
                throw new Error("router switch response is invalid");
            }
            return {
                statusCode: 200,
                payload: {
                    enabled: true,
                    accepted: true,
                    account_alias: requestBody.account_alias,
                    continuity: "new_backend_session",
                    architecture_mode: "LIMITED_MODE",
                },
            };
        }
        if (response.status === 409 &&
            isRecord(body) &&
            typeof body.error === "string" &&
            SWITCH_ERRORS.has(body.error)) {
            return { statusCode: 409, payload: { enabled: true, error: body.error } };
        }
        throw new Error("router switch response is unavailable");
    }
    finally {
        clearTimeout(timer);
    }
}
function weeklyQuotaSnapshotFromResult(value, accountAlias, observedAt) {
    if (!isRecord(value) || !isRecord(value.rateLimits)) {
        throw new Error("weekly quota is unavailable");
    }
    const windows = [value.rateLimits.primary, value.rateLimits.secondary];
    const weekly = windows.find((candidate) => isRecord(candidate) &&
        (candidate.windowDurationMins === 10_079 || candidate.windowDurationMins === 10_080));
    if (!isRecord(weekly) ||
        typeof weekly.usedPercent !== "number" ||
        !Number.isFinite(weekly.usedPercent) ||
        weekly.usedPercent < 0 ||
        weekly.usedPercent > 100 ||
        Number.isNaN(Date.parse(observedAt))) {
        throw new Error("weekly quota is unavailable");
    }
    let weeklyResetsAt = null;
    if (weekly.resetsAt !== null && weekly.resetsAt !== undefined) {
        if (typeof weekly.resetsAt !== "number" ||
            !Number.isSafeInteger(weekly.resetsAt) ||
            weekly.resetsAt < 0 ||
            weekly.resetsAt > 4_102_444_800) {
            throw new Error("weekly quota is unavailable");
        }
        weeklyResetsAt = new Date(weekly.resetsAt * 1000).toISOString();
    }
    return {
        accountAlias,
        weeklyRemainingRatio: Math.max(0, Math.min(1, (100 - weekly.usedPercent) / 100)),
        weeklyResetsAt,
        observedAt,
    };
}
async function readWeeklyQuotaSnapshot(config) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let initialized = false;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (socket.readyState === ws_1.default.OPEN || socket.readyState === ws_1.default.CONNECTING) {
                socket.close();
            }
            if (error !== null || value === undefined)
                reject(error ?? new Error("weekly quota is unavailable"));
            else
                resolve(value);
        };
        const socket = new ws_1.default("ws://localhost/", {
            createConnection: () => node_net_1.default.createConnection(config.socketPath),
            maxPayload: MAX_APP_SERVER_BYTES,
            perMessageDeflate: false,
        });
        const timer = setTimeout(() => finish(new Error("weekly quota request timed out")), REQUEST_TIMEOUT_MS);
        timer.unref();
        socket.once("error", () => finish(new Error("weekly quota is unavailable")));
        socket.once("close", () => finish(new Error("weekly quota is unavailable")));
        socket.once("open", () => {
            socket.send(JSON.stringify({
                id: 1,
                method: "initialize",
                params: {
                    clientInfo: {
                        name: "codex_web_quota_refresh",
                        title: "Codex Web quota refresh",
                        version: "0.1.0",
                    },
                    capabilities: { experimentalApi: true },
                },
            }));
        });
        socket.on("message", (data, isBinary) => {
            if (isBinary || Buffer.byteLength(data.toString(), "utf8") > MAX_APP_SERVER_BYTES) {
                finish(new Error("weekly quota is unavailable"));
                return;
            }
            let message;
            try {
                message = JSON.parse(data.toString());
            }
            catch {
                finish(new Error("weekly quota is unavailable"));
                return;
            }
            if (!isRecord(message) || (message.id !== 1 && message.id !== 2))
                return;
            if (Object.hasOwn(message, "error")) {
                finish(new Error("weekly quota is unavailable"));
                return;
            }
            if (message.id === 1 && !initialized) {
                initialized = true;
                socket.send(JSON.stringify({ method: "initialized", params: {} }));
                socket.send(JSON.stringify({ id: 2, method: "account/rateLimits/read", params: {} }));
                return;
            }
            if (message.id === 2) {
                try {
                    finish(null, weeklyQuotaSnapshotFromResult(message.result, config.accountAlias, new Date().toISOString()));
                }
                catch {
                    finish(new Error("weekly quota is unavailable"));
                }
            }
        });
    });
}
async function fetchStatus(config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
        const response = await withAdminToken(config.tokenFile, config.credentialsDirectory, (token) => fetch(`${config.adminOrigin}/v1/status`, {
            headers: { accept: "application/json", authorization: `Bearer ${token}` },
            signal: controller.signal,
        }));
        if (response.status !== 200 ||
            !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
            throw new Error("router response is unavailable");
        }
        return sanitizeStatus(JSON.parse(await boundedText(response)));
    }
    finally {
        clearTimeout(timer);
    }
}
function parseFrame(frame) {
    let id = null;
    let type = null;
    const data = [];
    for (const rawLine of frame.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "" || line.startsWith(":"))
            continue;
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        let value = separator === -1 ? "" : line.slice(separator + 1);
        if (value.startsWith(" "))
            value = value.slice(1);
        if (field === "id")
            id = value;
        else if (field === "event")
            type = value;
        else if (field === "data")
            data.push(value);
        else
            throw new Error("unsupported bridge event field");
    }
    if (id === null && type === null && data.length === 0)
        return null;
    if (id === null || type === null || data.length === 0)
        throw new Error("incomplete bridge event");
    return sanitizeSwitchEvent(id, type, JSON.parse(data.join("\n")));
}
async function relayEvents(response, write) {
    if (!response.body)
        throw new Error("router events are unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) {
                buffer += decoder.decode();
                break;
            }
            buffer += decoder.decode(next.value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (Buffer.byteLength(frame, "utf8") > MAX_EVENT_BYTES)
                    throw new Error("bridge event is too large");
                const event = parseFrame(frame);
                if (event) {
                    write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
                }
            }
            if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES)
                throw new Error("bridge event is too large");
        }
        if (buffer.trim() !== "")
            throw new Error("unterminated bridge event");
    }
    finally {
        reader.releaseLock();
    }
}
async function registerRouterStatusBridge(app, environment) {
    const config = loadConfig(environment);
    const quotaRefreshConfig = loadQuotaRefreshConfig(environment);
    let quotaSnapshot = null;
    app.get(STATUS_PATH, async (_request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        if (!config.enabled)
            return reply.code(404).send({ enabled: false });
        try {
            return reply.send({
                enabled: true,
                router: mergeWeeklyQuotaSnapshot(await fetchStatus(config), quotaSnapshot),
            });
        }
        catch {
            return reply.code(502).send({ enabled: true, error: "router_status_unavailable" });
        }
    });
    app.post(QUOTA_REFRESH_PATH, { bodyLimit: 1024 }, async (request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        if (!config.enabled || !quotaRefreshConfig.enabled) {
            return reply.code(404).send({ enabled: false });
        }
        if (!isRecord(request.body) || Object.keys(request.body).length !== 0) {
            return reply.code(400).send({ enabled: true, error: "invalid_quota_refresh_request" });
        }
        try {
            quotaSnapshot = await readWeeklyQuotaSnapshot(quotaRefreshConfig);
            return reply.send({
                enabled: true,
                refreshed: true,
                account_alias: quotaSnapshot.accountAlias,
                weekly_remaining_ratio: quotaSnapshot.weeklyRemainingRatio,
                weekly_resets_at: quotaSnapshot.weeklyResetsAt,
                snapshot_observed_at: quotaSnapshot.observedAt,
            });
        }
        catch {
            return reply.code(502).send({ enabled: true, error: "quota_refresh_unavailable" });
        }
    });
    app.get(EVENTS_PATH, async (request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        if (!config.enabled)
            return reply.code(404).send({ enabled: false });
        const cursor = request.headers["last-event-id"] ?? "0";
        if (typeof cursor !== "string" || !CURSOR_PATTERN.test(cursor)) {
            return reply.code(400).send({ enabled: true, error: "invalid_event_cursor" });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        timer.unref();
        const cancel = () => controller.abort();
        request.raw.once("aborted", cancel);
        reply.raw.once("close", cancel);
        try {
            const response = await withAdminToken(config.tokenFile, config.credentialsDirectory, (token) => fetch(`${config.adminOrigin}/v1/events`, {
                headers: {
                    accept: "text/event-stream",
                    authorization: `Bearer ${token}`,
                    "last-event-id": cursor,
                },
                signal: controller.signal,
            }));
            clearTimeout(timer);
            if (response.status !== 200 ||
                !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
                throw new Error("router events are unavailable");
            }
            reply.hijack();
            reply.raw.writeHead(200, {
                "cache-control": "no-cache, no-store",
                connection: "keep-alive",
                "content-type": "text/event-stream; charset=utf-8",
                "x-accel-buffering": "no",
                "x-content-type-options": "nosniff",
            });
            reply.raw.write(": connected\n\n");
            await relayEvents(response, (value) => reply.raw.write(value));
            reply.raw.end();
            return reply;
        }
        catch {
            if (!reply.sent) {
                return reply.code(502).send({ enabled: true, error: "router_events_unavailable" });
            }
            reply.raw.destroy();
            return reply;
        }
        finally {
            clearTimeout(timer);
            request.raw.off("aborted", cancel);
            reply.raw.off("close", cancel);
        }
    });
    app.post(SWITCH_PATH, { bodyLimit: 4 * 1024 }, async (request, reply) => {
        reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff");
        if (!config.enabled)
            return reply.code(404).send({ enabled: false });
        let body;
        try {
            body = manualSwitchBody(request.body);
        }
        catch {
            return reply.code(400).send({ enabled: true, error: "invalid_switch_request" });
        }
        try {
            const result = await forwardManualSwitch(config, body);
            return reply.code(result.statusCode).send(result.payload);
        }
        catch {
            return reply.code(502).send({ enabled: true, error: "router_switch_unavailable" });
        }
    });
}
//# sourceMappingURL=router-status-bridge.js.map
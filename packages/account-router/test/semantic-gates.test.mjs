import assert from "node:assert/strict";
import test from "node:test";
import { createSseSemanticGate, SseLimitError } from "../src/sse-semantic-gate.mjs";
import {
  createTextMessageAssembler,
  createWebSocketFrameParser,
  encodeWebSocketFrame,
} from "../src/websocket-frames.mjs";

test("parses split SSE events and classifies unknown data conservatively", () => {
  const gate = createSseSemanticGate({ maxEventBytes: 256, maxPreflightBytes: 256 });
  assert.deepEqual(gate.push(Buffer.from("event: response.created\ndata: {}\n")), []);
  const created = gate.push(Buffer.from("\nevent: response.output_text.delta\n"));
  assert.equal(created.length, 1);
  assert.equal(created[0].eventType, "response.created");
  assert.equal(created[0].classification, "preflight");
  const delta = gate.push(Buffer.from("data: {\"delta\":\"fixture\"}\n\n"));
  assert.equal(delta.length, 1);
  assert.equal(delta[0].eventType, "response.output_text.delta");
  assert.equal(delta[0].classification, "semantic");
  const unknown = gate.push(Buffer.from("data: fixture\n\n"));
  assert.equal(unknown[0].classification, "semantic");
  gate.finish();
});

test("bounds SSE event and preflight buffers and rejects truncation", () => {
  assert.throws(
    () => createSseSemanticGate({ maxEventBytes: 8 }).push(Buffer.from("data: 123456789")),
    (error) => error instanceof SseLimitError && error.code === "sse_event_too_large",
  );
  const preflight = createSseSemanticGate({ maxEventBytes: 64, maxPreflightBytes: 8 });
  assert.throws(
    () => preflight.push(Buffer.from(": heartbeat\n\n")),
    (error) => error instanceof SseLimitError && error.code === "sse_preflight_too_large",
  );
  const truncated = createSseSemanticGate();
  truncated.push(Buffer.from("data: incomplete"));
  assert.throws(
    () => truncated.finish(),
    (error) => error instanceof SseLimitError && error.code === "sse_truncated_event",
  );
});

test("round-trips masked fragmented WebSocket text and enforces framing rules", () => {
  const messages = [];
  const assemble = createTextMessageAssembler({ onMessage: (payload) => messages.push(payload) });
  const parser = createWebSocketFrameParser({
    expectMasked: true,
    onFrame(frame) { assemble(frame); },
  });
  const bytes = Buffer.concat([
    encodeWebSocketFrame("fixture-", { masked: true, opcode: 0x1, final: false }),
    encodeWebSocketFrame("message", { masked: true, opcode: 0x0, final: true }),
  ]);
  parser.push(bytes.subarray(0, 3));
  parser.push(bytes.subarray(3));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].toString("utf8"), "fixture-message");

  const wrongMask = createWebSocketFrameParser({ expectMasked: true, onFrame() {} });
  assert.throws(() => wrongMask.push(encodeWebSocketFrame("x")), /expected a masked frame/);
  assert.throws(
    () => encodeWebSocketFrame(Buffer.alloc(126), { opcode: 0x9 }),
    /control frame/,
  );
  const invalidContinuation = createTextMessageAssembler({ onMessage() {} });
  assert.throws(
    () => invalidContinuation({ final: true, opcode: 0x0, payload: Buffer.from("x") }),
    /continuation sequence/,
  );
  const invalidUtf8 = createTextMessageAssembler({ onMessage() {} });
  assert.throws(
    () => invalidUtf8({ final: true, opcode: 0x1, payload: Buffer.from([0xc3, 0x28]) }),
    /UTF-8/,
  );
});

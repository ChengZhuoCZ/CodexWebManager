import { randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";

const VALID_OPCODES = new Set([0x0, 0x1, 0x2, 0x8, 0x9, 0xa]);

export function encodeWebSocketFrame(
  payload,
  { opcode = 0x1, masked = false, final = true } = {},
) {
  if (!VALID_OPCODES.has(opcode)) throw new Error("WebSocket opcode is invalid");
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (opcode >= 0x8 && (!final || data.length > 125)) {
    throw new Error("WebSocket control frame is invalid");
  }
  let marker;
  let extended = Buffer.alloc(0);
  if (data.length < 126) {
    marker = data.length;
  } else if (data.length <= 0xffff) {
    marker = 126;
    extended = Buffer.alloc(2);
    extended.writeUInt16BE(data.length);
  } else {
    marker = 127;
    extended = Buffer.alloc(8);
    extended.writeBigUInt64BE(BigInt(data.length));
  }
  const mask = masked ? randomBytes(4) : Buffer.alloc(0);
  const outputPayload = Buffer.from(data);
  if (masked) {
    for (let index = 0; index < outputPayload.length; index += 1) {
      outputPayload[index] ^= mask[index % 4];
    }
  }
  return Buffer.concat([
    Buffer.from([(final ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | marker]),
    extended,
    mask,
    outputPayload,
  ]);
}

export function createWebSocketFrameParser({
  expectMasked,
  maxPayloadBytes = 16 * 1024 * 1024,
  onFrame,
}) {
  if (typeof expectMasked !== "boolean") throw new TypeError("expectMasked must be boolean");
  if (
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes < 1 ||
    maxPayloadBytes > 64 * 1024 * 1024
  ) {
    throw new Error("maxPayloadBytes must be an integer from 1 through 67108864");
  }
  if (typeof onFrame !== "function") throw new TypeError("onFrame must be a function");
  let buffer = Buffer.alloc(0);

  return Object.freeze({
    push(chunk) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new TypeError("WebSocket chunk must be bytes");
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const first = buffer[0];
        const second = buffer[1];
        const final = (first & 0x80) !== 0;
        const rsv = first & 0x70;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (rsv !== 0 || !VALID_OPCODES.has(opcode)) {
          throw new Error("reserved WebSocket frame is unsupported");
        }
        if (masked !== expectMasked) {
          throw new Error(expectMasked ? "expected a masked frame" : "expected an unmasked frame");
        }
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const large = buffer.readBigUInt64BE(2);
          if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket length is unsafe");
          length = Number(large);
          offset = 10;
        }
        if (length > maxPayloadBytes) throw new Error("WebSocket payload is too large");
        if (opcode >= 0x8 && (!final || length > 125)) {
          throw new Error("WebSocket control frame is invalid");
        }
        const maskLength = masked ? 4 : 0;
        const frameLength = offset + maskLength + length;
        if (buffer.length < frameLength) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payload = Buffer.from(buffer.subarray(offset + maskLength, frameLength));
        buffer = buffer.subarray(frameLength);
        if (mask) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }
        onFrame(Object.freeze({ final, opcode, payload }));
      }
    },
  });
}

export function createTextMessageAssembler({ maxMessageBytes = 16 * 1024 * 1024, onMessage }) {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1) {
    throw new Error("maxMessageBytes must be a positive integer");
  }
  if (typeof onMessage !== "function") throw new TypeError("onMessage must be a function");
  let fragments = [];
  let length = 0;
  let active = false;
  const emit = (payload) => {
    if (!isUtf8(payload)) throw new Error("WebSocket text message is not valid UTF-8");
    onMessage(payload);
  };
  return (frame) => {
    if (frame.opcode === 0x1) {
      if (active) throw new Error("interleaved WebSocket text messages are invalid");
      if (frame.payload.length > maxMessageBytes) {
        throw new Error("WebSocket text message is too large");
      }
      if (frame.final) {
        emit(frame.payload);
        return true;
      }
      active = true;
      fragments = [frame.payload];
      length = frame.payload.length;
    } else if (frame.opcode === 0x0 && active) {
      fragments.push(frame.payload);
      length += frame.payload.length;
      if (length > maxMessageBytes) throw new Error("WebSocket text message is too large");
      if (frame.final) {
        const message = Buffer.concat(fragments, length);
        fragments = [];
        length = 0;
        active = false;
        emit(message);
      }
    } else if (frame.opcode === 0x0 || (active && frame.opcode === 0x2)) {
      throw new Error("WebSocket continuation sequence is invalid");
    } else {
      return false;
    }
    if (length > maxMessageBytes) throw new Error("WebSocket text message is too large");
    return true;
  };
}

export function closeFramePayload(code, reason) {
  if (!Number.isSafeInteger(code) || code < 1000 || code > 4999) {
    throw new Error("WebSocket close code is invalid");
  }
  const reasonBytes = Buffer.from(reason, "utf8");
  if (reasonBytes.length > 123) throw new Error("WebSocket close reason is too long");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

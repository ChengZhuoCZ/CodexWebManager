import { randomBytes } from "node:crypto";

const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export function encodeWebSocketFrame(
  payload,
  { opcode = 0x1, masked = false, final = true } = {},
) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = data.length;
  let lengthBytes;
  let lengthMarker;

  if (length < 126) {
    lengthMarker = length;
    lengthBytes = Buffer.alloc(0);
  } else if (length <= 0xffff) {
    lengthMarker = 126;
    lengthBytes = Buffer.alloc(2);
    lengthBytes.writeUInt16BE(length);
  } else {
    lengthMarker = 127;
    lengthBytes = Buffer.alloc(8);
    lengthBytes.writeBigUInt64BE(BigInt(length));
  }

  const mask = masked ? randomBytes(4) : Buffer.alloc(0);
  const outputPayload = Buffer.from(data);
  if (masked) {
    for (let index = 0; index < outputPayload.length; index += 1) {
      outputPayload[index] ^= mask[index % 4];
    }
  }

  return Buffer.concat([
    Buffer.from([(final ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | lengthMarker]),
    lengthBytes,
    mask,
    outputPayload,
  ]);
}

export function createWebSocketFrameParser({
  expectMasked = null,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  onFrame,
}) {
  if (typeof onFrame !== "function") {
    throw new Error("onFrame is required");
  }

  let buffer = Buffer.alloc(0);

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const first = buffer[0];
        const second = buffer[1];
        const final = (first & 0x80) !== 0;
        const rsv = first & 0x70;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let payloadLength = second & 0x7f;
        let offset = 2;

        if (rsv !== 0) {
          throw new Error("compressed or reserved WebSocket frames are unsupported");
        }
        if (expectMasked !== null && masked !== expectMasked) {
          throw new Error(expectMasked ? "expected a masked frame" : "expected an unmasked frame");
        }

        if (payloadLength === 126) {
          if (buffer.length < 4) {
            return;
          }
          payloadLength = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (buffer.length < 10) {
            return;
          }
          const bigLength = buffer.readBigUInt64BE(2);
          if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            buffer = Buffer.alloc(0);
            throw new Error("WebSocket payload length is unsafe");
          }
          payloadLength = Number(bigLength);
          offset = 10;
        }

        if (payloadLength > maxPayloadBytes) {
          buffer = Buffer.alloc(0);
          throw new Error("WebSocket payload exceeds the configured limit");
        }

        const maskLength = masked ? 4 : 0;
        const frameLength = offset + maskLength + payloadLength;
        if (buffer.length < frameLength) {
          return;
        }

        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        const payloadStart = offset + maskLength;
        const payload = Buffer.from(buffer.subarray(payloadStart, frameLength));
        buffer = buffer.subarray(frameLength);

        if (mask) {
          for (let index = 0; index < payload.length; index += 1) {
            payload[index] ^= mask[index % 4];
          }
        }

        onFrame({ final, opcode, payload });
      }
    },
  };
}

export function createTextMessageAssembler(onMessage) {
  let fragments = [];
  let textInProgress = false;

  return ({ final, opcode, payload }) => {
    if (opcode === 0x1) {
      if (final) {
        onMessage(payload.toString("utf8"));
      } else {
        textInProgress = true;
        fragments = [payload];
      }
      return;
    }

    if (opcode === 0x0 && textInProgress) {
      fragments.push(payload);
      if (final) {
        onMessage(Buffer.concat(fragments).toString("utf8"));
        textInProgress = false;
        fragments = [];
      }
    }
  };
}

const NON_SEMANTIC_RESPONSE_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "codex.rate_limits",
  "codex.response.metadata",
]);

export function isSemanticResponseEvent(eventType) {
  return (
    typeof eventType === "string" &&
    (eventType.startsWith("response.") || eventType.startsWith("codex.")) &&
    !NON_SEMANTIC_RESPONSE_EVENTS.has(eventType)
  );
}

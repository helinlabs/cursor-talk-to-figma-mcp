// ---------------------------------------------------------------------------
// H.264 → RTP packetization (RFC 6184, packetization-mode=1).
//
// The window agent emits whole access units as Annex-B. WebRTC wants RTP
// packets under the path MTU, so each NAL either rides alone or is split into
// FU-A fragments. This is deliberately the only place that knows about NAL
// layout: the agent stays a pure encoder and the relay stays a pure pipe.
// ---------------------------------------------------------------------------

// 1200 keeps a packet inside a 1280-byte IPv6 path MTU once RTP, UDP, IP and
// DTLS/SRTP overhead are counted — the figure WebRTC implementations settle on.
export const MAX_PAYLOAD_BYTES = 1200;

export type Nal = { data: Uint8Array; type: number };

// Split Annex-B into NALs. Start codes are 3- or 4-byte; the encoder emits
// 4-byte ones, but accepting both costs nothing and avoids a silent break if
// that ever changes.
export function splitAnnexB(buffer: Uint8Array): Nal[] {
  const nals: Nal[] = [];
  let start = -1;
  let index = 0;
  while (index + 2 < buffer.length) {
    const isThree = buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 1;
    const isFour = index + 3 < buffer.length
      && buffer[index] === 0 && buffer[index + 1] === 0 && buffer[index + 2] === 0 && buffer[index + 3] === 1;
    if (isThree || isFour) {
      const codeLength = isFour ? 4 : 3;
      if (start >= 0 && index > start) {
        const data = buffer.subarray(start, index);
        if (data.length) nals.push({ data, type: data[0] & 0x1f });
      }
      index += codeLength;
      start = index;
      continue;
    }
    index++;
  }
  if (start >= 0 && start < buffer.length) {
    const data = buffer.subarray(start);
    if (data.length) nals.push({ data, type: data[0] & 0x1f });
  }
  return nals;
}

// Payloads for one access unit, in order. The caller stamps them with the
// same RTP timestamp and sets the marker bit on the last one.
export function packetizeAccessUnit(annexB: Uint8Array, maxPayload = MAX_PAYLOAD_BYTES): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (const nal of splitAnnexB(annexB)) {
    // Access unit delimiters and filler carry nothing a decoder needs here and
    // only cost packets.
    if (nal.type === 9 || nal.type === 12) continue;
    if (nal.data.length <= maxPayload) {
      packets.push(nal.data);
      continue;
    }
    // FU-A: the original NAL header splits into an indicator (F|NRI + type 28)
    // and a fragment header (S|E|R + original type), then the body is chunked.
    const header = nal.data[0];
    const indicator = (header & 0xe0) | 28;
    const nalType = header & 0x1f;
    const body = nal.data.subarray(1);
    const chunkSize = maxPayload - 2;
    for (let offset = 0; offset < body.length; offset += chunkSize) {
      const chunk = body.subarray(offset, offset + chunkSize);
      const isFirst = offset === 0;
      const isLast = offset + chunkSize >= body.length;
      const packet = new Uint8Array(chunk.length + 2);
      packet[0] = indicator;
      packet[1] = (isFirst ? 0x80 : 0) | (isLast ? 0x40 : 0) | nalType;
      packet.set(chunk, 2);
      packets.push(packet);
    }
  }
  return packets;
}

// A 32-bit RTP timestamp wraps roughly every 13 hours at 90 kHz; sequence
// numbers wrap every ~65k packets, which at 15 fps is minutes. Both are
// expected to wrap — the point is to wrap correctly rather than to grow.
export class RtpSequencer {
  private sequence: number;
  readonly ssrc: number;
  readonly timestampOffset: number;

  constructor() {
    // Random start values, as RFC 3550 requires, so two streams from the same
    // machine can never be confused for one another.
    this.sequence = Math.floor(Math.random() * 0x10000);
    this.ssrc = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.timestampOffset = Math.floor(Math.random() * 0xffffffff) >>> 0;
  }

  next(): number {
    const value = this.sequence;
    this.sequence = (this.sequence + 1) & 0xffff;
    return value;
  }

  timestamp(pts90k: number): number {
    return (this.timestampOffset + pts90k) >>> 0;
  }
}

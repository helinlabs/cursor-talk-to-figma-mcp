// ---------------------------------------------------------------------------
// Live preview over WebRTC.
//
// One window-agent process per streamed channel (ScreenCaptureKit capture +
// hardware H.264, see src/window_agent/), one werift peer per viewer. The
// relay does no transcoding and no muxing: the agent's Annex-B access units
// are packetized to RTP (RFC 6184) and written to every viewer's track.
//
// Media flows browser ⇄ mac mini directly (P2P, STUN only). The relay's part
// after signaling is feeding RTP into werift, which delivers over the ICE
// pair. There is deliberately NO TURN relay: when ICE cannot connect, the
// console falls back to the old low-rate JPEG capture path instead — decided
// with the operator, to keep the tunnel out of the media path entirely.
//
// The agent is also the input path (clicks + allowlisted keys), because both
// capture and synthetic input need macOS privacy grants and one binary means
// one grant. Input is forwarded verbatim; the agent enforces the allowlist.
// ---------------------------------------------------------------------------
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTCSessionDescription,
  RtpHeader,
  RtpPacket,
  RTCRtpHeaderExtensionParameters,
} from "werift";
import { MAX_PAYLOAD_BYTES, RtpSequencer, packetizeAccessUnit } from "./h264-rtp";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Agent binary: compiled from source on first use, cached by content hash —
// the same pattern as local-figma-capture's window helper, so deploying is
// still just `git pull` + relay restart, no build step.
// ---------------------------------------------------------------------------
const AGENT_SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "window_agent", "figma_window_agent.swift");
let agentBinaryPromise: Promise<string> | null = null;

async function agentBinary(): Promise<string> {
  if (agentBinaryPromise) return agentBinaryPromise;
  agentBinaryPromise = (async () => {
    const source = await readFile(AGENT_SOURCE_PATH, "utf8");
    const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const binaryPath = join(tmpdir(), `figma-window-agent-${hash}`);
    try {
      await access(binaryPath, fsConstants.X_OK);
      return binaryPath;
    } catch {}
    const buildDir = await mkdtemp(join(tmpdir(), "figma-window-agent-build-"));
    try {
      const sourcePath = join(buildDir, "main.swift");
      // The output FILENAME becomes the ad-hoc code-signing Identifier, and
      // TCC keys its screen-capture verdicts on that identifier. Compiling to
      // a generic name ("agent") inherited whatever verdict any past binary
      // named "agent" ever earned on the machine — on this fleet, a denial —
      // and every capture died with "connection interrupted" while the same
      // bytes re-signed under a distinct identifier streamed fine (measured).
      // A stable, unique name also means one grant that sticks across builds.
      const outputPath = join(buildDir, "figma-window-agent");
      await writeFile(sourcePath, source, "utf8");
      await execFileAsync("/usr/bin/swiftc", [sourcePath, "-O", "-o", outputPath], { maxBuffer: 4 * 1024 * 1024 });
      await execFileAsync("/usr/bin/codesign", ["-f", "-s", "-", "--identifier", "com.helinlabs.figma-window-agent", outputPath], { maxBuffer: 1024 * 1024 });
      await chmod(outputPath, 0o755);
      await rename(outputPath, binaryPath);
      return binaryPath;
    } finally {
      await rm(buildDir, { recursive: true, force: true });
    }
  })();
  agentBinaryPromise.catch(() => { agentBinaryPromise = null; });
  return agentBinaryPromise;
}

// Compile at relay boot instead of on the first viewer: swiftc took 98s of
// wall clock on a busy machine (6.7s of CPU — the rest was waiting), which
// blew straight through the console's 10s negotiation budget. Warming it up
// front-loads that cost to a moment nobody is watching.
export function warmAgentBinary(): void {
  agentBinary().catch((error) => {
    console.error(`[preview-stream] agent warm-up compile failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

// ---------------------------------------------------------------------------
// WindowAgent: one spawned agent process, framed-stdout parsing, JSON stdin.
// ---------------------------------------------------------------------------
export interface StreamQuality {
  fps?: number;
  maxWidth?: number;
  bitrate?: number;
}

type AgentEvent = Record<string, any>;

class WindowAgent {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private startPromise: Promise<void> | null = null;
  private exitResolve: (() => void) | null = null;
  /** Resolves once the process is truly gone. Two agents capturing the same
   *  window make SCStream fail with "connection interrupted" (measured), so a
   *  successor must wait on this before spawning. */
  exited: Promise<void> = Promise.resolve();
  onAccessUnit: ((pts90k: number, keyframe: boolean, annexB: Buffer) => void) | null = null;
  onEvent: ((event: AgentEvent) => void) | null = null;
  onExit: (() => void) | null = null;
  lastEvents: AgentEvent[] = [];

  constructor(readonly windowMatch: string) {}

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const binary = await agentBinary();
      const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      this.exited = new Promise((resolve) => { this.exitResolve = resolve; });
      child.stdout.on("data", (chunk: Buffer) => this.feed(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.error(`[window-agent:${this.windowMatch}] ${text}`);
      });
      child.on("exit", () => {
        this.child = null;
        this.startPromise = null;
        this.exitResolve?.();
        this.onExit?.();
      });
      this.send({ cmd: "target", match: this.windowMatch });
    })();
    return this.startPromise;
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) break;
      const type = this.buffer[4];
      const payload = this.buffer.subarray(5, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      if (type === 1) {
        try {
          const event = JSON.parse(payload.toString("utf8"));
          this.lastEvents.push(event);
          if (this.lastEvents.length > 20) this.lastEvents.shift();
          this.onEvent?.(event);
        } catch {}
      } else if (type === 4 && payload.length > 9) {
        const pts90k = Number(payload.readBigUInt64BE(0));
        const keyframe = payload[8] === 1;
        // Copy out of the parse buffer: subarray views alias memory that the
        // next concat invalidates.
        this.onAccessUnit?.(pts90k, keyframe, Buffer.from(payload.subarray(9)));
      }
    }
  }

  send(command: Record<string, any>): void {
    this.child?.stdin.write(JSON.stringify(command) + "\n");
  }

  stop(): void {
    const child = this.child;
    if (!child) return;
    this.send({ cmd: "stop" });
    child.stdin.end();
    setTimeout(() => {
      try { child.kill(); } catch {}
    }, 1500).unref?.();
    // An agent stuck inside a hung capture ignores the polite path; a stuck
    // agent left alive holds the window and kills every successor's capture.
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 4000).unref?.();
    // `exited` stays pending until the process is actually gone; the child's
    // exit handler resolves it even though this.child is cleared here.
    this.child = null;
    this.startPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Viewer peer: werift peer connection with a single sendonly H.264 track.
// ---------------------------------------------------------------------------
// Chrome's playout-delay extension (a Google experiment extension, the one
// their own screen sharing uses). Payload is 12 bits of minimum delay then 12
// bits of maximum, both in 10ms units.
const PLAYOUT_DELAY_URI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay";

function playoutDelayPayload(minMs: number, maxMs: number): Buffer {
  const min = Math.max(0, Math.min(0xfff, Math.round(minMs / 10)));
  const max = Math.max(min, Math.min(0xfff, Math.round(maxMs / 10)));
  return Buffer.from([min >> 4, ((min & 0x0f) << 4) | (max >> 8), max & 0xff]);
}

const H264_PAYLOAD_TYPE = 96;

interface SignalSender {
  (message: Record<string, any>): void;
}

class ViewerPeer {
  readonly pc: RTCPeerConnection;
  readonly track: MediaStreamTrack;
  private readonly sequencer = new RtpSequencer();
  private readonly control: any;
  private closed = false;
  onNeedKeyframe: (() => void) | null = null;
  onClosed: (() => void) | null = null;
  // Viewport gestures and input arriving over the peer instead of the tunnel.
  onControl: ((message: any, reply: (payload: any) => void) => void) | null = null;
  // Until the first keyframe goes out, P-frames reference pictures the viewer
  // never saw — drop them instead of feeding the decoder garbage.
  private sentKeyframe = false;
  private transceiver: any = null;
  // Resolved after negotiation: the id the answer agreed on for playout-delay.
  private playoutDelayExt: { id: number; payload: Buffer } | null = null;
  private playoutDelayResolved = false;

  constructor(private readonly signal: SignalSender) {
    this.pc = new RTCPeerConnection({
      codecs: {
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90000,
            rtcpFeedback: [
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "goog-remb" },
            ],
            parameters: "packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=42001f",
          }),
        ],
      },
      // Chrome sizes its jitter buffer from observed inter-arrival and frame
      // SIZE variance, and a screen share is pathological on both counts: long
      // still gaps then a burst, and keyframes tens of times larger than the
      // P-frames around them. Measured here: mean 2.7KB, sd 9.8KB, max 24x mean
      // — which grew the buffer to 235ms and put it straight into the click-to
      // -pixel path. This extension lets the SENDER bound the receiver's
      // playout delay directly, so the estimator's opinion stops mattering.
      headerExtensions: {
        video: [new RTCRtpHeaderExtensionParameters({ uri: PLAYOUT_DELAY_URI })],
      },
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    // Control channel on the SAME peer as the video. Viewport drags used to
    // go out as one HTTP POST per gesture through the nexus tunnel, and the
    // console serialises them one-in-flight — at the tunnel's 34-150ms RTT
    // that caps a drag at ~10 updates/sec and feels steppy. This path is the
    // already-established P2P link (measured 15ms on the same LAN), and it
    // inherits the peer's DTLS plus the signaling channel's auth.
    this.control = this.pc.createDataChannel("control", { ordered: true });
    this.control.onMessage?.subscribe((data: any) => this.handleControl(data));
    this.control.message?.subscribe?.((data: any) => this.handleControl(data));

    this.track = new MediaStreamTrack({ kind: "video" });
    const transceiver = this.pc.addTransceiver(this.track, { direction: "sendonly" });
    this.transceiver = transceiver;
    transceiver.sender.onRtcp.subscribe((rtcp: any) => {
      // PLI or FIR → the viewer lost its picture; answer with an IDR.
      if (rtcp.type === 206) this.onNeedKeyframe?.();
    });
    this.pc.onIceCandidate.subscribe((candidate: any) => {
      if (candidate) this.signal({ type: "webrtc_ice", candidate: candidate.toJSON() });
    });
    this.pc.iceConnectionStateChange.subscribe((state: string) => {
      this.signal({ type: "webrtc_state", state });
      if (state === "failed" || state === "closed" || state === "disconnected") this.close();
    });
  }

  private handleControl(data: any): void {
    let message: any;
    try {
      message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    } catch {
      return;
    }
    // Every request carries an id so the console can resolve its promise; a
    // reply that cannot be sent (channel closing) is dropped, not thrown.
    this.onControl?.(message, (payload) => {
      try {
        if (this.control?.readyState === "open") {
          this.control.send(JSON.stringify({ id: message.id, ...payload }));
        }
      } catch {}
    });
  }

  async offer(): Promise<void> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal({ type: "webrtc_offer", sdp: this.pc.localDescription!.sdp });
  }

  async answer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp, "answer"));
  }

  async addIce(candidate: any): Promise<void> {
    try { await this.pc.addIceCandidate(candidate); } catch {}
  }

  writeAccessUnit(pts90k: number, keyframe: boolean, annexB: Buffer): void {
    if (this.closed) return;
    if (!this.sentKeyframe) {
      if (!keyframe) { this.onNeedKeyframe?.(); return; }
      this.sentKeyframe = true;
    }
    const timestamp = this.sequencer.timestamp(pts90k);
    const payloads = packetizeAccessUnit(annexB, MAX_PAYLOAD_BYTES);
    for (let index = 0; index < payloads.length; index++) {
      const header = new RtpHeader({
        version: 2,
        payloadType: H264_PAYLOAD_TYPE,
        sequenceNumber: this.sequencer.next(),
        timestamp,
        ssrc: this.sequencer.ssrc,
        marker: index === payloads.length - 1,   // last packet of the access unit
      });
      // werift's sender drops extension URIs it has no serialiser for, but it
      // merges back anything already on the header, so setting it here is what
      // actually puts the bytes on the wire.
      const playout = this.playoutDelayExtension();
      if (playout) header.extensions = [playout];
      try {
        this.track.writeRtp(new RtpPacket(header, Buffer.from(payloads[index])));
      } catch {
        // A single failed write is a closing transport; the state handler
        // tears the peer down.
        return;
      }
    }
  }

  // The extension id comes from negotiation, not from us, so read it back
  // rather than assuming the 1 werift happens to assign today.
  private playoutDelayExtension(): { id: number; payload: Buffer } | null {
    if (this.playoutDelayResolved) return this.playoutDelayExt;
    const extensions = this.transceiver?.sender?.headerExtensions
      ?? this.transceiver?.headerExtensions;
    if (!Array.isArray(extensions) || extensions.length === 0) return null;
    this.playoutDelayResolved = true;
    const match = extensions.find((extension: any) => extension?.uri === PLAYOUT_DELAY_URI);
    // min 0 / max 0 is the "render as soon as it decodes" signal. This is a
    // LAN-to-tunnel screen share where a late frame is better dropped than
    // held: holding is exactly the delay being complained about.
    if (match) this.playoutDelayExt = { id: match.id, payload: playoutDelayPayload(0, 0) };
    return this.playoutDelayExt;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Tell the viewer the stream is gone. The browser's own ICE layer can take
    // tens of seconds to notice a closed remote peer, and until then the
    // console showed a live badge over a black frame — measured, not guessed.
    try { this.signal({ type: "webrtc_closed" }); } catch {}
    this.pc.close().catch(() => {});
    this.onClosed?.();
  }
}

// ---------------------------------------------------------------------------
// Manager: channels → agents, sockets → peers.
// ---------------------------------------------------------------------------
interface ChannelStream {
  agent: WindowAgent;
  peers: Set<ViewerPeer>;
  signals: Map<ViewerPeer, SignalSender>;
  quality: Required<StreamQuality>;
  started: boolean;
  lingerTimer: ReturnType<typeof setTimeout> | null;
  // The agent reports its TCC verdicts once at spawn — before any viewer has
  // registered — so keep the last one and replay it to each joiner.
  lastTcc: Record<string, any> | null;
}

// How long a viewer-less agent keeps running before it is stopped. Reloads and
// mode toggles rejoin within seconds, and reusing the live agent both skips
// the re-negotiation stall and — more importantly — avoids overlapping agents
// on one window, which SCStream punishes with "connection interrupted".
const AGENT_LINGER_MS = 10_000;

const DEFAULT_QUALITY: Required<StreamQuality> = { fps: 12, maxWidth: 1280, bitrate: 800_000 };

export class PreviewStreamManager {
  private streams = new Map<string, ChannelStream>();
  private peersBySocket = new Map<unknown, { channel: string; peer: ViewerPeer }>();
  // Last agent stopped per channel — a successor awaits its exit first.
  private stopping = new Map<string, Promise<void>>();

  constructor(
    private readonly windowMatchForChannel: (channel: string) => string | undefined,
    // Forwards a command to the channel's Figma plugin (the relay owns that
    // socket); used for viewport gestures arriving over the control channel.
    private readonly sendPluginCommand?: (channel: string, command: string, params: any) => Promise<any>,
  ) {}

  private streamFor(channel: string): ChannelStream {
    let stream = this.streams.get(channel);
    if (stream) return stream;
    const match = this.windowMatchForChannel(channel) ?? "";
    const agent = new WindowAgent(match);
    stream = { agent, peers: new Set(), signals: new Map(), quality: { ...DEFAULT_QUALITY }, started: false, lingerTimer: null, lastTcc: null };
    agent.onAccessUnit = (pts90k, keyframe, annexB) => {
      for (const peer of stream!.peers) peer.writeAccessUnit(pts90k, keyframe, annexB);
    };
    agent.onEvent = (event) => {
      // Input results and TCC verdicts go to the viewers: a click that failed
      // for a permission the machine lacks must say so in the console, not
      // vanish (posting without the Accessibility grant fails silently).
      if (event.event === "click" || event.event === "key") {
        for (const [, signal] of stream!.signals) {
          signal({ type: "preview_input_result", input: event.event, ok: !!event.ok, key: event.key, reason: event.reason || undefined });
        }
        return;
      }
      if (event.event === "tcc") {
        stream!.lastTcc = { type: "agent_tcc", screenCapture: event.screenCapture, accessibility: !!event.accessibility };
        for (const [, signal] of stream!.signals) signal(stream!.lastTcc);
        return;
      }
      if (event.event === "error") {
        console.error(`[preview-stream:${channel}] agent error: ${event.message}`);
        // A capture that cannot start (window gone, permission missing) would
        // otherwise leave viewers on a connected-but-black peer: ICE succeeds,
        // media never comes. Tell them so the console can fall back.
        for (const [peer, signal] of stream!.signals) {
          signal({ type: "webrtc_error", message: String(event.message || "capture failed") });
          peer.close();
        }
      }
    };
    agent.onExit = () => {
      // The agent dying (window closed, crash) ends the stream for everyone.
      const current = this.streams.get(channel);
      if (!current || current.agent !== agent) return;
      if (current.lingerTimer) clearTimeout(current.lingerTimer);
      for (const peer of [...current.peers]) peer.close();
      this.streams.delete(channel);
    };
    this.streams.set(channel, stream);
    return stream;
  }

  /** Browser asked to start a WebRTC preview on this socket. */
  async startViewer(socket: unknown, channel: string, quality: StreamQuality | undefined, signal: SignalSender): Promise<void> {
    this.stopViewer(socket);
    // Never let a new agent race a predecessor still letting go of the same
    // window — SCStream fails both with "connection interrupted" (measured).
    const predecessor = this.stopping.get(channel);
    if (predecessor) {
      await predecessor;
      this.stopping.delete(channel);
    }
    const stream = this.streamFor(channel);
    if (stream.lingerTimer) {
      clearTimeout(stream.lingerTimer);
      stream.lingerTimer = null;
    }
    if (quality) this.applyQuality(stream, quality);

    const peer = new ViewerPeer(signal);
    peer.onNeedKeyframe = () => stream.agent.send({ cmd: "keyframe" });
    peer.onClosed = () => {
      stream.peers.delete(peer);
      stream.signals.delete(peer);
      const entry = this.peersBySocket.get(socket);
      if (entry?.peer === peer) this.peersBySocket.delete(socket);
      if (stream.peers.size === 0 && !stream.lingerTimer) {
        // Keep the agent warm for quick rejoins instead of stopping it now.
        stream.lingerTimer = setTimeout(() => {
          const current = this.streams.get(channel);
          if (!current || current !== stream || current.peers.size > 0) return;
          this.streams.delete(channel);
          this.stopping.set(channel, stream.agent.exited);
          stream.agent.stop();
        }, AGENT_LINGER_MS);
        (stream.lingerTimer as any).unref?.();
      }
    };
    peer.onControl = (message, reply) => {
      if (message?.type === "viewport") {
        if (!this.sendPluginCommand) { reply({ ok: false, error: "viewport bridge unavailable" }); return; }
        this.sendPluginCommand(channel, message.command || "set_viewport", message.params || {})
          .then((result) => reply({ ok: true, result }))
          .catch((error) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (message?.type === "input") {
        reply({ ok: this.sendInput(channel, message.input || {}) });
        return;
      }
      reply({ ok: false, error: `unknown control message: ${message?.type}` });
    };
    stream.peers.add(peer);
    stream.signals.set(peer, signal);
    this.peersBySocket.set(socket, { channel, peer });
    if (stream.lastTcc) signal(stream.lastTcc);

    await stream.agent.start();
    if (!stream.started) {
      stream.agent.send({ cmd: "config", ...stream.quality });
      stream.started = true;
    } else {
      // A joining viewer needs an IDR before anything it gets is decodable.
      stream.agent.send({ cmd: "keyframe" });
    }
    await peer.offer();
  }

  private applyQuality(stream: ChannelStream, quality: StreamQuality): void {
    stream.quality = {
      fps: quality.fps ?? stream.quality.fps,
      maxWidth: quality.maxWidth ?? stream.quality.maxWidth,
      bitrate: quality.bitrate ?? stream.quality.bitrate,
    };
    if (stream.started) stream.agent.send({ cmd: "config", ...stream.quality });
  }

  /** Quality change from the console (per channel — last writer wins). */
  setQuality(channel: string, quality: StreamQuality): void {
    const stream = this.streams.get(channel);
    if (stream) this.applyQuality(stream, quality);
  }

  async handleAnswer(socket: unknown, sdp: string): Promise<void> {
    await this.peersBySocket.get(socket)?.peer.answer(sdp);
  }

  async handleIce(socket: unknown, candidate: any): Promise<void> {
    await this.peersBySocket.get(socket)?.peer.addIce(candidate);
  }

  /** Click / key from the console, forwarded to the channel's agent (which
   *  enforces the allowlist and coordinate bounds). */
  sendInput(channel: string, input: Record<string, any>): boolean {
    const stream = this.streams.get(channel);
    if (!stream) return false;
    if (input.type === "click") {
      stream.agent.send({
        cmd: "click",
        x: Number(input.x),
        y: Number(input.y),
        clickCount: Number(input.clickCount) || 1,
        button: input.button === "right" ? "right" : "left",
      });
      return true;
    }
    if (input.type === "key") {
      stream.agent.send({
        cmd: "key",
        key: String(input.key || ""),
        modifiers: Array.isArray(input.modifiers) ? input.modifiers.map(String) : [],
      });
      return true;
    }
    return false;
  }

  stopViewer(socket: unknown): void {
    this.peersBySocket.get(socket)?.peer.close();
    this.peersBySocket.delete(socket);
  }

  /** For /status introspection. */
  snapshot(): Record<string, any> {
    return Object.fromEntries(
      [...this.streams.entries()].map(([channel, stream]) => [channel, {
        windowMatch: stream.agent.windowMatch,
        viewers: stream.peers.size,
        quality: stream.quality,
        recentAgentEvents: stream.agent.lastEvents.slice(-5),
      }])
    );
  }
}

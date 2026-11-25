// OpenAI Realtime over WebRTC. The browser never sees the API key: the local
// server mints a client secret (valid ~2 minutes, session config baked in) and
// this posts the SDP offer with it once. Audio flows peer to peer with the
// provider; the browser's own echo cancellation keeps the model's voice out of
// the mic, and barge-in is handled provider-side (interrupt_response).

export async function connect(info, { onEvent, onClose }) {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
  const track = mic.getAudioTracks()[0];
  pc.addTrack(track, mic);
  const dc = pc.createDataChannel("oai-events");
  let closed = false;
  const shut = (why) => {
    if (closed) return;
    closed = true;
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
    mic.getTracks().forEach((t) => t.stop());
    audio.srcObject = null;
    onClose?.(why);
  };
  const send = (obj) => { if (dc.readyState === "open") dc.send(JSON.stringify(obj)); };

  dc.onopen = () => onEvent({ type: "ready" });
  dc.onclose = () => shut("data channel closed");
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") shut(`connection ${pc.connectionState}`);
  };
  dc.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    const out = translate(e);
    if (out) onEvent(out);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  let res;
  try {
    res = await fetch(info.connect.url, {
      method: "POST", body: offer.sdp,
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/sdp" },
    });
  } catch (err) { shut("network"); throw new Error("Couldn't reach OpenAI to open the voice line."); }
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).error?.message || ""; } catch {}
    closed = true; // no onClose for a connection that never opened
    try { pc.close(); } catch {}
    mic.getTracks().forEach((t) => t.stop());
    throw Object.assign(new Error(`OpenAI refused the voice line (${res.status}) ${msg}`.trim()), { status: res.status });
  }
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });

  return {
    respond: () => send({ type: "response.create" }),
    toolResults: (outs, { respond = true } = {}) => {
      for (const o of outs) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.callId, output: JSON.stringify(o.output) } });
      if (respond) send({ type: "response.create" });
    },
    note: (text, { respond = true } = {}) => {
      send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
      if (respond) send({ type: "response.create" });
    },
    mute: (on) => { track.enabled = !on; },
    close: () => shut("closed by app"),
  };
}

const FATAL = new Set(["session_expired", "session_closed"]);

export function translate(e) {
  switch (e.type) {
    case "input_audio_buffer.speech_started": return { type: "user.speaking" };
    case "input_audio_buffer.committed": return { type: "user.pending", itemId: e.item_id };
    case "conversation.item.input_audio_transcription.completed": return { type: "user.final", itemId: e.item_id, text: e.transcript || "" };
    case "conversation.item.input_audio_transcription.failed": return { type: "user.final", itemId: e.item_id, text: "" };
    case "response.created": return { type: "response.started" };
    case "response.output_audio_transcript.delta": return { type: "assistant.delta", text: e.delta || "" };
    case "response.output_audio_transcript.done": return { type: "assistant.done", text: e.transcript || "" };
    case "output_audio_buffer.stopped": return { type: "assistant.audioStopped" };
    case "response.done": {
      const r = e.response || {};
      const toolCalls = (r.output || []).filter((o) => o.type === "function_call")
        .map((o) => ({ callId: o.call_id, name: o.name, args: o.arguments }));
      return { type: "response.done", status: r.status, toolCalls };
    }
    case "error": {
      const err = e.error || {};
      return { type: "error", message: err.message, code: err.code, fatal: FATAL.has(err.code) };
    }
    default: return null;
  }
}

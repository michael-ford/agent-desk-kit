// A stand-in provider for demos and browser tests (INTAKE_TALK_PROVIDER=fake).
// No audio. window.__talkFake drives it:
//   __talkFake.user("text")            the owner says something
//   __talkFake.aide("text")            the model says something
//   __talkFake.tool(name, args)        the model calls a tool (one response)
//   __talkFake.drop()                  the line drops
//   __talkFake.sent                    everything the app sent the "model"

export async function connect(info, { onEvent, onClose }) {
  let open = true;
  let n = 0;
  const fake = (window.__talkFake = window.__talkFake || { sent: [] });
  fake.info = info;
  const emit = (e) => { if (open) onEvent(e); };
  fake.user = (text) => {
    const itemId = `u${++n}`;
    emit({ type: "user.speaking" });
    emit({ type: "user.pending", itemId });
    setTimeout(() => emit({ type: "user.final", itemId, text }), 150);
  };
  fake.aide = (text) => {
    emit({ type: "response.started" });
    const words = text.split(" ");
    words.forEach((w, i) => setTimeout(() => emit({ type: "assistant.delta", text: (i ? " " : "") + w }), 30 * i));
    setTimeout(() => { emit({ type: "assistant.done", text }); emit({ type: "response.done", status: "completed", toolCalls: [] }); emit({ type: "assistant.audioStopped" }); }, 30 * words.length + 50);
  };
  fake.tool = (name, args = {}) => {
    emit({ type: "response.started" });
    setTimeout(() => emit({ type: "response.done", status: "completed", toolCalls: [{ callId: `c${++n}`, name, args: JSON.stringify(args) }] }), 50);
  };
  fake.drop = () => { open = false; onClose("fake drop"); };
  setTimeout(() => emit({ type: "ready" }), 200);
  const record = (kind, payload) => fake.sent.push({ kind, payload, at: Date.now() });
  return {
    respond: () => record("respond"),
    toolResults: (outs) => record("toolResults", outs),
    note: (text) => record("note", text),
    mute: (on) => record("mute", on),
    close: () => { open = false; record("close"); },
  };
}

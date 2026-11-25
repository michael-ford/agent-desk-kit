import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CHANNELS, READER, arrangePage, byDeadline, channel, type HomepageData, type NewsItem, type SeenStore } from "@homepage/agent-core";
import { sendToKobo } from "@/lib/kobo";
import { loadCommentStates, sendComment, type CommentState } from "@/lib/assistant";
import { loadSeen, markClicked, markShown } from "@/lib/seen";

/** Which story's comment box is open (one at a time), and what's been sent. */
interface CommentCtx {
  openId: string | null;
  setOpenId(id: string | null): void;
  states: Record<string, CommentState>;
  setState(url: string, state: CommentState): void;
  /** Story URL just sent, for a few seconds of "Queued for the assistant". */
  justSent: string | null;
  /** A comment was sent: the story counts as read. */
  onSent(item: NewsItem): void;
}
const Comments = createContext<CommentCtx | null>(null);

/**
 * The fixed renderer: draws the agent's HomepageData in the layout the reader approved
 * on 2026-10-09 (white newspaper page, sticky calendar sidebar, masonry cards),
 * with one card per channel and the urgent strip above the lead. The data is
 * model-written from untrusted pages, but it is only ever rendered as text (React
 * escapes it) and the validator only lets http(s) links through.
 */
export function HomepageView({
  data,
  pageBuilt,
  footer,
  onCommentOpen,
}: {
  data: HomepageData;
  /** When this page was built: an item is "seen" once it was shown on an earlier build. */
  pageBuilt: string;
  footer: ReactNode;
  /** A comment box opened or closed (the worker holds its self-reload while one is open). */
  onCommentOpen?: (open: boolean) => void;
}) {
  const now = new Date();
  const [openId, setOpenId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, CommentState>>({});
  const [justSent, setJustSent] = useState<string | null>(null);
  useEffect(() => {
    if (!justSent) return;
    const t = setTimeout(() => setJustSent(null), 5000);
    return () => clearTimeout(t);
  }, [justSent]);
  useEffect(() => {
    void loadCommentStates().then(setStates);
  }, []);
  useEffect(() => onCommentOpen?.(openId !== null), [openId, onCommentOpen]);
  const comments: CommentCtx = {
    openId,
    setOpenId,
    states,
    setState: (url, state) => {
      setStates((prev) => ({ ...prev, [url]: state }));
      setJustSent(url);
    },
    justSent,
    onSent: (item) => read(item),
  };

  // Seen memory, read once per page view: clicks this session dim an item
  // rather than pull it out from under the cursor; it's gone on the next view.
  const [seen, setSeen] = useState<SeenStore | null>(null);
  const [readNow, setReadNow] = useState<Set<string>>(new Set());
  const [openSeen, setOpenSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    void loadSeen().then(setSeen);
  }, [pageBuilt]);
  const view = useMemo(() => arrangePage(data, seen ?? {}, pageBuilt), [data, seen, pageBuilt]);
  const { lead } = view;
  const urgent = [...view.urgent].sort(byDeadline);
  const read = (item: NewsItem) => {
    setReadNow((prev) => new Set(prev).add(item.id));
    void markClicked(item);
  };

  // Shown = this tab was visible for 3 seconds. Records only what is on screen
  // in full or in a "Seen before" line, never the unshown extras.
  useEffect(() => {
    if (!seen) return;
    const onPage = [lead, ...urgent, ...view.channels.flatMap((c) => [...c.fresh, ...c.seen])].filter(
      (i): i is NewsItem => Boolean(i),
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (timer || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void markShown(onPage, pageBuilt), 3000);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") arm();
      else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    arm();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, pageBuilt, seen === null]);

  // Any link or the Kobo button inside an item marks it read (left, middle or cmd-click).
  const byId = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data]);
  const onItemClick = (e: React.MouseEvent) => {
    const target = e.target as Element;
    if (!target.closest("a[href], [data-kobo]")) return;
    const id = target.closest("[data-item-id]")?.getAttribute("data-item-id");
    const item = id ? byId.get(id) : undefined;
    if (item) read(item);
  };
  const dim = (item: NewsItem) => (readNow.has(item.id) ? " hp-read" : "");
  const failed = data.sources.filter((s) => !s.ok);

  return (
    <Comments.Provider value={comments}>
    <div className="hp" onClick={onItemClick} onAuxClick={onItemClick}>
      <header className="hp-mast">
        <h1>Good {timeOfDay(now)}{READER.name ? `, ${READER.name}` : ""}.</h1>
        <span className="hp-date">
          {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}{READER.place ? ` · ${READER.place}` : ""}
        </span>
      </header>

      <div className="hp-page">
        <main>
          {urgent.length > 0 && (
            <section className="hp-urgent">
              <div className="hp-kicker">Act on · {urgent.length}</div>
              {urgent.map((item) => (
                <div className={`hp-urgent-row${dim(item)}`} key={item.id} data-item-id={item.id}>
                  <span className="hp-by">{item.action?.by ? shortDate(item.action.by) : "now"}</span>
                  <div>
                    <a className="hp-urgent-headline" href={item.url} target="_blank" rel="noreferrer" title={item.summary}>
                      {item.headline}
                    </a>
                    {item.action && <div className="hp-urgent-action">{item.action.what}</div>}
                    <Meta item={item} now={now} />
                  </div>
                </div>
              ))}
            </section>
          )}

          {lead && (
            <section className={`hp-lead${dim(lead)}`} data-item-id={lead.id}>
              <div style={{ flex: 1 }}>
                <div className="hp-kicker" style={{ color: channel(lead.channel).colour }}>
                  {channel(lead.channel).label} · Lead
                </div>
                <h2>
                  <a href={lead.url} target="_blank" rel="noreferrer">
                    {lead.headline}
                  </a>
                </h2>
                <Meta item={lead} now={now} />
                {lead.action && <div className="hp-urgent-action">{lead.action.what}</div>}
                {lead.summary && <div className="hp-summary">{lead.summary}</div>}
              </div>
              <Pie score={lead.score} colour={channel(lead.channel).colour} size={34} />
            </section>
          )}

          <div className="hp-cards">
            {CHANNELS.map((c) => {
              const cv = view.channels.find((v) => v.key === c.key)!;
              const rows = cv.fresh;
              const pinnedHere = [lead, ...urgent].filter((i) => i?.channel === c.key).length;
              return (
                <section className="hp-card" key={c.key} style={{ borderTopColor: c.colour }}>
                  <div className="hp-card-head">
                    <span className="hp-kicker" style={{ color: c.colour }}>
                      {c.label}
                    </span>
                    <span className="hp-count">
                      {rows.length}
                      {pinnedHere ? ` · ${pinnedHere} above` : ""}
                    </span>
                  </div>
                  {rows.length === 0 && <div className="hp-quiet">Nothing new since you last looked.</div>}
                  {rows.map((item, i) => (
                    <div className={`hp-row${i === 0 ? " hp-top" : ""}${dim(item)}`} key={item.id} title={item.summary} data-item-id={item.id}>
                      <Pie score={item.score} colour={c.colour} size={16} />
                      <div style={{ flex: 1 }}>
                        <h3>
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.headline}
                          </a>
                        </h3>
                        <Meta item={item} now={now} />
                      </div>
                    </div>
                  ))}
                  {cv.seen.length > 0 && (
                    <div className="hp-seen">
                      <button
                        className="hp-seen-toggle"
                        onClick={() =>
                          setOpenSeen((prev) => {
                            const next = new Set(prev);
                            if (!next.delete(c.key)) next.add(c.key);
                            return next;
                          })
                        }
                      >
                        Seen before ({cv.seen.length}) {openSeen.has(c.key) ? "▴" : "▾"}
                      </button>
                      {openSeen.has(c.key) &&
                        cv.seen.map((item) => (
                          <div className={`hp-seen-row${dim(item)}`} key={item.id} data-item-id={item.id} title={item.summary}>
                            <a href={item.url} target="_blank" rel="noreferrer">
                              {item.headline}
                            </a>
                            <span className="hp-meta-inline">
                              {" "}
                              · {item.source}
                              {item.publishedAt ? ` · ${age(item.publishedAt, now)}` : ""}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {(data.alsoSeen || failed.length > 0) && (
            <div className="hp-also">
              {data.alsoSeen && <>Also seen: {data.alsoSeen} </>}
              {failed.length > 0 && (
                <>Failed to load: {failed.map((s) => (s.note ? `${s.name} (${s.note})` : s.name)).join(", ")}.</>
              )}
            </div>
          )}

          {(data.github.onYou.length > 0 || data.github.following.length > 0) && (
            <section className="hp-gh">
              <h4>GitHub</h4>
              {data.github.onYou.map((r) => (
                <div className="hp-gh-row" key={r.url}>
                  {r.reason && <span className="hp-reason">{r.reason}</span>}
                  <code>
                    {r.repo}
                    {r.number ? `#${r.number}` : ""}
                  </code>
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                </div>
              ))}
              {data.github.following.length > 0 && (
                <div className="hp-gh-following">
                  {data.github.following.map((r) => (
                    <div className="hp-gh-row" key={r.url}>
                      <code>
                        {r.repo}
                        {r.number ? `#${r.number}` : ""}
                      </code>
                      <a href={r.url} target="_blank" rel="noreferrer">
                        {r.title}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <footer className="hp-stamp">{footer}</footer>
        </main>

        <aside className="hp-side">
          {data.calendar.length > 0 && (
            <section className="hp-cal">
              <h4>Calendar</h4>
              {data.calendar.map((day) => (
                <div key={day.label}>
                  <h5>{day.label}</h5>
                  {day.events.length === 0 && <div className="hp-cal-row">Nothing scheduled</div>}
                  {day.events.map((e, i) => (
                    <div className="hp-cal-row" key={i}>
                      <b>{e.time}</b>
                      <span>{e.title}</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
    </Comments.Provider>
  );
}

/** Source · age, the "→ world" chips, link chips, and the Send-to-Kobo button. */
function Meta({ item, now }: { item: NewsItem; now: Date }) {
  return (
    <div className="hp-meta">
      {item.update && (
        <span className="hp-update" title="You've seen this story; this is what changed">
          Update: {item.update}
        </span>
      )}
      <span>
        {item.source}
        {item.publishedAt ? ` · ${age(item.publishedAt, now)}` : ""}
      </span>
      {item.touches.map((t) => (
        <span className="hp-touch" key={t}>
          → {t}
        </span>
      ))}
      {item.chips.map((c) => (
        <a className="hp-chip" key={c.url} href={c.url} target="_blank" rel="noreferrer">
          {c.label}
        </a>
      ))}
      <KoboButton url={item.url} />
      <CommentButton item={item} />
      <CommentBox item={item} />
    </div>
  );
}

function CommentButton({ item }: { item: NewsItem }) {
  const ctx = useContext(Comments)!;
  const state = ctx.states[item.url];
  const title = !state
    ? "Comment for your assistant"
    : state.status === "queued"
      ? `Comment queued for the assistant (${new Date(state.at).toLocaleString()}). Click to add another.`
      : "Comment saved; it sends when Intake Triage is running. Click to add another.";
  return (
    <button
      className={`hp-kobo hp-comment-btn${ctx.openId === item.id ? " hp-active" : ""}`}
      title={title}
      onClick={() => ctx.setOpenId(ctx.openId === item.id ? null : item.id)}
    >
      {state?.status === "queued" ? "💬✓" : state?.status === "waiting" ? "💬…" : "💬"}
      {ctx.justSent === item.url && state && (
        <span className="hp-comment-note">
          {state.status === "queued" ? "Queued for the assistant" : "Saved: sends when Intake Triage is running"}
        </span>
      )}
    </button>
  );
}

/** The text box under a story. Enter sends, Shift+Enter is a new line, Esc closes. */
function CommentBox({ item }: { item: NewsItem }) {
  const ctx = useContext(Comments)!;
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "sending" | "error"; message?: string }>({ kind: "idle" });
  const ref = useRef<HTMLTextAreaElement>(null);
  const open = ctx.openId === item.id;
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;

  const close = () => {
    ctx.setOpenId(null);
    setText("");
    setStatus({ kind: "idle" });
  };
  const send = async () => {
    if (!text.trim() || status.kind === "sending") return;
    setStatus({ kind: "sending" });
    try {
      const result = await sendComment({ url: item.url, headline: item.headline, prompt: text });
      ctx.onSent(item);
      ctx.setState(item.url, { status: result, at: new Date().toISOString() });
      close();
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="hp-comment">
      <textarea
        ref={ref}
        value={text}
        rows={3}
        maxLength={1500}
        placeholder="For your assistant: what should it do with this story?"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="hp-comment-bar">
        <span className={status.kind === "error" ? "hp-comment-error" : ""}>
          {status.kind === "sending"
            ? "Sending…"
            : status.kind === "error"
              ? `Not sent: ${status.message}`
              : "Enter sends to the assistant, Esc cancels"}
        </span>
        <button onClick={close}>Cancel</button>
        <button onClick={() => void send()} disabled={!text.trim() || status.kind === "sending"}>
          Send
        </button>
      </div>
    </div>
  );
}

function KoboButton({ url }: { url: string }) {
  const [state, setState] = useState<{ label: string; title: string }>({ label: "📖", title: "Send to Kobo" });
  return (
    <button
      className="hp-kobo"
      data-kobo
      title={state.title}
      onClick={() => {
        setState({ label: "…", title: "Sending to Kobo" });
        sendToKobo(url).then(
          (r) =>
            setState({
              label: "✓",
              title: r === "queued" ? "Sent to Kobo: it syncs once the EPUB is built" : "Already in your Kobo library",
            }),
          (err) => setState({ label: "!", title: `Kobo send failed: ${err instanceof Error ? err.message : String(err)}` }),
        );
      }}
    >
      {state.label}
    </button>
  );
}

function Pie({ score, colour, size }: { score: number; colour: string; size: number }) {
  return (
    <span
      className="hp-pie"
      title={`Score ${score}`}
      style={{ width: size, height: size, background: `conic-gradient(${colour} ${score}%, #ececec 0)` }}
    />
  );
}

function timeOfDay(d: Date): string {
  const h = d.getHours();
  return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : "evening";
}

function age(iso: string, now: Date): string {
  const hours = (now.getTime() - Date.parse(iso)) / 3600_000;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "Oct 24" from YYYY-MM-DD, without a timezone shift. */
function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

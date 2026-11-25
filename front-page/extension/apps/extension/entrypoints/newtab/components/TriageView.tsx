import { useCallback, useEffect, useState } from "react";
import { INTAKE_BASE, intakeRunning } from "@/lib/assistant";

/**
 * The Intake Triage app (~/tools/intake-triage), embedded. It's a local server
 * (see triage/README.md for running it as a LaunchAgent); its frame-ancestors header allows
 * this extension, and its Host/Origin guards pass because the frame talks to
 * its own origin. The mic is delegated with allow="microphone"; Chrome asks
 * for permission on the extension page's behalf.
 */
export function TriageView() {
  const [up, setUp] = useState<boolean | null>(null);

  const probe = useCallback(async () => setUp(await intakeRunning()), []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // While it's down, keep checking so the view comes up on its own once the server does.
  useEffect(() => {
    if (up !== false) return;
    const t = setInterval(probe, 5000);
    return () => clearInterval(t);
  }, [up, probe]);

  return (
    <div className="triage">
      {up === true && <iframe src={`${INTAKE_BASE}/`} title="Intake Triage" allow="microphone; autoplay; clipboard-write" />}
      {up === false && (
        <div className="triage-down">
          <h2>Intake Triage isn't running</h2>
          <p>
            Keep it running with a LaunchAgent (see triage/README.md in the kit). To start it by hand, run{" "}
            <code>~/tools/intake-triage/run.sh</code>. This view checks again every few seconds.
          </p>
          <button onClick={() => void probe()}>Retry now</button>
        </div>
      )}
      <a className="triage-open" href={INTAKE_BASE} target="_blank" rel="noreferrer">
        Open in its own tab
      </a>
    </div>
  );
}

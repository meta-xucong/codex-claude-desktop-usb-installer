import { useCallback, useEffect, useRef, useState } from "react";
import { managerApi } from "../../services/managerApi";
import { FailureBanner } from "../components";
import { resolveFailure, type FailureSurface } from "../errorCopy";
import { useI18n } from "../i18n";
import { Icon } from "../icons";

type LocalState = Awaited<ReturnType<typeof managerApi.usbClaudeStatus>>;

export function ClaudeDesktopAction({ disabled, busy, observing, progress, onBusy }: {
  disabled: boolean;
  busy: boolean;
  observing: boolean;
  progress: string | null;
  onBusy: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<LocalState | null>(null);
  const [failure, setFailure] = useState<FailureSurface | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);
  const check = useCallback(async () => {
    const id = ++generation.current;
    setFailure(null);
    setState(null);
    try {
      const next = await managerApi.usbClaudeStatus();
      if (id === generation.current) setState(next);
    } catch (cause) {
      if (id === generation.current) setFailure(resolveFailure(cause, t));
    }
  }, [t]);
  useEffect(() => {
    if (!observing) void check();
    return () => { ++generation.current; };
  }, [check, observing]);

  async function open() {
    if (disabled || busy || pending.current) return;
    pending.current = true;
    onBusy(true);
    setFailure(null);
    const id = ++generation.current;
    let opening = false;
    try {
      const current = state ?? await managerApi.usbClaudeStatus();
      opening = current === "ready";
      if (current === "ready") await managerApi.usbClaudeOpen();
      else await managerApi.usbClaudePrepare();
      if (id === generation.current) setState("ready");
    } catch (cause) {
      if (id === generation.current) {
        setState(null);
        setFailure(resolveFailure(cause, t));
        if (opening) {
          const latest = await managerApi.usbClaudeStatus().catch(() => null);
          if (id === generation.current) setState(latest);
        }
      }
    } finally {
      pending.current = false;
      onBusy(false);
    }
  }
  const label = observing ? "claude.working" : busy ? (state === "ready" ? "claude.opening" : "claude.working")
    : state ? `claude.${state}` as const : failure ? "claude.retry" : "claude.check";
  return <>
    <button className={state === "ready" ? "btn big claude-launch" : "btn ghost"} onClick={() => void open()}
      disabled={disabled || busy || (!state && !failure)}>
      {state === "ready" && <Icon name={busy ? "loader" : "play"} className={busy ? "spinicon" : undefined} />}
      {t(label)}
    </button>
    {progress && <div className="sub progress-activity" role="status">{progress}</div>}
    {failure && <FailureBanner failure={failure} />}
  </>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { managerApi } from "../../services/managerApi";
import { FailureBanner } from "../components";
import { resolveFailure, type FailureSurface } from "../errorCopy";
import { useI18n } from "../i18n";
import claudeMark from "../claude-mark.svg";
import { Icon } from "../icons";

type LocalState = Awaited<ReturnType<typeof managerApi.usbClaudeStatus>>;

export const canOpenClaude = (state: LocalState | null): state is "ready" | "components-pending" => state === "ready" || state === "components-pending";

export function ClaudeDesktopAction({ disabled, busy, observing, updating, launchOnly, progress, onBusy, onState }: {
  launchOnly: boolean;
  disabled: boolean;
  busy: boolean;
  observing: boolean;
  updating?: boolean;
  progress: string | null;
  onState: (value: LocalState | null) => void;
  onBusy: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<LocalState | null>(null);
  useEffect(() => { onState(state); return () => onState(null); }, [state, onState]);
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
      opening = canOpenClaude(current);
      if (opening) await managerApi.usbClaudeOpen();
      else if (!launchOnly) await managerApi.usbClaudePrepare();
      else return;
      if (id === generation.current && current !== "ready") {
        const next = await managerApi.usbClaudeStatus();
        if (id === generation.current) setState(next);
      }
    } catch (cause) {
      if (id === generation.current) {
        setState(null);
        setFailure(resolveFailure(cause, t));
        const latest = await managerApi.usbClaudeStatus().catch(() => null);
        if (id === generation.current && (opening || canOpenClaude(latest))) setState(latest);
      }
    } finally {
      pending.current = false;
      onBusy(false);
    }
  }
  const launchable = canOpenClaude(state);
  if (launchOnly && !launchable) return null;
  const label = updating ? "dual.updatingClaude" : observing ? "claude.working" : busy ? (launchable ? "claude.opening" : "claude.working")
    : launchable ? "claude.ready" : state ? `claude.${state}` as const : failure ? "claude.retry" : "claude.check";
  return <>
    <button className={launchable ? "btn big claude-launch" : "btn ghost"} onClick={() => void open()}
      disabled={disabled || busy || (!state && !failure)}>
      {launchable && (busy ? <Icon name="loader" className="spinicon" /> : <img src={claudeMark} width="18" height="18" alt="" />)}
      {t(label)}
    </button>
    {progress && <div className="sub progress-activity" role="status">{progress}</div>}
    {failure && <FailureBanner failure={failure} />}
  </>;
}

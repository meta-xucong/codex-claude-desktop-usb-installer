import { useCallback, useEffect, useId, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  errorCode,
  errorMessage,
  managerApi,
  type CodexPayloadCheck,
  type UpdateInfo,
} from "../../services/managerApi";
import type {
  CapabilityPackInstallOptions,
  CapabilityPackReport,
  CcswitchLaunchReport,
  DownloadProgress,
  HistoricalInstallSelection,
  OfflinePayloadReport,
  OfflineStageReport,
  UsbGuardStatus,
  UsbHostStatus,
  WinInstallStatus,
} from "../../shared/types";
import {
  contextualFailure,
  resolveFailure,
  type FailureSurface,
} from "../errorCopy";
import { Icon, CodexGlyph } from "../icons";
import { useI18n, type TFn } from "../i18n";
import { FailureBanner, Ring, StatusBanner, Tooltip, TopBar } from "../components";
import { mib } from "../format";
import { Sheet } from "../Sheet";
import { OfflineComponentsSheet, type OfflineComponentsView } from "./OfflineComponentsSheet";
import { AccountCard, type AccountAuthorizationState } from "./AccountCard";
import { canOpenClaude, ClaudeDesktopAction } from "./ClaudeDesktopAction";
import { SkillRepoUpdateCard } from "./SkillRepoUpdateCard";
import { UpstreamModelManagerSheet } from "./UpstreamModelManagerSheet";
import { ProgressScreen, type DualInstallStep } from "./ProgressScreen";
import { useDownloadProgress } from "./useDownloadProgress";
import { selectMediaModels } from "../mediaModelSelection";

type OfflinePhase = "loading" | "ready" | "installed" | "staging" | "installing" | "error";

type PayloadUpdateProgress = {
  phase: "preparing" | "download" | "done";
  bytesDone?: number;
  bytesTotal?: number;
};

const CAPABILITY_INSTALL_PROGRESS_KEYS = {
  "pack.validate": "offline.installActivity.pack.validate",
  "pack.skills": "offline.installActivity.pack.skills",
  "runtime.verify": "offline.installActivity.runtime.verify",
  "runtime.python": "offline.installActivity.runtime.python",
  "runtime.manim": "offline.installActivity.runtime.manim",
  "runtime.nodeMedia": "offline.installActivity.runtime.nodeMedia",
  "runtime.hyperframes": "offline.installActivity.runtime.hyperframes",
  "runtime.hyperframesFfmpeg": "offline.installActivity.runtime.hyperframesFfmpeg",
  "runtime.hyperframesCliCheck": "offline.installActivity.runtime.hyperframesCliCheck",
  "runtime.hyperframesBrowser": "offline.installActivity.runtime.hyperframesBrowser",
  "runtime.hyperframesBrowserCheck": "offline.installActivity.runtime.hyperframesBrowserCheck",
  "runtime.feishu": "offline.installActivity.runtime.feishu",
  "runtime.environment": "offline.installActivity.runtime.environment",
  "runtime.complete": "offline.installActivity.runtime.complete",
  "pack.pdf": "offline.installActivity.pack.pdf",
  "pack.media": "offline.installActivity.pack.media",
  "pack.config": "offline.installActivity.pack.config",
  "pack.models": "offline.installActivity.pack.models",
  "pack.finalize": "offline.installActivity.pack.finalize",
} as const;

const USB_GUARD_STARTUP_FAST_POLL_LIMIT = 60;
const HOST_PROGRESS_KEYS = {
  check: "offline.host.check", capabilities: "offline.host.capabilities",
  account: "offline.host.account", verify: "offline.host.verify",
} as const;

const CLAUDE_STAGE_KEYS = {
  desktop: "dual.stage.desktop", service: "dual.stage.service",
  account: "dual.stage.account", runtime: "dual.stage.runtime",
  register: "dual.stage.register", profile: "dual.stage.profile", seed: "dual.stage.seed",
  skills: "dual.stage.skills", connections: "dual.stage.connections",
  finalize: "dual.stage.finalize", complete: "dual.stage.complete",
} as const;
const USB_GUARD_STARTUP_FAST_POLL_MS = 250;
const USB_GUARD_NORMAL_POLL_MS = 1_000;

const DEFAULT_CAPABILITY_PACK_OPTIONS: CapabilityPackInstallOptions = {
  enableFeishu: true,
  // Persist only the non-secret model selections below. The signed USB key
  // stays in the DPAPI credential store and is never written to the registry.
  persistConnections: true,
  feishuAppId: "",
  feishuAppSecret: "",
  feishuUserAccessToken: "",
  feishuDomain: "https://open.feishu.cn",
  feishuAuthMode: "tenant",
  enabledApiServices: [],
  enabledRemoteMcps: [],
  enableMediaGeneration: true,
  mediaGatewayCatalogStatus: "not-checked",
  mediaGatewayModelCount: 0,
  mediaGatewayCatalogVerifiedAt: null,
  dashscopeApiKey: "",
  dashscopeBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  dashscopeModel: "",
  mediaGenerationAgentId: "",
  image2Model: "",
  grokImageModel: "",
  grokVideoModel: "",
  seedanceModel: "",
  minimaxVideoModel: "",
};

function versionParts(value: string): number[] {
  return value
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function selectionFromStage(stage: OfflineStageReport): HistoricalInstallSelection {
  const payload = stage.payload;
  return {
    // A USB payload's manifest tag describes provenance and may be rewritten
    // by the hot-update channel. The local MSIX installer uses the canonical
    // local-signed namespace, so never feed an upstream tag into its stale
    // expectation check.
    releaseTag: `local-signed-${payload.codexDesktopVersion}`,
    version: payload.codexDesktopVersion,
    assetName: payload.fileName,
    architecture: payload.architecture === "arm64" ? "arm64" : "x64",
    format: "msix",
    packageVersion: payload.packageVersion,
    localPath: stage.stagedPath,
    localFileName: payload.fileName,
  };
}

function expectedFromStatus(status: WinInstallStatus | null) {
  // Preserve the fresh snapshot for the backend's TOCTOU check. The USB path
  // deliberately rejects an existing external or non-current installation;
  // this is not an adoption/migration expectation.
  const installed = status?.installed ?? null;
  return {
    currentPath: installed?.path ?? null,
    currentVersion: installed?.version ?? null,
    currentSource: installed?.source ?? null,
  };
}

function canUpdateCodexPayload(guard: UsbGuardStatus | null): boolean {
  return Boolean(
    guard?.signed &&
      guard.removable &&
      guard.bundlePath &&
      ((guard.status === "authorized" &&
        guard.watchdog === "running" &&
        guard.codexAllowed !== false) ||
        (guard.status === "restricted" &&
          guard.revocationState === "reactivated_payload_missing" &&
          guard.reinstallAllowed === true)),
  );
}

function ccswitchUserMessage(message: string | null | undefined, fallback: string): string {
  const value = message?.trim();
  // The native command may return a short machine/test status (for example
  // "launched") or an actionable Chinese diagnostic. Keep the translated
  // user-facing status for the former while preserving useful diagnostics for
  // the latter.
  if (!value || value.length < 4 || !/[\u4e00-\u9fff]|Codex\s*Switch|CCSwitch|404token/i.test(value)) {
    return fallback;
  }
  return value;
}

type CcswitchInjectionIssue =
  | "unsupported-binary"
  | "missing-binding"
  | "failed"
  | "launch-failed"
  | "unconfirmed";

const CCSWITCH_INJECTION_ISSUE_STORAGE_KEY = "codex-usb-ccswitch-injection-issue-v1";

function readStoredCcswitchInjectionIssue(): CcswitchInjectionIssue | null {
  try {
    if (typeof window === "undefined") return null;
    const value = window.localStorage.getItem(CCSWITCH_INJECTION_ISSUE_STORAGE_KEY);
    return value === "unsupported-binary" || value === "missing-binding" ||
      value === "failed" || value === "launch-failed" || value === "unconfirmed"
      ? value
      : null;
  } catch {
    return null;
  }
}

function ccswitchInjectionIssueFor(
  report: CcswitchLaunchReport | null,
): CcswitchInjectionIssue | null {
  if (
    report?.accountInjectionStatus === "verified" &&
    report.accountInjected === true
  ) {
    return null;
  }
  switch (report?.accountInjectionStatus) {
    case "unsupported-binary":
      return "unsupported-binary";
    case "missing-binding":
      return "missing-binding";
    case "failed":
      return "failed";
    case "injected":
    case "pending":
    case "unconfirmed":
      return "unconfirmed";
    case "unavailable":
      return "launch-failed";
    case "verified":
      return report?.accountInjected === true ? null : "unconfirmed";
    case "not-attempted":
    default:
      return report?.launched ? "unconfirmed" : "launch-failed";
  }
}

function ccswitchInjectionMessageKey(issue: CcswitchInjectionIssue): Parameters<TFn>[0] {
  switch (issue) {
    case "unsupported-binary":
      return "offline.ccswitchInjection.unsupported";
    case "missing-binding":
      return "offline.ccswitchInjection.missingBinding";
    case "launch-failed":
      return "offline.ccswitchInjection.launchFailed";
    case "unconfirmed":
      return "offline.ccswitchInjection.unconfirmed";
    default:
      return "offline.ccswitchInjection.failed";
  }
}

function codexReadyOnAuthorizedUsb(guard: UsbGuardStatus | null): boolean {
  return Boolean(
    guard?.status === "authorized" &&
      guard.watchdog === "running" &&
      guard.signed &&
      guard.codexAllowed === true,
  );
}

function codexActionsAllowedOnCurrentRuntime(
  guard: UsbGuardStatus | null,
  guardQueryFailed = false,
): boolean {
  // A null guard is the ordinary installed-manager path. Once the USB guard
  // is present, every Codex action must wait for live signed authorization.
  return !guardQueryFailed && (guard === null || codexReadyOnAuthorizedUsb(guard));
}

function codexInstallAllowedOnCurrentRuntime(
  guard: UsbGuardStatus | null,
  guardQueryFailed = false,
): boolean {
  if (guardQueryFailed) return false;
  return Boolean(
    codexActionsAllowedOnCurrentRuntime(guard, guardQueryFailed) ||
      (guard?.status === "restricted" &&
        guard.signed &&
        guard.removable &&
        Boolean(guard.bundlePath) &&
        guard.revocationState === "reactivated_payload_missing" &&
        guard.reinstallAllowed === true),
  );
}

function programIsOnCurrentUsb(
  status: WinInstallStatus | null,
  guard: UsbGuardStatus | null,
): boolean {
  const installPath = status?.installed?.path;
  const bundlePath = guard?.bundlePath;
  if (!installPath || !bundlePath || status?.installed?.source !== "portable") return false;
  const normalize = (value: string) => value
    .trim()
    .replace(/^\\\\[?.]\\/i, "")
    .replace(/\//g, "\\")
    .replace(/[\\]+$/, "")
    .toLowerCase();
  return normalize(installPath) === `${normalize(bundlePath)}\\apps\\codex`;
}

/**
 * A portable install whose path is proven to belong to the currently
 * authorized USB bundle is usable even when the first winStatus snapshot
 * was classified as `external` while the USB guard was still starting.
 * The path/source/bundle proof remains the ownership boundary; the status
 * label itself is only a cached classification and must not strand a valid
 * USB install after the manager is restarted.
 */
function currentUsbInstallMatchesPayload(
  status: WinInstallStatus | null,
  guard: UsbGuardStatus | null,
  payloadVersion: string | undefined,
): boolean {
  const installed = status?.installed;
  return Boolean(
    payloadVersion &&
      codexReadyOnAuthorizedUsb(guard) &&
      installed &&
      !installed.appVersionUnavailable &&
      !status?.recoveryPending &&
      compareVersions(installed.version, payloadVersion) === 0 &&
      programIsOnCurrentUsb(status, guard),
  );
}

function currentUsbVersionUnavailable(status: WinInstallStatus | null, guard: UsbGuardStatus | null) {
  return status?.installed?.appVersionUnavailable === true && !status.recoveryPending &&
    programIsOnCurrentUsb(status, guard);
}

function usbInstallBlockedByExistingCodex(
  status: WinInstallStatus | null,
  guard: UsbGuardStatus | null,
): boolean {
  if (!status) return false;
  // On a fresh launch win_status can be read before the USB watchdog has
  // re-established its lease.  A stale `external` classification must not
  // hide a portable tree that is visibly inside the current verified bundle.
  if (programIsOnCurrentUsb(status, guard)) return false;
  return status.status === "external" || Boolean(status.installed);
}

function configNeedsAttention(report: CapabilityPackReport): boolean {
  return (
    report.coreReady &&
    report.runtimeReady &&
    !report.success &&
    ["partial", "failed", "conflict"].includes(report.configStatus)
  );
}

function usbGuardLabel(status: string, t: TFn): string {
  switch (status) {
    case "authorized": return t("offline.usbGuard.authorized");
    case "grace": return t("offline.usbGuard.grace");
    case "missing": return t("offline.usbGuard.missing");
    case "mismatch": return t("offline.usbGuard.mismatch");
    case "unsupported": return t("offline.usbGuard.unsupported");
    case "starting": return t("offline.usbGuard.starting");
    case "initialization-failed": return t("offline.usbGuard.initializationFailed");
    case "disabled": return t("offline.usbGuard.disabled");
    case "stopped": return t("offline.usbGuard.stopped");
    default: return status;
  }
}

function usbGuardStartupPending(guard: UsbGuardStatus | null): boolean {
  return guard?.status === "starting";
}

/**
 * Minimal USB portable Windows screen. The shipped payload remains the
 * default/offline source, while a signed USB bundle can explicitly check for a
 * newer payload and then reuse the same guarded install path to deploy it.
 */
export function OfflineHome({
  onOpenSettings,
  onOpenUninstall,
  feishuConnectionRequest = 0,
}: {
  onOpenSettings: () => void;
  onOpenUninstall?: () => void;
  feishuConnectionRequest?: number;
}) {
  const { t, lang } = useI18n();
  const [phase, setPhase] = useState<OfflinePhase>("loading");
  const [payload, setPayload] = useState<OfflinePayloadReport | null>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [status, setStatus] = useState<WinInstallStatus | null>(null);
  const [usbGuard, setUsbGuard] = useState<UsbGuardStatus | null>(null);
  const [hostStatus, setHostStatus] = useState<UsbHostStatus | null>(null);
  const [hostInitializing, setHostInitializing] = useState(false);
  const [claudeSetupRevision, setClaudeSetupRevision] = useState(0);
  const [claudeState, setClaudeState] = useState<Awaited<ReturnType<typeof managerApi.usbClaudeStatus>> | null>(null);
  const [claudeReattached, setClaudeReattached] = useState(false);
  const [usbGuardQueryFailed, setUsbGuardQueryFailed] = useState(false);
  const [failure, setFailure] = useState<FailureSurface | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ccswitchInjectionIssue, setCcswitchInjectionIssue] =
    useState<CcswitchInjectionIssue | null>(readStoredCcswitchInjectionIssue);
  const [installationDetail, setInstallationDetail] = useState<string | null>(null);
  const [capabilityInstallError, setCapabilityInstallError] = useState<string | null>(null);
  const [activityKey, setInstallActivity] = useState<Parameters<TFn>[0] | null>(null);
  const installActivity = activityKey ? t(activityKey) : null;
  const [dualStep, setDualStep] = useState<DualInstallStep>();
  const claudeProgressRevision = useRef(0);
  const [claudeUpdateStage, setClaudeUpdateStage] = useState("");
  const showClaudeStage = useCallback((stage: string) => {
    if (stage.startsWith("update:")) {
      setClaudeUpdateStage(stage.slice(7));
      return;
    }
    if (!Object.hasOwn(CLAUDE_STAGE_KEYS, stage)) return;
    setDualStep(["desktop", "register", "service", "account", "profile"].includes(stage) ? 3 : 4);
    setInstallActivity(CLAUDE_STAGE_KEYS[stage as keyof typeof CLAUDE_STAGE_KEYS]);
  }, []);
  const [componentsOpen, setComponentsOpen] = useState(false);
  const [componentsView, setComponentsView] = useState<OfflineComponentsView>("connections");
  useEffect(() => {
    if (feishuConnectionRequest > 0) {
      setComponentsView("connections");
      setComponentsOpen(true);
    }
  }, [feishuConnectionRequest]);
  const [pendingCodexUpdate, setPendingCodexUpdate] = useState<UpdateInfo | null>(null);
  const [codexUpdateConfirmOpen, setCodexUpdateConfirmOpen] = useState(false);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [payloadUpdateProgress, setPayloadUpdateProgress] =
    useState<PayloadUpdateProgress | null>(null);
  const [busyAction, setBusyAction] = useState<
    "install" | "update" | "claudeUpdate" | "launch" | "claude" | "ccswitch" | "logs" | "status" | null
  >(null);
  const updateTitleId = useId();
  const updateBodyId = useId();
  const loadGeneration = useRef(0);
  const usbGuardStartupPolls = useRef(0);
  const progressScopeRef = useRef<HTMLDivElement | null>(null);
  const usbGuardWasReady = useRef(false);
  const skipHostStatusAfterLaunch = useRef(false);
  const updateCcswitchInjectionIssue = useCallback((issue: CcswitchInjectionIssue | null) => {
    setCcswitchInjectionIssue(issue);
    try {
      if (typeof window === "undefined") return;
      if (issue) {
        window.localStorage.setItem(CCSWITCH_INJECTION_ISSUE_STORAGE_KEY, issue);
      } else {
        window.localStorage.removeItem(CCSWITCH_INJECTION_ISSUE_STORAGE_KEY);
      }
    } catch {
      // The banner still works for this session when storage is unavailable.
    }
  }, []);
  const lastComponentWarning = useRef<string | null>(null);
  const clearHostSetupErrors = useCallback(() => {
    updateCcswitchInjectionIssue(null);
    setCapabilityInstallError(null);
    setNotice(null);
  }, [updateCcswitchInjectionIssue]);
  const refreshHostStatus = useCallback(async () => {
    const next = await managerApi.usbHostStatus();
    setHostStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<string>("usb-host://progress", (event) => {
      if (active && event.payload in HOST_PROGRESS_KEYS) {
        setInstallActivity(HOST_PROGRESS_KEYS[event.payload as keyof typeof HOST_PROGRESS_KEYS]);
      }
    }).then((cleanup) => { if (active) unlisten = cleanup; else cleanup(); });
    return () => { active = false; unlisten?.(); };
  }, [t]);

  // Renderer reload only observes the existing lease; it cannot submit again.
  useEffect(() => {
    let active = true;
    const stop = listen<string>("claude-desktop://progress", ({ payload }) => {
      if (active) {
        claudeProgressRevision.current++;
        showClaudeStage(payload);
      }
    });
    return () => { active = false; void stop.then(off => off()); };
  }, [showClaudeStage]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (reattached?: "host" | "claude") => {
      try {
        const revision = claudeProgressRevision.current;
        const snapshot = await managerApi.getOperationSnapshot();
        if (!active) return;
        const source = snapshot?.progress?.source ?? "";
        if (source.startsWith("usb-host:")) {
          setHostInitializing(true);
          const stage = source.slice("usb-host:".length);
          // The snapshot has only the host phase. Keep finer live pack activity between polls.
          if (reattached !== "host" && stage in HOST_PROGRESS_KEYS) {
            setInstallActivity(current => current ?? HOST_PROGRESS_KEYS[stage as keyof typeof HOST_PROGRESS_KEYS]);
          }
          timer = setTimeout(() => void read("host"), 1000);
        } else if (source === "claude-desktop" || source.startsWith("claude-desktop:")) {
          setClaudeReattached(true);
          if (revision === claudeProgressRevision.current && source.startsWith("claude-desktop:")) {
            showClaudeStage(source.slice("claude-desktop:".length));
          }
          timer = setTimeout(() => void read("claude"), 1000);
        } else if (reattached === "claude") {
          setClaudeReattached(false);
          setDualStep(undefined);
          setInstallActivity(null);
        } else if (reattached === "host") {
          setHostInitializing(false);
          setInstallActivity(null);
          const current = await refreshHostStatus();
          if (current.ready) clearHostSetupErrors();
        }
      } catch (cause) { if (active && reattached) { setHostInitializing(false); setClaudeReattached(false); setFailure(resolveFailure(cause, t)); } }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [clearHostSetupErrors, refreshHostStatus, showClaudeStage, t]);

  const {
    dl,
    downloadProgress,
    installProgress,
    dlPct,
    dlBytes,
    dlSpeed,
    downloadStop,
    downloadStopBusy,
    startDlListen,
    requestDownloadStop,
    resetStop,
  } = useDownloadProgress({
    eventName: "win://download-progress",
    pauseDownload: (operationId) => managerApi.winPauseDownload(operationId),
    cancelDownload: (operationId) => managerApi.winCancelDownload(operationId),
    getOperationSnapshot: () => managerApi.getOperationSnapshot(),
    onError: setFailure,
  });

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void startDlListen().then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [startDlListen]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<PayloadUpdateProgress>("payload-update-progress", (event) => {
      if (active) setPayloadUpdateProgress(event.payload);
    }).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<string>("capability-pack://progress", (event) => {
      if (!active || !(event.payload in CAPABILITY_INSTALL_PROGRESS_KEYS)) return;
      const key = CAPABILITY_INSTALL_PROGRESS_KEYS[
        event.payload as keyof typeof CAPABILITY_INSTALL_PROGRESS_KEYS
      ];
      setInstallActivity(key);
    }).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [t]);

  const load = useCallback(async (verifyPayload = false) => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setPhase("loading");
    setHostStatus(null);
    setPayload(null);
    setPayloadLoading(true);
    setFailure(null);
    setNotice(null);
    setInstallationDetail(null);
    setCapabilityInstallError(null);
    setUsbGuardQueryFailed(false);
    try {
      // The payload probe hashes the complete MSIX and may also inspect its
      // Authenticode chain. Do not make that expensive local read the first
      // visible response to a double-click; render the local status shell as
      // soon as the cheap manager/guard probes finish, then fill the payload
      // details in the background.
      const [nextStatus, nextUsbGuardResult] = await Promise.all([
        managerApi.winStatus(),
        managerApi.usbGuardStatus()
          .then((value) => ({ value, failed: false }))
          .catch(() => ({ value: null, failed: true })),
      ]);
      if (loadGeneration.current !== generation) return;
      const nextUsbGuard = nextUsbGuardResult.value;
      setStatus(nextStatus);
      setUsbGuard(nextUsbGuard);
      setUsbGuardQueryFailed(nextUsbGuardResult.failed);
      if (nextStatus.recoveryPending) {
        setNotice(t("offline.recoveryPending"));
      } else if (usbInstallBlockedByExistingCodex(nextStatus, nextUsbGuard)) {
        setNotice(
          nextStatus.status === "external"
            ? t("offline.external")
            : t("offline.existingOutsideUsb"),
        );
      }
      // Show the shell while authorization and any required payload probe settle.
      setPhase("ready");
      const declaredVersion = nextStatus.usbPayloadVersion;
      const installed = nextStatus.installed;
      const useManifestVersion = !verifyPayload && declaredVersion && installed
        && !nextStatus.recoveryPending && !nextUsbGuardResult.failed
        && (usbGuardStartupPending(nextUsbGuard) || (codexReadyOnAuthorizedUsb(nextUsbGuard)
          && programIsOnCurrentUsb(nextStatus, nextUsbGuard)))
        && (installed.appVersionUnavailable || compareVersions(installed.version, declaredVersion) === 0);
      let nextPayload: OfflinePayloadReport | null;
      try {
        const previewOnly = !installed && !verifyPayload && !nextStatus.recoveryPending
          && !nextUsbGuardResult.failed && (usbGuardStartupPending(nextUsbGuard) || codexReadyOnAuthorizedUsb(nextUsbGuard));
        nextPayload = useManifestVersion ? null : await managerApi.offlinePayloadProbe(undefined, previewOnly);
      } catch (probeError) {
        // A revoked cleanup deliberately removes the bundle MSIX. Keep the
        // manager shell available so the signed, backend-gated payload
        // recovery action can download it again. `starting` is also allowed
        // here because the startup integrity worker may still be resolving
        // this exact state.
        let recoveryGuard = nextUsbGuard;
        if (!nextUsbGuardResult.failed) {
          try {
            recoveryGuard = await managerApi.usbGuardStatus();
            if (loadGeneration.current !== generation) return;
            setUsbGuard(recoveryGuard);
            setUsbGuardQueryFailed(false);
          } catch {
            recoveryGuard = null;
          }
        }
        if (
          usbGuardStartupPending(recoveryGuard) ||
          (!nextUsbGuardResult.failed &&
            recoveryGuard?.status === "restricted" &&
            recoveryGuard.revocationState === "reactivated_payload_missing" &&
            recoveryGuard.reinstallAllowed === true)
        ) {
          setPayload(null);
          setPayloadLoading(false);
          setPhase("ready");
          setNotice(
            recoveryGuard?.reinstallAllowed
              ? t("offline.reactivationPayloadMissing")
              : null,
          );
          return;
        }
        throw probeError;
      }
      if (loadGeneration.current !== generation) return;

      // The initial guard snapshot can legitimately be `starting`: the
      // complete bundle/AuthentiCode walk runs in a background startup worker.
      // Refresh once after the expensive payload probe so the action gates use
      // a live authorization result instead of the stale startup snapshot.
      let settledUsbGuard = nextUsbGuard;
      if (!nextUsbGuardResult.failed) {
        try {
          settledUsbGuard = await managerApi.usbGuardStatus();
          if (loadGeneration.current !== generation) return;
          setUsbGuard(settledUsbGuard);
          setUsbGuardQueryFailed(false);
        } catch {
          if (loadGeneration.current !== generation) return;
          setUsbGuardQueryFailed(true);
        }
      }
      // The initial status probe can race the background USB lease startup.
      // Re-read it once after the guard has settled so a current USB install is
      // not left with the pre-authorization `external` snapshot.
      let settledStatus = nextStatus;
      const guardReady = codexReadyOnAuthorizedUsb(settledUsbGuard);
      usbGuardWasReady.current = guardReady;
      if (
        guardReady &&
        (!codexReadyOnAuthorizedUsb(nextUsbGuard) || currentUsbVersionUnavailable(nextStatus, settledUsbGuard))
      ) {
        try {
          settledStatus = await managerApi.winStatus();
          if (loadGeneration.current !== generation) return;
          setStatus(settledStatus);
        } catch {
          if (loadGeneration.current !== generation) return;
          usbGuardWasReady.current = false;
        }
      }
      setPayload(nextPayload);
      setPayloadLoading(false);
      if (currentUsbInstallMatchesPayload(settledStatus, settledUsbGuard, nextPayload?.codexDesktopVersion ?? settledStatus.usbPayloadVersion)) {
        // A startup snapshot can leave an "installed elsewhere" notice
        // behind while USB authorization is still settling. The proven USB
        // install must win once the path and version have been confirmed.
        setNotice(null);
        setPhase("installed");
      } else {
        setPhase("ready");
      }
    } catch (cause) {
      if (loadGeneration.current !== generation) return;
      setPayload(null);
      setPayloadLoading(false);
      setStatus(null);
      setPhase("error");
      setFailure(resolveFailure(cause, t));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const usbGuardStatus = usbGuard?.status;

  // The helper writes a fresh status roughly once per second. While the
  // startup integrity worker is active, use a short-lived fast poll so the
  // controls unlock immediately after authorization becomes live. The normal
  // one-second cadence remains the long-lived fallback and keeps the visible
  // countdown useful without adding a WebSocket or privileged service.
  useEffect(() => {
    // The modal owns a long, scrollable form. The watchdog countdown is not
    // useful while it is open, and updating it would needlessly re-render the
    // whole page behind the modal once per second.
    if (componentsOpen || (!usbGuardStatus && !usbGuardQueryFailed)) return;
    let active = true;
    let timer: number | null = null;
    if (usbGuardStatus && usbGuardStatus !== "starting") {
      usbGuardStartupPolls.current = 0;
    }
    const poll = () => {
      void managerApi
        .usbGuardStatus()
        .then(async (next) => {
          if (!active) return;
          const ready = codexReadyOnAuthorizedUsb(next);
          const becameReady = ready && !usbGuardWasReady.current;
          usbGuardWasReady.current = ready;
          if (becameReady && (payload || status?.usbPayloadVersion)) {
            try {
              const nextStatus = await managerApi.winStatus();
              if (!active) return;
              setStatus(nextStatus);
              if (currentUsbInstallMatchesPayload(nextStatus, next, payload?.codexDesktopVersion ?? nextStatus.usbPayloadVersion)) {
                setNotice(null);
                setPhase((previous) => previous === "ready" ? "installed" : previous);
              }
            } catch {
              if (!active) return;
              usbGuardWasReady.current = false;
            }
          }
          setUsbGuard(next);
          setUsbGuardQueryFailed(false);
          if (usbGuardStartupPending(next)) {
            usbGuardStartupPolls.current += 1;
          } else {
            usbGuardStartupPolls.current = 0;
          }
          const fastPoll =
            usbGuardStartupPending(next) &&
            usbGuardStartupPolls.current <= USB_GUARD_STARTUP_FAST_POLL_LIMIT;
          timer = window.setTimeout(
            poll,
            fastPoll ? USB_GUARD_STARTUP_FAST_POLL_MS : USB_GUARD_NORMAL_POLL_MS,
          );
        })
        .catch(() => {
          if (!active) return;
          usbGuardWasReady.current = false;
          setUsbGuardQueryFailed(true);
          timer = window.setTimeout(poll, USB_GUARD_NORMAL_POLL_MS);
        });
    };
    timer = window.setTimeout(
      poll,
      usbGuardStatus === "starting" ? 0 : USB_GUARD_NORMAL_POLL_MS,
    );
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [componentsOpen, payload, status?.usbPayloadVersion, usbGuardQueryFailed, usbGuardStatus]);

  const performInstall = useCallback(async (
    sourcePayload: OfflinePayloadReport,
    intent: "install" | "repair" | "update",
  ) => {
    setPayload(sourcePayload);
    setFailure(null);
    setNotice(null);
    setInstallationDetail(null);
    setInstallActivity(null);
    let stage: OfflineStageReport | null = null;
    let pendingRecovery = false;
    let verifiedInstalled: WinInstallStatus | null = null;
    try {
      const [current, guardResult] = await Promise.all([
        managerApi.winStatus(),
        managerApi.usbGuardStatus()
          .then((value) => ({ value, failed: false }))
          .catch(() => ({ value: null, failed: true })),
      ]);
      const currentGuard = guardResult.value;
      setStatus(current);
      setUsbGuard(currentGuard);
      setUsbGuardQueryFailed(guardResult.failed);
      const dualInstall = current.usbClaudeIncluded && intent !== "update";
      if (!codexInstallAllowedOnCurrentRuntime(currentGuard, guardResult.failed)) {
        setPhase("ready");
        setNotice(t("offline.installRequiresAuthorized"));
        return false;
      }
      if (usbInstallBlockedByExistingCodex(current, currentGuard)) {
        throw new Error(current.status === "external" ? t("offline.external") : t("offline.existingOutsideUsb"));
      }
      if (intent === "install") {
        if (currentUsbInstallMatchesPayload(current, currentGuard, sourcePayload.codexDesktopVersion)) {
          verifiedInstalled = current;
          if (current.usbClaudeIncluded) {
            setDualStep(2);
            setHostInitializing(true);
            try {
              const host = await managerApi.initializeUsbHost(true);
              setHostStatus(host);
              if (!host.accountReady) throw new Error(host.message);
              if (host.ready) clearHostSetupErrors();
              showClaudeStage("desktop");
              await managerApi.usbClaudePrepare();
              setClaudeSetupRevision(value => value + 1);
            } finally {
              setHostInitializing(false);
              setInstallActivity(null);
            }
          }
          setPhase("installed");
          return true;
        }
        if (currentUsbVersionUnavailable(current, currentGuard)) {
          setPhase("ready");
          return false;
        }
      }
      if (dualInstall) {
        setDualStep(1);
        setInstallActivity("offline.installActivity.binding");
      }
      setPhase("staging");
      // Local installation needs the signed binding. Gateway reachability is
      // reported by the catalog stage and does not block a verified local pack.
      const installPreflight = await managerApi.winCheckInstallPreflight();
      if (!installPreflight.apiKeyReady) {
        setPhase("ready");
        setNotice(t("offline.installRequiresBinding"));
        return false;
      }
      if (dualInstall) setInstallActivity("offline.installActivity.staging");
      stage = await managerApi.offlinePayloadStage();
      setInstallActivity(null);
      setPhase("installing");
      // A historical USB install owns the same progress lease as the normal
      // Windows flow. Reset the previous event owner before the new operation
      // so a late packet from an earlier install cannot paint this one.
      resetStop();
      const result = await managerApi.winInstallHistoricalRelease(
        selectionFromStage(stage),
        // Keep the shipped desktop build fixed for the USB edition. The backend
        // extracts the verified program tree below this bundle while the normal
        // user profile on the local system keeps mutable data.
        true,
        expectedFromStatus(current),
        undefined,
        undefined,
        true,
        true,
      );
      if (!result.success) {
        throw new Error(result.message || t("error.install"));
      }
      setInstallActivity("offline.installActivity.verify");
      // Preserve the recovery/backup locations even when the subsequent
      // configurator succeeds. A CCSwitch notice must not hide this evidence.
      setInstallationDetail(result.message);
      setCapabilityInstallError(null);
      const installed = await managerApi.winStatus();
      if (installed.recoveryPending) {
        pendingRecovery = true;
        setStatus(installed);
        throw new Error(t("offline.recoveryPending"));
      }
      if (
        installed.status !== "managed" ||
        !installed.installed || installed.installed.appVersionUnavailable ||
        compareVersions(installed.installed.version, stage.payload.codexDesktopVersion) !== 0
      ) {
        throw new Error(t("offline.verifyAfterInstall"));
      }
      const verifiedUsbGuardResult = await managerApi.usbGuardStatus()
        .then((value) => ({ value, failed: false }))
        .catch(() => ({ value: null, failed: true }));
      const verifiedUsbGuard = verifiedUsbGuardResult.value;
      if (
        !codexActionsAllowedOnCurrentRuntime(verifiedUsbGuard, verifiedUsbGuardResult.failed) ||
        !programIsOnCurrentUsb(installed, verifiedUsbGuard)
      ) {
        if (verifiedUsbGuardResult.failed) setUsbGuardQueryFailed(true);
        const installPath = installed.installed.path || "未知";
        const bundlePath = verifiedUsbGuard?.bundlePath || "未知";
        throw new Error(`无法确认 Codex 程序位于当前 U 盘套件（程序 ${installPath}，套件 ${bundlePath}），已保留暂存文件，请查看日志后重试`);
      }
      setUsbGuard(verifiedUsbGuard);
      setPayload(stage.payload);
      verifiedInstalled = installed;
      if (dualInstall) setDualStep(2);
      // Keep diagnostic staging until all installed-state/placement checks
      // pass. A verification failure must not claim a deleted file was kept.
      setInstallActivity("offline.installActivity.cleanup");
      await managerApi.offlinePayloadCleanup(stage.stagedPath).catch(() => undefined);
      if (intent === "update" && programIsOnCurrentUsb(current, currentGuard)) {
        // A desktop update replaces the program tree. The existing host status
        // effect refreshes local readiness when the update operation finishes.
        setStatus(installed);
        setInstallActivity(null);
        setPhase("installed");
        return true;
      }
      // Codex is now confirmed on disk. Install the complete local capability
      // pack first, then hand off to CCSwitch. Either auxiliary component is
      // best-effort: a failure never rolls back a verified Codex installation
      // and remains retryable from the quiet Components entry below.
      let capabilityPackReport: CapabilityPackReport | null = null;
      let capabilityPackErrorDetail: string | null = null;
      let mediaModelsAvailable = false;
      let mediaCatalogStatus: CapabilityPackInstallOptions["mediaGatewayCatalogStatus"] = "failed";
      try {
        let mediaGatewayModelCount = 0;
        let mediaGatewayCatalogVerifiedAt: string | null = null;
        let mediaModels = {
          mediaGenerationAgentId: "",
          image2Model: "",
          grokImageModel: "",
          grokVideoModel: "",
          seedanceModel: "",
          minimaxVideoModel: "",
        };
        try {
          setInstallActivity("offline.components.mediaModelsLoading");
          // This is an authenticated GET /v1/models lookup only; it does not
          // submit a paid image or video generation request.
          const catalog = await managerApi.mediaModelCatalog();
          mediaModels = selectMediaModels(catalog.models, { includeSeedance: false });
          const existingSeedanceModel = catalog.configuredSeedanceModel?.trim() ?? "";
          const existingAgentId = catalog.configuredAgentId?.trim() ?? "";
          if (existingSeedanceModel && existingAgentId && catalog.models.includes(existingSeedanceModel)) {
            mediaModels.seedanceModel = existingSeedanceModel;
            mediaModels.mediaGenerationAgentId = existingAgentId;
          }
          mediaGatewayModelCount = catalog.models.length;
          mediaGatewayCatalogVerifiedAt = new Date().toISOString();
          mediaCatalogStatus = "verified";
          mediaModelsAvailable = Object.entries(mediaModels).some(
            ([name, model]) => name !== "mediaGenerationAgentId" && Boolean(model),
          );
        } catch {
          console.warn("[media-mcp] model catalog lookup failed; MCP registration will continue with saved or default settings");
          try {
            const saved = await managerApi.mediaModelSettings();
            mediaModels = {
              mediaGenerationAgentId: saved.mediaGenerationAgentId,
              image2Model: saved.image2Model,
              grokImageModel: saved.grokImageModel,
              grokVideoModel: saved.grokVideoModel,
              seedanceModel: saved.seedanceModel,
              minimaxVideoModel: "",
            };
            mediaModelsAvailable = saved.licensedCredentialAvailable && Boolean(
              mediaModels.image2Model ||
              mediaModels.grokImageModel ||
              mediaModels.grokVideoModel ||
              (mediaModels.seedanceModel && mediaModels.mediaGenerationAgentId),
            );
          } catch {
            // Without either a live catalog or readable local selections, the
            // safe behavior is to leave only this MCP disabled.
          }
        }
        setInstallActivity("offline.installActivity.capability");
        capabilityPackReport = await managerApi.installCapabilityPack({
          ...DEFAULT_CAPABILITY_PACK_OPTIONS,
          // A failed catalog lookup is not evidence that previously saved
          // media models are stale. Preserve those user slots for retry.
          persistConnections: mediaCatalogStatus === "verified",
          ...mediaModels,
          // Register the local MCP regardless of upstream catalog availability.
          // The MCP wrapper resolves its default image route after saved settings.
          enableMediaGeneration: true,
          mediaGatewayCatalogStatus: mediaCatalogStatus,
          mediaGatewayModelCount,
          mediaGatewayCatalogVerifiedAt,
        }, true);
      } catch (capabilityError) {
        capabilityPackErrorDetail = errorMessage(capabilityError);
        console.warn("[capability-pack] automatic install failed", capabilityError);
      }
      let ccswitchReport = null;
      let ccswitchErrorDetail: string | null = null;
      try {
        setInstallActivity("offline.ccswitchLaunching");
        ccswitchReport = await managerApi.installAndLaunchCcswitch();
      } catch (ccswitchError) {
        ccswitchErrorDetail = errorMessage(ccswitchError);
        console.warn("[ccswitch] automatic launch failed", ccswitchError);
      }
      const injectionIssue = ccswitchInjectionIssueFor(ccswitchReport);
      updateCcswitchInjectionIssue(injectionIssue);
      if (dualInstall) setInstallActivity("offline.host.verify");
      const finalHostStatus = await managerApi.usbHostStatus().catch((cause) => {
        setFailure(resolveFailure(cause, t));
        return null;
      });
      setHostStatus(finalHostStatus);
      if (dualInstall && finalHostStatus?.accountReady) {
        showClaudeStage("desktop");
        await managerApi.usbClaudePrepare();
        setClaudeSetupRevision(value => value + 1);
      }
      // The backend returns a media-enabled install report only after its
      // registration check. An exception or unmerged config is not evidence.
      const mediaRegistrationConfirmed = capabilityPackReport?.configStatus === "merged";
      if (capabilityPackErrorDetail) {
        setCapabilityInstallError(capabilityPackErrorDetail);
      } else if (mediaRegistrationConfirmed && !mediaModelsAvailable) {
        const mediaMessage = mediaCatalogStatus === "failed"
          ? "无法读取上游模型目录"
          : "上游暂未返回可识别的图片或视频模型";
        setInstallationDetail(
          `${result.message}\n${mediaMessage}，媒体 MCP 已注册；可在“连接与扩展”重新检测模型。`,
        );
      } else if (mediaRegistrationConfirmed && mediaCatalogStatus === "failed") {
        setInstallationDetail(
          `${result.message}\n上游模型目录暂不可读，已保留本机现有媒体模型与 MCP 设置；本次没有刷新模型列表。`,
        );
      }
      setStatus(installed);
      setInstallActivity(null);
      setPhase("installed");
      const notices: string[] = [];
      if (current.usbClaudeIncluded && intent !== "update" && !finalHostStatus?.accountReady) {
        notices.push(t("dual.accountPending"));
      }
      const beforeComponentNotice = notices.length;
      if (capabilityPackReport?.coreReady && capabilityPackReport.success) {
        notices.push(
          t("offline.capabilityInstalled", {
            skills: capabilityPackReport.skills,
            agents: capabilityPackReport.agents,
          }),
        );
      } else if (capabilityPackReport?.coreReady && configNeedsAttention(capabilityPackReport)) {
        notices.push(
          t("offline.capabilityConfigConflict", {
            skills: capabilityPackReport.skills,
            agents: capabilityPackReport.agents,
          }),
        );
      } else if (capabilityPackReport?.coreReady) {
        notices.push(
          t("offline.capabilityPartial", {
            skills: capabilityPackReport.skills,
            agents: capabilityPackReport.agents,
          }),
        );
      } else {
        if (!dualInstall || !finalHostStatus?.accountReady) notices.push(t("offline.capabilityFailed"));
      }
      lastComponentWarning.current = capabilityPackReport?.success ? null : notices[beforeComponentNotice] ?? null;
      if (mediaRegistrationConfirmed && !mediaModelsAvailable) {
        notices.push(
          mediaCatalogStatus === "failed"
            ? "媒体 MCP 已注册：当前无法读取上游模型目录，可在“连接与扩展”重试检测。"
            : "媒体 MCP 已注册：当前未发现可识别模型，可在“连接与扩展”重新检测。",
        );
      } else if (mediaRegistrationConfirmed && mediaCatalogStatus === "failed") {
        notices.push("上游模型目录暂不可读，本次继续使用已有媒体模型设置。");
      }
      if (!injectionIssue && ccswitchReport?.launched) {
        notices.push(ccswitchUserMessage(ccswitchReport.message, t("offline.ccswitchLaunched")));
      } else if (!injectionIssue && ccswitchReport && !ccswitchReport.available) {
        notices.push(t("offline.ccswitchUnavailable"));
      } else if (!injectionIssue && ccswitchErrorDetail) {
        notices.push(`${t("offline.ccswitchFailed")} ${ccswitchErrorDetail}`);
      } else if (!injectionIssue) {
        notices.push(t("offline.ccswitchFailed"));
      }
      setNotice(notices.join(" "));
      if (intent === "update" && !finalHostStatus?.accountReady) return "host-pending" as const;
      return finalHostStatus?.accountReady ?? false;
    } catch (cause) {
      if (verifiedInstalled) setStatus(verifiedInstalled);
      setInstallActivity(null);
      setPhase(verifiedInstalled ? "installed" : "ready");
      setFailure(resolveFailure(cause, t));
      if (pendingRecovery) {
        setNotice(t("offline.recoveryPending"));
      } else if (stage && !verifiedInstalled) {
        setNotice("暂存文件已保留，便于查看日志和重试。");
      }
      return intent === "update" && verifiedInstalled ? "host-pending" as const : false;
    } finally { setDualStep(undefined); }
  }, [clearHostSetupErrors, resetStop, showClaudeStage, t, updateCcswitchInjectionIssue]);

  const install = useCallback(async (intent: "install" | "repair") => {
    if (busyAction) return;
    if (!codexInstallAllowedOnCurrentRuntime(usbGuard, usbGuardQueryFailed)) {
      setNotice(t("offline.installRequiresAuthorized"));
      return;
    }
    setBusyAction("install");
    try {
      const source = payload ?? await managerApi.offlinePayloadProbe();
      setPayload(source);
      await performInstall(source, intent);
    } catch (cause) {
      setFailure(resolveFailure(cause, t));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, payload, performInstall, t, usbGuard, usbGuardQueryFailed]);

  const codexPayloadAvailable = !usbGuardQueryFailed && canUpdateCodexPayload(usbGuard);
  const dualEdition = status?.usbClaudeIncluded === true;
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [codexResult, setCodexResult] = useState<CodexPayloadCheck | null>(null);
  type ClaudeCheck = Awaited<ReturnType<typeof managerApi.usbClaudeCheckUpdate>>;
  const [claudeResult, setClaudeResult] = useState<ClaudeCheck | {kind: "failed"; message: string} | null>(null);
  const [claudeUpdateFailure, setClaudeUpdateFailure] = useState<FailureSurface | null>(null);
  const checkingGeneration = useRef(0);
  useEffect(() => {
    ++checkingGeneration.current;
    setUpdatesOpen(false);
  }, [usbGuard?.bundlePath]);
  const checkBoth = useCallback(() => {
    const generation = ++checkingGeneration.current;
    setCodexResult(null);
    setClaudeResult(null);
    setClaudeUpdateFailure(null);
    setUpdatesOpen(true);
    setNotice(null);
    setFailure(null);
    void managerApi.checkCodexPayloadUpdate().catch((cause) => ({
      kind: "unavailable" as const, message: resolveFailure(cause, t).message,
    })).then(result => { if (generation === checkingGeneration.current) setCodexResult(result); });
    void managerApi.usbClaudeCheckUpdate().catch((cause) => ({
      kind: "failed" as const, message: resolveFailure(cause, t).message,
    })).then(result => { if (generation === checkingGeneration.current) setClaudeResult(result); });
  }, [t]);
  const applyClaudeUpdate = async () => {
    if (busyAction || claudeResult?.kind !== "available") return;
    setBusyAction("claudeUpdate");
    setClaudeUpdateStage("manifest");
    setClaudeUpdateFailure(null);
    const generation = checkingGeneration.current;
    try {
      const changed = await managerApi.usbClaudeUpdate(claudeResult.expected);
      if (generation !== checkingGeneration.current) return;
      setClaudeResult({kind: "none"});
      setNotice(t(changed ? "claude.updated" : "claude.current"));
    } catch (cause) {
      if (generation === checkingGeneration.current) setClaudeUpdateFailure(resolveFailure(cause, t, {sanitizeDetail: true}));
    } finally {
      setBusyAction(null);
    }
  };
  const updateStages = {
    manifest: "dual.updateManifest", desktop: "dual.downloadDesktop", code: "dual.downloadCode",
    "retry-desktop": "dual.resumeDesktop", "retry-code": "dual.resumeCode",
    verify: "dual.updateVerify", extract: "dual.updateExtract", activate: "dual.updateActivate",
  } as const;
  const [step, percent] = claudeUpdateStage.split(" ");
  const updateActivity = Object.hasOwn(updateStages, step)
    ? t(updateStages[step as keyof typeof updateStages]) + (percent === undefined ? "" : ` · ${percent}%`)
    : t("dual.updateManifest");

  const checkCodexPayload = useCallback(async (allowWhileBusy = false) => {
    if (busyAction && !allowWhileBusy) return;
    if (!codexPayloadAvailable) {
      setNotice(t("offline.updateRequiresSigned"));
      return;
    }
    if (dualEdition && !usbGuard?.reinstallAllowed) { checkBoth(); return; }
    setBusyAction("update");
    setFailure(null);
    setNotice(null);
    setPendingCodexUpdate(null);
    try {
      const result: CodexPayloadCheck = await managerApi.checkCodexPayloadUpdate();
      if (result.kind === "available") {
        if (allowWhileBusy) {
          setNotice(
            t("offline.updateStaleRefreshed", {
              version: result.info.latestVersion,
            }),
          );
        }
        setPendingCodexUpdate(result.info);
        setCodexUpdateConfirmOpen(true);
      } else if (result.kind === "none") {
        setNotice(t("offline.updateUpToDate"));
      } else if (result.kind === "development") {
        setNotice(t("about.mgrDev"));
      } else {
        setFailure(
          contextualFailure(
            result.message || t("offline.updateUnavailable"),
            t,
            t("offline.updateUnavailable"),
            "network",
          ),
        );
      }
    } catch (cause) {
      setFailure(resolveFailure(cause, t));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, codexPayloadAvailable, dualEdition, usbGuard?.reinstallAllowed, checkBoth, t]);

  const applyCodexPayload = useCallback(async (candidate = pendingCodexUpdate) => {
    if (!candidate || busyAction) return;
    setBusyAction("update");
    setFailure(null);
    setNotice(null);
    setPayloadUpdateProgress({ phase: "preparing", bytesDone: 0, bytesTotal: 0 });
    try {
      await managerApi.applyCodexPayloadUpdate(candidate);
      setPayloadUpdateProgress(null);
      const nextPayload = await managerApi.offlinePayloadProbe();
      setPayload(nextPayload);
      setPendingCodexUpdate(null);
      setCodexUpdateConfirmOpen(false);
      const deployed = await performInstall(nextPayload, "update");
      if (deployed) {
        if (deployed === "host-pending") {
          setNotice(previous => [t("offline.updateHostPending"), previous].filter(Boolean).join(" "));
        } else {
          setNotice(t("offline.updateApplied"));
        }
        setCodexResult({ kind: "none" });
      } else {
        setNotice(t("offline.updatePayloadAppliedRetry"));
        setCodexResult({kind:"unavailable",message:t("offline.updatePayloadAppliedRetry")});
      }
    } catch (cause) {
      setPayloadUpdateProgress(null);
      if (updatesOpen) setCodexResult({kind:"unavailable", message:resolveFailure(cause,t).message});
      if (errorCode(cause) === "stale_expectation") {
        setPendingCodexUpdate(null);
        setCodexUpdateConfirmOpen(false);
        // The backend deliberately rejects the old confirmation. Re-check
        // once against the same signed USB instead of leaving the user with a
        // dead-end banner; the fresh candidate still needs an explicit click.
        await checkCodexPayload(true);
      } else {
        setFailure(resolveFailure(cause, t));
        setCodexUpdateConfirmOpen(false);
      }
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, checkCodexPayload, pendingCodexUpdate, performInstall, updatesOpen, t]);

  const retryCcswitchInjection = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("ccswitch");
    setFailure(null);
    try {
      const report = await managerApi.installAndLaunchCcswitch();
      const issue = ccswitchInjectionIssueFor(report);
      updateCcswitchInjectionIssue(issue);
      if (issue) {
        setNotice(null);
      } else {
        setNotice(ccswitchUserMessage(report.message, t("offline.ccswitchLaunched")));
      }
    } catch {
      updateCcswitchInjectionIssue("failed");
      setNotice(null);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, t, updateCcswitchInjectionIssue]);

  const launchCcswitch = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("ccswitch");
    setFailure(null);
    try {
      // Keep compatibility with older manager previews that do not expose the
      // split restore command yet; production builds always use openCcswitch.
      const openCcswitch =
        typeof managerApi.openCcswitch === "function"
          ? managerApi.openCcswitch
          : managerApi.installAndLaunchCcswitch;
      const report = await openCcswitch();
      if (report.launched) {
        setNotice(ccswitchUserMessage(report.message, t("offline.ccswitchLaunched")));
      } else if (!report.available) {
        setNotice(t("offline.ccswitchUnavailable"));
      } else {
        setNotice(ccswitchUserMessage(report.message, t("offline.ccswitchFailed")));
      }
    } catch (cause) {
      setFailure(resolveFailure(cause, t));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, t]);

  const launch = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("launch");
    setFailure(null);
    try {
      const normalizedLang = lang.toLowerCase();
      const codexLocale = normalizedLang.startsWith("zh")
        ? normalizedLang.startsWith("zh-tw")
          ? "zh-TW"
          : "zh-CN"
        : undefined;
      try {
        await managerApi.winLaunch(codexLocale);
        if (hostStatus?.ready) clearHostSetupErrors();
      } catch (cause) {
        // Only the launch gate can decide that this computer needs setup.
        if (errorCode(cause) !== "usb_host_not_ready") throw cause;
        setHostInitializing(true);
        setInstallActivity("offline.host.check");
        // This USB product uses its authorized account by default. The backend
        // changes only the managed account fields and verifies the handoff.
        const initialized = await managerApi.initializeUsbHost(true);
        setHostStatus(initialized);
        if (!initialized.accountReady) throw new Error(initialized.message);
        if (initialized.ready) clearHostSetupErrors();
        await managerApi.winLaunch(codexLocale);
      }
    } catch (cause) {
      setFailure(resolveFailure(cause, t));
      await refreshHostStatus().catch(() => undefined);
    } finally {
      skipHostStatusAfterLaunch.current = true;
      setHostInitializing(false);
      setInstallActivity(null);
      setBusyAction(null);
    }
  }, [busyAction, clearHostSetupErrors, hostStatus, lang, refreshHostStatus, t]);

  const openLogs = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("logs");
    try {
      await managerApi.openLogsDir();
    } catch (cause) {
      setFailure(resolveFailure(cause, t));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, t]);

  const installed = status?.installed;
  const codexReady = !usbGuardQueryFailed && codexReadyOnAuthorizedUsb(usbGuard);
  const codexActionsAllowed = codexActionsAllowedOnCurrentRuntime(usbGuard, usbGuardQueryFailed);
  const codexInstallAllowed = codexInstallAllowedOnCurrentRuntime(usbGuard, usbGuardQueryFailed);
  const accountAuthorizationState: AccountAuthorizationState = usbGuardQueryFailed
    ? "unavailable"
    : !usbGuard
      ? phase === "loading" ? "checking" : "unavailable"
      : usbGuard.status === "starting"
        ? "checking"
        : usbGuard.status === "authorized" && usbGuard.watchdog === "running" && usbGuard.signed
          ? "authorized"
          : "unavailable";
  const usbGuardIsStarting = usbGuardStartupPending(usbGuard);
  const usbGuardStartupFailed = usbGuard?.status === "initialization-failed";
  const currentUsbInstalled = currentUsbInstallMatchesPayload(status, usbGuard, payload?.codexDesktopVersion ?? status?.usbPayloadVersion);
  const showInstalled = !usbGuardQueryFailed && currentUsbInstalled;
  const versionUnavailable = codexReady && currentUsbVersionUnavailable(status, usbGuard);
  const checkingExistingInstall = payloadLoading && codexReady && programIsOnCurrentUsb(status, usbGuard);
  const checkingVersion = busyAction === "status" || (busyAction === "install" && phase !== "staging" && phase !== "installing");

  async function recheckVersion() {
    setBusyAction("status");
    setFailure(null);
    try {
      setStatus(await managerApi.winStatus());
    } catch (cause) {
      setFailure(resolveFailure(cause, t));
    } finally {
      setBusyAction(null);
    }
  }
  useEffect(() => {
    if (componentsOpen || !showInstalled || phase === "installing" || busyAction || hostInitializing) return;
    if (skipHostStatusAfterLaunch.current) {
      skipHostStatusAfterLaunch.current = false;
      return;
    }
    let active = true;
    void managerApi.usbHostStatus({ overview: true }).then((value) => {
      if (!active) return;
      setHostStatus(value);
    })
      .catch((cause) => { if (active) { setHostStatus(null); setFailure(resolveFailure(cause, t)); } });
    return () => { active = false; };
  }, [showInstalled, phase, busyAction, componentsOpen, hostInitializing, t]);
  const hostPending = hostStatus?.required === true && !hostStatus.accountReady;
  const componentsPending = hostStatus?.accountReady && !hostStatus.capabilitiesReady || claudeState === "components-pending";
  const displayInstalled = codexReady ? installed : null;
  const startupReadinessPending =
    !usbGuardStartupFailed && (payloadLoading || phase === "loading" || usbGuardIsStarting);
  const disabled =
    claudeReattached ||
    busyAction !== null ||
    startupReadinessPending ||
    phase === "staging" ||
    phase === "installing";
  const payloadBytesDone = payloadUpdateProgress?.bytesDone ?? 0;
  const claudeAction = dualEdition && codexReady && !hostInitializing
    ? <ClaudeDesktopAction onState={setClaudeState} key={[usbGuard?.bundlePath, claudeSetupRevision].join("|")}
        launchOnly={!showInstalled || !hostStatus?.accountReady}
        observing={claudeReattached || busyAction === "claudeUpdate" || componentsOpen}
        updating={busyAction === "claudeUpdate"}
        disabled={disabled} busy={busyAction === "claude"}
        progress={busyAction === "claude" && dualStep && installActivity ? `${dualStep}/4 · ${installActivity}` : null}
        onBusy={(active) => {
          setBusyAction(active ? "claude" : null);
          if (!active) { setDualStep(undefined); setInstallActivity(null); }
        }} />
    : null;
  const payloadBytesTotal = payloadUpdateProgress?.bytesTotal ?? 0;

  const payloadProgressDownload: DownloadProgress | null = payloadUpdateProgress
    ? {
        downloaded:
          payloadUpdateProgress.phase === "done"
            ? payloadUpdateProgress.bytesTotal ?? payloadUpdateProgress.bytesDone ?? 0
            : payloadUpdateProgress.bytesDone ?? 0,
        total: payloadUpdateProgress.bytesTotal ?? 0,
        source: "USB 更新源",
        phase:
          payloadUpdateProgress.phase === "download"
            ? "downloading"
            : payloadUpdateProgress.phase === "done"
              ? "finishing"
              : "preparing",
      }
    : null;
  const payloadProgressTotal = payloadProgressDownload?.total ?? 0;
  const payloadProgressDone = payloadProgressDownload?.downloaded ?? 0;
  const payloadProgressPct =
    payloadProgressTotal > 0
      ? Math.min(100, (payloadProgressDone / payloadProgressTotal) * 100)
      : 0;

  // Keep the compact installer surface to one notification rail.  Detailed
  // recovery text and maintenance controls live in the collapsed advanced
  // section below, so an ordinary install has one predictable status location.
  const guardNeedsAttention = Boolean(
    usbGuard && usbGuard.status !== "authorized" && usbGuard.status !== "disabled",
  );
  const unifiedNotice = failure
    ? null
    : usbGuardStartupFailed
      ? usbGuard?.message
    : currentUsbInstalled && phase !== "installed"
      ? null
      : notice ??
      (usbGuardIsStarting
        ? t("offline.usbGuard.startingHint")
        : guardNeedsAttention
          ? usbGuard?.message || usbGuardLabel(usbGuard?.status ?? "", t)
          : null);
  const unifiedNoticeTone = usbGuardStartupFailed ? "err" : guardNeedsAttention && !notice ? "warn" : "info";
  const visibleCcswitchInjectionIssue = showInstalled && !hostStatus?.conflict ? ccswitchInjectionIssue : null;
  const ccswitchIssueRetryable =
    visibleCcswitchInjectionIssue === "failed" ||
    visibleCcswitchInjectionIssue === "launch-failed" ||
    visibleCcswitchInjectionIssue === "unconfirmed";

  // Keep the main-screen phase union intact below; the progress screen is a
  // temporary view and the page still renders the normal phase copy after it
  // unmounts.
  if (hostInitializing || (claudeReattached && dualStep)) {
    return <ProgressScreen scene="usb-host-initialization" scopeRef={progressScopeRef}
      paused={null} dl={{ downloaded: 0, total: 0, source: "", phase: "finishing" }}
      dlPct={0} dlBytes={0} dlSpeed={0} installing splitWindowsInstall localSetup dualStep={dualStep ?? (dualEdition ? 2 : undefined)} activityKey={activityKey} downloadStop={null} downloadStopBusy
      failure={failure} activity={installActivity ?? t("offline.host.check")}
      onResume={() => undefined} onPause={() => undefined} onCancel={() => undefined} showControls={false} />;
  }

  if (String(phase) === "installing" || (phase === "staging" && dualStep === 1)) {
    return (
      <ProgressScreen
        scene="offline-install"
        scopeRef={progressScopeRef}
        paused={null}
        dl={dl}
        downloadProgress={downloadProgress}
        installProgress={installProgress}
        dlPct={dlPct}
        dlBytes={dlBytes}
        dlSpeed={dlSpeed}
        installing
        splitWindowsInstall
        localPayloadReady
        dualStep={dualStep}
        activityKey={activityKey}
        showControls={!dualStep || (dualStep === 1 && phase === "installing")}
        downloadStop={downloadStop}
        downloadStopBusy={downloadStopBusy}
        failure={failure}
        activity={
          installActivity ??
          (dl?.activity === "portable-startup-compatibility"
            ? t("offline.installActivity.codexStartup")
            : null)
        }
        onResume={() => undefined}
        onPause={() => void requestDownloadStop("pause")}
        onCancel={() => void requestDownloadStop("cancel")}
      />
    );
  }

  if (payloadProgressDownload) {
    return (
      <ProgressScreen
        scene="offline-payload-update"
        scopeRef={progressScopeRef}
        paused={null}
        dl={payloadProgressDownload}
        dlPct={payloadProgressPct}
        dlBytes={payloadProgressDone}
        dlSpeed={0}
        installing
        downloadStop={null}
        downloadStopBusy
        failure={failure}
        onResume={() => undefined}
        onPause={() => undefined}
        onCancel={() => undefined}
        showControls={false}
      />
    );
  }

  return (
    <div className="pop">
      <TopBar>
        <button
          className="iconbtn"
          data-page-focus
          title={t("nav.settings")}
          onClick={onOpenSettings}
        >
          <Icon name="gear" />
        </button>
      </TopBar>
      <div className="scroll">
        {failure ? <FailureBanner failure={failure} context={notice} /> : null}
        {visibleCcswitchInjectionIssue && !failure ? (
          <StatusBanner
            tone="err"
            action={(
              <button
                className="linkbtn"
                onClick={() =>
                  void (ccswitchIssueRetryable ? retryCcswitchInjection() : launchCcswitch())
                }
                disabled={disabled}
                data-testid="ccswitch-injection-action"
              >
                <Icon
                  name={
                    ccswitchIssueRetryable
                      ? busyAction === "ccswitch" ? "loader" : "refresh"
                      : busyAction === "ccswitch" ? "loader" : "gear"
                  }
                  className={busyAction === "ccswitch" ? "spinicon" : undefined}
                />
                {ccswitchIssueRetryable
                  ? busyAction === "ccswitch"
                    ? t("offline.ccswitchInjectionRetrying")
                    : t("offline.ccswitchInjectionRetry")
                  : busyAction === "ccswitch"
                    ? t("offline.ccswitchLaunching")
                    : t("offline.ccswitchInjectionOpen")}
              </button>
            )}
          >
            <span>
              {t(ccswitchInjectionMessageKey(visibleCcswitchInjectionIssue))}
            </span>
            {notice ? <span className="installer-notice-meta">{notice}</span> : null}
          </StatusBanner>
        ) : unifiedNotice ? (
          <StatusBanner tone={unifiedNoticeTone}>
            <span>{unifiedNotice}</span>
            {usbGuard ? (
              <span className="installer-notice-meta" data-testid="usb-guard-status">
                {usbGuardLabel(usbGuard.status, t)}
                {usbGuard.countdownSeconds !== null ? ` · ${usbGuard.countdownSeconds}s` : ""}
              </span>
            ) : null}
          </StatusBanner>
        ) : usbGuard ? (
          <div
            className={`usb-guard-inline usb-guard-${usbGuard.status}`}
            data-testid="usb-guard-status"
          >
            <span className="usb-guard-status-icon"><Icon name={usbGuard.status === "authorized" ? "shield" : "alert"} /></span>
            <span>{usbGuardLabel(usbGuard.status, t)}</span>
            {usbGuard.countdownSeconds !== null ? <span className="usb-guard-countdown">{usbGuard.countdownSeconds}s</span> : null}
          </div>
        ) : null}
        {payloadUpdateProgress ? (
          <section className="payload-update-progress" data-testid="payload-update-progress">
            <div className="sub">
              {payloadUpdateProgress.phase === "download"
                ? t("progress.downloadingFrom", { source: "USB 更新源" })
                : t("progress.finishing")}
            </div>
            <div
              className="bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                payloadBytesTotal > 0
                  ? Math.min(
                      100,
                      (payloadBytesDone / payloadBytesTotal) * 100,
                    )
                  : undefined
              }
            >
              <div
                className={`bar-fill${payloadBytesTotal > 0 ? "" : " indeterminate"}`}
                style={
                  payloadBytesTotal > 0
                    ? {
                        width: `${Math.min(
                          100,
                          (payloadBytesDone / payloadBytesTotal) * 100,
                        )}%`,
                      }
                    : undefined
                }
              />
            </div>
            {payloadBytesTotal > 0 ? (
              <div className="dlmeta">
                {mib(payloadBytesDone)} / {mib(payloadBytesTotal)}
              </div>
            ) : null}
          </section>
        ) : null}
        <section className="hero" data-testid="offline-hero">
          {startupReadinessPending ? (
            <>
              <Ring icon="loader" spin />
              <div className="headline">{t("offline.checking")}</div>
            </>
          ) : usbGuardStartupFailed || phase === "error" ? (
            <>
              <Ring icon="alert" variant="danger" />
              <div className="headline">{t(usbGuardStartupFailed ? "offline.usbGuard.initializationFailed" : "offline.checkFailed")}</div>
            </>
          ) : checkingVersion || (versionUnavailable && phase !== "staging") ? (
            <>
              <Ring icon={checkingVersion ? "loader" : "info"} spin={checkingVersion} />
              <div className="headline">{t(checkingVersion ? "offline.checkingVersion" : "offline.versionUnavailable")}</div>
            </>
          ) : showInstalled ? (
            <>
              <Ring icon="check" variant="success" />
              <div className="headline">{hostPending
                ? t(dualEdition ? "dual.codexPending" : "offline.host.pending")
                : t(!dualEdition ? "offline.installed" : canOpenClaude(claudeState) ? "dual.installed" : claudeState ? "dual.claudeSetupPending" : "dual.codexInstalled")}</div>
              {hostPending ? <div className="sub" role="status">{hostStatus.message}</div> : null}
              <div className="microcue">{payload?.hashVerified ? <><Icon name="shield" />{t("offline.hashVerified")}</> : displayInstalled?.version}</div>
            </>
          ) : usbInstallBlockedByExistingCodex(status, usbGuard) ? (
            <>
              <Ring icon="shield" variant="amber" />
              <div className="headline">{t("home.external.title")}</div>
              <div className="prov"><span className="dot external" />{t("prov.external")}</div>
              <Tooltip
                content={
                  status?.status === "external"
                    ? t("offline.external")
                    : t("offline.existingOutsideUsb")
                }
              >
                <span className="tooltip-icon hero-info" aria-label={t("themes.details")}>
                  <Icon name="info" />
                </span>
              </Tooltip>
            </>
          ) : (
            <>
              <Ring icon="download" className={phase === "staging" || phase === "installing" ? "spin" : ""} />
              <div className="headline">
                {phase === "staging" || phase === "installing" ? t("offline.installing") : t("offline.ready")}
              </div>
              <Tooltip content={t(dualEdition ? "dual.installDescription" : "offline.description")}>
                <span className="tooltip-icon hero-info" aria-label={t("themes.details")}>
                  <Icon name="info" />
                </span>
              </Tooltip>
            </>
          )}
        </section>

        {payload ? (
          <div className="list meta">
            <div className="row">
              <span className="rtext"><span className="rtitle">{t("offline.version")}</span></span>
              <span className="rval version">{payload.codexDesktopVersion}</span>
            </div>
            <div className="row">
              <span className="rtext"><span className="rtitle">{t("offline.package")}</span></span>
              <span className="rval path" title={payload.fileName}>{payload.fileName}</span>
            </div>
            <div className="row">
              <span className="rtext"><span className="rtitle">{t("offline.arch")}</span></span>
              <span className="rval">{payload.architecture}</span>
            </div>
            <div className="row">
              <span className="rtext"><span className="rtitle">{t("offline.hash")}</span></span>
              <span className="rval path" title={payload.sha256}>{payload.sha256.slice(0, 12)}…</span>
            </div>
            <div className="row">
              <span className="rtext"><span className="rtitle">{t("offline.signature")}</span></span>
              <span className="rval">{payload.authenticode?.trusted ? t("offline.hashVerified") : t("offline.signaturePending")}</span>
            </div>
            <div className="row">
              <span className="rtext"><span className="rtitle">{t("offline.size")}</span></span>
              <span className="rval">{mib(payload.size)}</span>
            </div>
          </div>
        ) : null}

        <div className="actions">
          {phase === "error" ? null : showInstalled ? (
            <>
              <button className="btn primary big" onClick={() => dualEdition && hostPending ? void install("install") : void launch()} disabled={disabled || hostStatus === null}>
                {busyAction === "launch" ? <Icon name="loader" className="spinicon" /> : <CodexGlyph />}
                {busyAction === "launch" ? t("offline.launching") : dualEdition && hostPending ? t("dual.setup") : t("offline.launch")}
              </button>
              {claudeAction}
              <button className="btn ghost" onClick={() => void launchCcswitch()} disabled={disabled}>
                {busyAction === "ccswitch" ? <Icon name="loader" className="spinicon" /> : <Icon name="gear" />}
                {busyAction === "ccswitch" ? t("offline.ccswitchLaunching") : t("offline.ccswitchLaunch")}
              </button>
              <button
                className="btn ghost connection-entry"
                onClick={() => setModelManagerOpen(true)}
                disabled={disabled || !codexActionsAllowed}
                data-testid="manage-upstream-models"
              >
                <Icon name="list" />{t("offline.nativeModelsManage")}
              </button>
              {onOpenUninstall ? (
                <button className="btn ghost danger" onClick={onOpenUninstall} disabled={disabled}>
                  <Icon name="trash" />{t("offline.uninstallBundle")}
                </button>
              ) : null}
            </>
          ) : versionUnavailable || checkingExistingInstall ? (
            <button className="btn primary big" onClick={() => void recheckVersion()} disabled={disabled}>
              <Icon name="refresh" />{t(checkingExistingInstall ? "offline.checkingVersion" : "offline.recheckVersion")}
            </button>
          ) : usbInstallBlockedByExistingCodex(status, usbGuard) ? (
            <>
              <div className="status-copy">
                {status?.status === "external"
                  ? t("offline.external")
                  : t("offline.existingOutsideUsb")}
              </div>
            </>
          ) : (
            <>
              <button className="btn primary big" onClick={() => void install("install")} disabled={disabled || !codexInstallAllowed}>
                {busyAction === "install" ? <Icon name="loader" className="spinicon" /> : <Icon name="download" />}
                {checkingVersion ? t("offline.checkingVersion") : busyAction === "install" ? t("offline.installing") : status?.recoveryPending ? t("offline.resumeInstall") : t(dualEdition ? "dual.install" : "offline.install")}
              </button>
            </>
          )}
          {phase !== "error" ? (
            <span className="update-entry-wrap">
              <Tooltip
                content={
                  codexPayloadAvailable
                    ? usbGuard?.reinstallAllowed === true
                      ? t("offline.reactivationUpdateHint")
                      : t(dualEdition ? "dual.updateHint" : "offline.updateHint")
                    : t("offline.updateRequiresSigned")
                }
              >
                <button
                  className="btn ghost update-entry"
                  onClick={() => void checkCodexPayload()}
                  disabled={disabled || !codexPayloadAvailable}
                  data-testid="codex-payload-update"
                >
                  {busyAction === "update" ? (
                    <Icon name="loader" className="spinicon" />
                  ) : (
                    <Icon name="download" />
                  )}
                  {busyAction === "update"
                    ? t("offline.updateChecking")
                    : usbGuard?.reinstallAllowed === true
                      ? t("offline.reactivationUpdateEntry")
                      : t(dualEdition ? "dual.checkUpdates" : "offline.updateEntry")}
                </button>
              </Tooltip>
            </span>
          ) : null}
          {!showInstalled && claudeAction}
          {componentsPending && codexReady && <div role="status" className="sub">
            {t("offline.components.pendingHint")}{" "}
            <button className="btn ghost" disabled={disabled} onClick={() => {
              setComponentsView("maintenance");
              setComponentsOpen(true);
            }}>{t("offline.components.repairEntry")}</button>
          </div>}
          {!showInstalled && onOpenUninstall ? (
            <button className="btn ghost danger" onClick={onOpenUninstall} disabled={disabled}>
              <Icon name="trash" />{t("offline.uninstallBundle")}
            </button>
          ) : null}
        </div>

        <button
          className="btn ghost connection-entry"
          onClick={() => {
            setComponentsView("connections");
            setComponentsOpen(true);
          }}
          disabled={disabled}
        >
          <Icon name="sliders" />{t("offline.components.entry")}
        </button>

        <details className="advanced-tools" data-testid="advanced-tools">
          <summary>{t("offline.advancedTools")}</summary>
          <div className="advanced-maintenance">
            <div className="advanced-maintenance-row">
              <button className="btn ghost" onClick={() => void load(true)} disabled={disabled}>
                <Icon name="refresh" />{t("offline.recheck")}
              </button>
              {showInstalled || versionUnavailable ? (
                <Tooltip content={t("offline.repairHint")}>
                  <button className="btn ghost" onClick={() => void install("repair")} disabled={disabled}>
                    <Icon name="refresh" />{t("offline.repair")}
                  </button>
                </Tooltip>
              ) : null}
              <button className="btn ghost" onClick={() => void openLogs()} disabled={disabled}>
                {busyAction === "logs" ? <Icon name="loader" className="spinicon" /> : <Icon name="folder" />}
                {t("offline.openLogs")}
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setComponentsView("maintenance");
                  setComponentsOpen(true);
                }}
                disabled={disabled}
              >
                <Icon name="sliders" />{t("offline.components.repairEntry")}
              </button>
            </div>
            {installationDetail || capabilityInstallError ? (
              <details className="advanced-detail">
                <summary>{t("offline.installDetails")}</summary>
                <div>{installationDetail}</div>
                {capabilityInstallError ? (
                  <div>{`能力包自动安装失败：${capabilityInstallError}${dualEdition ? "" : "\n可在“高级功能 > 组件修复”中重试。"}`}</div>
                ) : null}
              </details>
            ) : null}
          </div>
        </details>

        <SkillRepoUpdateCard dualEdition={dualEdition} />
        <AccountCard authorizationState={accountAuthorizationState} />
        {displayInstalled ? (
          <Tooltip
            content={[
              `${t("home.installLocation")}: ${displayInstalled.path}`,
              displayInstalled.packageVolume
                ? `${t("offline.packageVolume")}: ${displayInstalled.packageVolume}`
                : null,
              t("offline.keepUsbConnected"),
            ]
              .filter(Boolean)
              .join("\n")}
          >
            <span
              className="foot foot-evidence"
              aria-label={t("offline.installLocationSummary")}
            >
              <Icon name="info" />
              <span>{t("offline.installLocationSummary")}</span>
            </span>
          </Tooltip>
        ) : null}
      </div>
      <Sheet
        open={updatesOpen}
        onDismiss={() => { if (!busyAction) setUpdatesOpen(false); }}
        dismissable={!busyAction} labelledBy={updateTitleId + "-dual"} initialFocus="dismiss"
      >
        <h3 id={updateTitleId + "-dual"}>{t("dual.checkUpdates")}</h3>
        <div className="list">
          <div className="row"><div className="rtext"><strong>Codex</strong>
            <div className="sub" role="status">{!codexResult ? t("offline.updateChecking") :
              codexResult.kind === "available" ? codexResult.info.currentVersion + " → " + codexResult.info.latestVersion :
              codexResult.kind === "unavailable" ? codexResult.message || t("offline.updateUnavailable") :
              t(codexResult.kind === "none" ? "offline.updateUpToDate" : "about.mgrDev")}</div></div>
            {codexResult?.kind === "available" && <button className="btn primary" disabled={!!busyAction}
              onClick={() => void applyCodexPayload(codexResult.info)}>{t("dual.updateOnlyCodex")}</button>}
          </div>
          <div className="row"><div className="rtext"><strong>Claude</strong>
            <div className="sub" role="status">{busyAction === "claudeUpdate" ? updateActivity : !claudeResult ? t("offline.updateChecking") :
              claudeResult.kind === "available" ? claudeResult.currentVersion + " → " + claudeResult.latestVersion + " · Code " + claudeResult.codeVersion :
              claudeResult.kind === "failed" ? claudeResult.message :
              t(claudeResult.kind === "none" ? "claude.current" : claudeResult.kind === "recover" ? "claude.recover" : "dual.claudeNotInstalled")}</div>
            {claudeUpdateFailure && <div role="alert" className="sub">{claudeUpdateFailure.detail || claudeUpdateFailure.message}</div>}</div>
            {claudeResult?.kind === "available" && <button className="btn primary" disabled={!!busyAction}
              onClick={() => void applyClaudeUpdate()}>{t(busyAction === "claudeUpdate" ? "dual.updatingClaude" : claudeUpdateFailure ? "skillRepo.retry" : "dual.updateOnlyClaude")}</button>}
          </div>
        </div>
        <button className="btn ghost" disabled={!!busyAction} onClick={() => setUpdatesOpen(false)}>{t("nav.close")}</button>
      </Sheet>
      <Sheet
        open={codexUpdateConfirmOpen && Boolean(pendingCodexUpdate)}
        onDismiss={() => {
          if (busyAction === "update") return;
          setCodexUpdateConfirmOpen(false);
          setPendingCodexUpdate(null);
        }}
        dismissable={busyAction !== "update"}
        labelledBy={updateTitleId}
        describedBy={updateBodyId}
        initialFocus="dismiss"
      >
        <Ring icon="download" />
        <h3 id={updateTitleId}>
          {pendingCodexUpdate
            ? t("offline.updateConfirmTitle", {
                version: pendingCodexUpdate.latestVersion,
              })
            : ""}
        </h3>
        <p id={updateBodyId}>
          {pendingCodexUpdate
            ? t("offline.updateConfirmBody", {
                current: pendingCodexUpdate.currentVersion,
                latest: pendingCodexUpdate.latestVersion,
              })
            : ""}
        </p>
        <div className="row2 sheet-actions">
          <button
            className="btn ghost"
            onClick={() => {
              setCodexUpdateConfirmOpen(false);
              setPendingCodexUpdate(null);
            }}
            disabled={busyAction === "update"}
          >
            {t("confirm.cancel")}
          </button>
          <button className="btn primary" onClick={() => void applyCodexPayload()} disabled={busyAction === "update"}>
            {busyAction === "update" ? t("offline.updateInstalling") : t("confirm.ok")}
          </button>
        </div>
      </Sheet>
      <OfflineComponentsSheet
        dualEdition={dualEdition}
        open={componentsOpen}
        onDismiss={() => setComponentsOpen(false)}
        onRepaired={() => {
          setCapabilityInstallError(null);
          const warning = lastComponentWarning.current;
          if (warning) setNotice(current => current?.replace(warning, "").trim() || null);
          lastComponentWarning.current = null;
        }}
        view={componentsView}
      />
      <UpstreamModelManagerSheet
        key={(usbGuard?.bundlePath ?? "") + "|" + (usbGuard?.codexAllowed ?? "") + "|" + (hostStatus?.accountReady ?? "")}
        dualEdition={dualEdition}
        open={modelManagerOpen && showInstalled}
        onDismiss={() => setModelManagerOpen(false)}
      />
    </div>
  );
}

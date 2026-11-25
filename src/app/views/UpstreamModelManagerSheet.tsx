import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { errorMessage, managerApi } from "../../services/managerApi";
import type {
  GatewayModelProbeReport,
  GatewayProbeModel,
  GatewayReasoningEffortResult,
  NativeModelCatalogActionReport,
} from "../../shared/types";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { Sheet } from "../Sheet";

function newRequestId(prefix: string) {
  return globalThis.crypto?.randomUUID?.()
    ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type ModelRow = GatewayProbeModel & { activeOnly?: boolean };

type Availability = "passed" | "failed";
function ModelListRow({ testId, model, title, status, statusTitle, actions, children }: {
  testId: string; model: string; title?: string; status: string; statusTitle?: string;
  actions: ReactNode; children?: ReactNode;
}) {
  return <li data-testid={testId}>
    <div className="upstream-model-manager-model">
      <strong className="upstream-model-manager-model-id" title={title ?? model} dir="ltr">{model}</strong>
      <small className="upstream-model-manager-row-status" title={statusTitle ?? status} aria-live="polite">{status}</small>
    </div>
    <div className="upstream-model-manager-row-actions">{actions}</div>
    {children}
  </li>;
}
type RetryableAdd = { modelId: string; proofId: string; probeRequestId: string; expiresAtMs: number };
const REASONING_EFFORT_CANDIDATES = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function reasoningEffortCandidates(modelId: string) {
  const normalized = modelId.toLowerCase();
  const omitNone = normalized === "claude-opus-5-5" || normalized.endsWith("/claude-opus-5-5");
  return omitNone ? REASONING_EFFORT_CANDIDATES.filter((effort) => effort !== "none") : REASONING_EFFORT_CANDIDATES;
}
const PROBE_CACHE_KEY = "codex-manager.upstream-model-probe.v1";
type ProbeCache = {
  schemaVersion: 1;
  updatedAtMs: number;
  report: GatewayModelProbeReport;
  availabilityById: Record<string, Availability>;
  failedTestIds: string[];
  failureCodeById?: Record<string, string>;
};

const SAFE_PROBE_ERROR_CODE = /^[a-z0-9-]{1,64}$/;
type ProbeFailureReasonKey = "auth" | "http" | "http400" | "storeUnsupported" | "rejected" | "noCompatibleSettings" | "network" | "timeout" | "response" | "large" | "binding" | "cancelled" | "budget" | "incomplete" | "local" | "unknown";

function safeProbeErrorCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_PROBE_ERROR_CODE.test(value) ? value : null;
}

function commandProbeErrorCode(cause: unknown): string | null {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = safeProbeErrorCode((cause as { code?: unknown }).code);
    if (code) return code;
  }
  const message = cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message?: unknown }).message ?? "")
        : "";
  return message.match(/\b(upstream-[a-z-]+|probe-[a-z-]+|effort-[a-z-]+|binding-changed|engine_error|internal_error)\b/i)?.[1]?.toLowerCase() ?? null;
}

function probeFailureReasonKey(code: string | null, localFailure = false): ProbeFailureReasonKey {
  if (localFailure) return "local";
  switch (code) {
    case "upstream-auth": return "auth";
    case "upstream-http": return "http";
    case "upstream-http-400": return "http400";
    case "upstream-store-unsupported": return "storeUnsupported";
    case "effort-rejected": return "rejected";
    case "no-effort-accepted": return "noCompatibleSettings";
    case "upstream-connect-failed":
    case "upstream-unavailable": return "network";
    case "probe-timeout": return "timeout";
    case "upstream-response":
    case "invalid-response":
    case "stream-invalid":
    case "tool-correlation-invalid": return "response";
    case "response-too-large": return "large";
    case "binding-changed": return "binding";
    case "probe-cancelled": return "cancelled";
    case "probe-budget-exhausted": return "budget";
    case "effort-probe-incomplete": return "incomplete";
    case "engine_error":
    case "internal_error": return "local";
    default: return "unknown";
  }
}

function readProbeCache(): ProbeCache | null {
  try {
    const raw = localStorage.getItem(PROBE_CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ProbeCache>;
    const report = value.report;
    if (
      value.schemaVersion !== 1
      || !Number.isFinite(value.updatedAtMs)
      || !report
      || typeof report.status !== "string"
      || typeof report.endpoint !== "string"
      || typeof report.connectionFingerprint !== "string"
      || typeof report.credentialFingerprint !== "string"
      || !Number.isFinite(report.checkedAt)
      || !Array.isArray(report.models)
      || !Array.isArray(report.results)
      || !value.availabilityById
      || typeof value.availabilityById !== "object"
      || !Array.isArray(value.failedTestIds)
    ) return null;
    return value as ProbeCache;
  } catch {
    return null;
  }
}

function writeProbeCache(
  report: GatewayModelProbeReport,
  availabilityById: Record<string, Availability>,
  failedTestIds: string[],
  failureCodeById: Record<string, string> = {},
): number | null {
  const updatedAtMs = Date.now();
  // Persist only the displayable discovery/check results. Short-lived proof IDs
  // are deliberately excluded and must be reacquired before adding a model.
  const safeReport: GatewayModelProbeReport = {
    status: report.status,
    endpoint: report.endpoint,
    credentialFingerprint: report.credentialFingerprint,
    connectionFingerprint: report.connectionFingerprint,
    checkedAt: report.checkedAt,
    models: report.models.map(({ id, ownedBy, selectable }) => ({ id, ownedBy, selectable })),
    results: report.results.map(({ modelId, passed, generatedRequests, checks, errorCode }) => ({
      modelId,
      passed,
      generatedRequests,
      checks: checks.map(({ name, passed: checkPassed }) => ({ name, passed: checkPassed })),
      errorCode,
    })),
    generatedRequests: report.generatedRequests,
    errorCode: report.errorCode,
    reasoningModelId: report.reasoningModelId,
    reasoningResults: report.reasoningResults,
  };
  const cache: ProbeCache = {
    schemaVersion: 1,
    updatedAtMs,
    report: safeReport,
    availabilityById,
    failedTestIds,
    failureCodeById: Object.fromEntries(
      Object.entries(failureCodeById).filter(([, code]) => safeProbeErrorCode(code) !== null),
    ),
  };
  try {
    localStorage.setItem(PROBE_CACHE_KEY, JSON.stringify(cache));
    return updatedAtMs;
  } catch {
    // Keep the live probe usable when browser storage is unavailable or full,
    // but don't claim that the result was persisted.
    return null;
  }
}

export function UpstreamModelManagerSheet({
  open,
  onDismiss,
  dualEdition = false,
}: {
  open: boolean;
  onDismiss: () => void;
  dualEdition?: boolean;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"codex" | "claude">("codex");
  const [claude, setClaude] = useState<Awaited<ReturnType<typeof managerApi.manageClaudeModels>> | null>(null);
  const [claudeError, setClaudeError] = useState<string | null>(null);
  const [claudeOperation, setClaudeOperation] = useState<"state" | "refresh" | "add" | "default" | "reset" | "test" | null>(null);
  const claudeBusy = claudeOperation !== null;
  const [claudeRow, setClaudeRow] = useState<{ id: string; stage: "preparing" | "probing" | "saving" } | null>(null);
  const [claudeFailures, setClaudeFailures] = useState<Record<string, string>>({});
  const [claudePassed, setClaudePassed] = useState<string[]>([]);
  const [codexDefault, setCodexDefault] = useState<string | null>(null);
  const claudeSequence = useRef(0);
  const titleId = useId();
  const descriptionId = useId();
  const [report, setReport] = useState<GatewayModelProbeReport | null>(() => readProbeCache()?.report ?? null);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<string | null>(null);
  const [failedTestIds, setFailedTestIds] = useState<string[]>(() => readProbeCache()?.failedTestIds ?? []);
  const [failureCodeById, setFailureCodeById] = useState<Record<string, string>>(() => readProbeCache()?.failureCodeById ?? {});
  const [availabilityById, setAvailabilityById] = useState<Record<string, Availability>>(() => readProbeCache()?.availabilityById ?? {});
  const [cacheUpdatedAtMs, setCacheUpdatedAtMs] = useState<number | null>(() => readProbeCache()?.updatedAtMs ?? null);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  const [confirmBulkTest, setConfirmBulkTest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [reasoningTestingId, setReasoningTestingId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [retryableAddModelId, setRetryableAddModelId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const session = useRef(0);
  const wasOpen = useRef(false);
  const requestIds = useRef(new Set<string>());
  const addRequestId = useRef<string | null>(null);
  const retryableAdd = useRef<RetryableAdd | null>(null);

  const cancelOutstanding = useCallback(async () => {
    const activeAddRequestId = addRequestId.current;
    const ids = new Set([...requestIds.current].filter((id) => id !== activeAddRequestId));
    requestIds.current.clear();
    await Promise.all([...ids].map((id) => managerApi.cancelGatewayModelProbe(id).catch(() => false)));
  }, []);

  const refreshCatalogState = useCallback(async (expectedSession: number) => {
    try {
      const state = await managerApi.manageNativeModelCatalog({ operation: "state" });
      if (session.current !== expectedSession) return null;
      setActiveIds(state.modelIds ?? []);
      setCodexDefault(state.defaultModel ?? null);
      setCatalogStatus(state.status);
      if (state.status === "orphaned") {
        setError(t("offline.nativeModelManagerOrphaned"));
        setMessage(null);
      }
      return state;
    } catch {
      if (session.current !== expectedSession) return null;
      setCatalogStatus("unknown");
      setError(t("offline.nativeModelManagerError"));
      setMessage(null);
      return null;
    }
  }, [t]);

  const saveAvailability = useCallback((
    modelId: string,
    availability: Availability,
    errorCode?: string | null,
    reportSnapshot: GatewayModelProbeReport | null = report,
  ) => {
    const nextAvailability = { ...availabilityById, [modelId]: availability };
    const nextFailedIds = availability === "failed"
      ? (failedTestIds.includes(modelId) ? failedTestIds : [...failedTestIds, modelId])
      : failedTestIds.filter((id) => id !== modelId);
    const nextFailureCodes = { ...failureCodeById };
    if (availability === "failed" && errorCode) nextFailureCodes[modelId] = errorCode;
    else delete nextFailureCodes[modelId];
    setAvailabilityById(nextAvailability);
    setFailedTestIds(nextFailedIds);
    setFailureCodeById(nextFailureCodes);
    if (reportSnapshot) setCacheUpdatedAtMs(writeProbeCache(reportSnapshot, nextAvailability, nextFailedIds, nextFailureCodes));
  }, [availabilityById, failedTestIds, failureCodeById, report]);

  const discover = useCallback(async () => {
    if (loading || testingId || reasoningTestingId || addingId || resetting || addRequestId.current) return;
    const currentSession = ++session.current;
    setLoading(true);
    setTestingId(null);
    setAddingId(null);
    setError(null);
    setMessage(null);
    setBulkProgress(null);
    let requestId: string | null = null;
    try {
      const retained = retryableAdd.current;
      retryableAdd.current = null;
      setRetryableAddModelId(null);
      if (retained) await managerApi.cancelGatewayModelProbe(retained.probeRequestId).catch(() => false);
      await cancelOutstanding();
      if (session.current !== currentSession) return;

      requestId = newRequestId("upstream-discovery");
      requestIds.current.add(requestId);
      const [state, next] = await Promise.all([
        refreshCatalogState(currentSession),
        managerApi.gatewayModelProbe({
          requestId,
          selectedModelIds: [],
          costConsent: false,
        }),
      ]);
      if (session.current !== currentSession) return;
      if (next.status === "connected") {
        setReport(next);
        setFailedTestIds([]);
        setAvailabilityById({});
        setFailureCodeById({});
        setCacheUpdatedAtMs(writeProbeCache(next, {}, []));
      } else {
        if (!report) setReport(next);
        setError(state?.status === "orphaned" ? t("offline.nativeModelManagerOrphaned") : t("offline.nativeModelManagerError"));
      }
    } catch {
      if (session.current !== currentSession) return;
      setError(t("offline.nativeModelManagerError"));
    } finally {
      if (requestId) requestIds.current.delete(requestId);
      if (session.current === currentSession) setLoading(false);
    }
  }, [addingId, cancelOutstanding, loading, reasoningTestingId, refreshCatalogState, report, resetting, t, testingId]);

  useLayoutEffect(() => {
    if (!open && wasOpen.current) {
      ++claudeSequence.current;
      setTab("codex");
      setClaude(null);
      setClaudeError(null);
      setClaudeOperation(null);
      setClaudeRow(null);
      setClaudeFailures({});
      setClaudePassed([]);
      setConfirmBulkTest(false);
      wasOpen.current = false;
      session.current += 1;
      setLoading(false);
      setTestingId(null);
      setBulkProgress(null);
      if (!addRequestId.current) setAddingId(null);
      setResetting(false);
      void cancelOutstanding();
    }
  }, [cancelOutstanding, open]);

  useEffect(() => {
    if (!open || wasOpen.current) return;
    wasOpen.current = true;
    setCatalogStatus(null);
    setActiveIds([]);
    const currentSession = ++session.current;
    const cache = readProbeCache();
    if (cache) {
      setReport(cache.report);
      setAvailabilityById(cache.availabilityById);
      setFailedTestIds(cache.failedTestIds);
      setFailureCodeById(cache.failureCodeById ?? {});
      setCacheUpdatedAtMs(cache.updatedAtMs);
      setError(null);
      setMessage(null);
      void refreshCatalogState(currentSession);
    } else {
      void discover();
    }
  }, [discover, open, refreshCatalogState]);

  const testReasoningEfforts = useCallback(async (model: ModelRow) => {
    if (loading || testingId || reasoningTestingId || addingId || resetting || addRequestId.current || catalogStatus !== "ok" || !model.selectable || model.activeOnly) return;
    const currentSession = session.current;
    const retained = retryableAdd.current;
    const retryTicket = retained?.modelId === model.id && retained.expiresAtMs > Date.now() ? retained : null;
    if (retained && !retryTicket) {
      retryableAdd.current = null;
      setRetryableAddModelId(null);
      await managerApi.cancelGatewayModelProbe(retained.probeRequestId).catch(() => false);
    }
    const prepareRequestId = retryTicket ? null : newRequestId("upstream-prepare");
    if (prepareRequestId) requestIds.current.add(prepareRequestId);
    setReasoningTestingId(model.id);
    setError(null);
    setMessage(null);
    let probeRequestId: string | null = retryTicket?.probeRequestId ?? null;
    let proofId: string | null = retryTicket?.proofId ?? null;
    let proofExpiresAtMs = retryTicket?.expiresAtMs ?? 0;
    let retainProofForRetry = false;
    let addStarted = false;
    try {
      if (!retryTicket) {
        const prepared = await managerApi.manageNativeModelCatalog({
          operation: "prepare",
          requestId: prepareRequestId!,
          modelId: model.id,
        });
        if (prepareRequestId) requestIds.current.delete(prepareRequestId);
        if (session.current !== currentSession) return;
        if (prepared.status === "already_added" || prepared.status === "applied_restart_pending") {
          setActiveIds(prepared.modelIds ?? []);
          setMessage(prepared.status === "already_added"
            ? t("offline.nativeModelManagerAlreadyAdded")
            : t("offline.nativeModelManagerAdded"));
          retryableAdd.current = null;
          setRetryableAddModelId(null);
          return;
        }
        if (prepared.status !== "ready") throw new Error(prepared.message || t("offline.nativeModelManagerError"));

        if (dualEdition && prepared.modelIds?.includes(model.id)) {
          setActiveIds(prepared.modelIds);
          setMessage(t("offline.nativeModelManagerAlreadyAdded"));
          return;
        }
        probeRequestId = newRequestId("upstream-reasoning");
        requestIds.current.add(probeRequestId);
        const next = await managerApi.gatewayModelProbe({
          requestId: probeRequestId,
          selectedModelIds: [],
          costConsent: false,
          reasoningModelId: model.id,
          reasoningEfforts: [...reasoningEffortCandidates(model.id)],
          reasoningCostConsent: true,
        });
        if (session.current !== currentSession) return;
        const reportWithDiscovery = { ...next, models: report?.models?.length ? report.models : next.models };
        setReport(reportWithDiscovery);
        setCacheUpdatedAtMs(writeProbeCache(reportWithDiscovery, availabilityById, failedTestIds, failureCodeById));
        if (next.status !== "passed" || !next.reasoningProofId) {
          const errorCode = safeProbeErrorCode(
            next.errorCode === "no-effort-accepted"
              ? next.errorCode
              : next.reasoningResults?.find((row) => row.errorCode)?.errorCode ?? next.errorCode,
          );
          const reason = t(`offline.nativeModelProbeFailureReason.${probeFailureReasonKey(errorCode)}` as const);
          saveAvailability(model.id, "failed", errorCode, reportWithDiscovery);
          setError(t("offline.nativeModelProbeFailure", {
            reason,
            code: errorCode ?? t("offline.nativeModelProbeFailureNoCode"),
          }));
          return;
        }

        proofId = next.reasoningProofId;
        proofExpiresAtMs = (next.connectivityProofExpiresAt ?? 0) * 1000;
        saveAvailability(model.id, "passed", null, reportWithDiscovery);
      }
      setAddingId(model.id);
      const addRequestIdValue = newRequestId("upstream-add");
      addRequestId.current = addRequestIdValue;
      addStarted = true;
      let result: NativeModelCatalogActionReport;
      for (let attempt = 0; ; attempt += 1) {
        const requestId = attempt === 0 ? addRequestIdValue : newRequestId("upstream-add-retry");
        addRequestId.current = requestId;
        result = await managerApi.manageNativeModelCatalog({
          operation: "add",
          requestId,
          modelId: model.id,
          connectivityProofId: proofId!,
        });
        if (!result.retryable || attempt >= 2) break;
        await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
        if (session.current !== currentSession) return;
      }
      if (session.current !== currentSession) return;
      if (result.status === "applied_restart_pending" || result.status === "already_added") {
        setActiveIds(result.modelIds ?? []);
        setError(null);
        setMessage(t("offline.nativeModelManagerAdded"));
        retryableAdd.current = null;
        setRetryableAddModelId(null);
      } else if (result.retryable && proofId && probeRequestId && proofExpiresAtMs > Date.now()) {
        retainProofForRetry = true;
        retryableAdd.current = { modelId: model.id, proofId, probeRequestId, expiresAtMs: proofExpiresAtMs };
        setRetryableAddModelId(model.id);
        setError(result.message || t("offline.nativeModelManagerRetryAdd"));
      } else {
        retryableAdd.current = null;
        setRetryableAddModelId(null);
        setError(result.message || t("offline.nativeModelManagerAddUnconfirmed"));
        if (result.status === "cleanup_pending" || result.status === "outcome_unconfirmed" || result.commitState === "uncertain") {
          await refreshCatalogState(currentSession);
        }
      }
    } catch (cause) {
      retryableAdd.current = null;
      setRetryableAddModelId(null);
      if (session.current === currentSession) {
        if (addStarted) await refreshCatalogState(currentSession);
        if (session.current !== currentSession) return;
        const errorCode = commandProbeErrorCode(cause);
        if (errorCode) {
          saveAvailability(model.id, "failed", errorCode);
          const reason = t(`offline.nativeModelProbeFailureReason.${probeFailureReasonKey(errorCode, true)}` as const);
          setError(t("offline.nativeModelProbeFailure", {
            reason,
            code: errorCode,
          }));
        } else {
          setError(errorMessage(cause) || t("offline.nativeModelManagerError"));
        }
      }
    } finally {
      if (prepareRequestId) requestIds.current.delete(prepareRequestId);
      if (probeRequestId) {
        requestIds.current.delete(probeRequestId);
        if (!retainProofForRetry) await managerApi.cancelGatewayModelProbe(probeRequestId).catch(() => false);
      }
      if (addRequestId.current) addRequestId.current = null;
      if (session.current === currentSession) {
        setReasoningTestingId(null);
        setAddingId(null);
      }
    }
  }, [addingId, availabilityById, catalogStatus, dualEdition, failedTestIds, failureCodeById, loading, reasoningTestingId, report, resetting, refreshCatalogState, saveAvailability, t, testingId]);

  const runTestAllModels = useCallback(async () => {
    if (loading || testingId || reasoningTestingId || addingId || resetting || addRequestId.current || catalogStatus !== "ok" || !report) return;
    const models = report.models.filter((model) => model.selectable);
    if (models.length === 0) return;
    setConfirmBulkTest(false);
    const currentSession = session.current;
    let passed = 0;
    let failed = 0;
    let stoppedForConnectionChange = false;
    let nextAvailability = { ...availabilityById };
    let nextFailedIds = [...failedTestIds];
    const nextFailureCodes = { ...failureCodeById };
    setError(null);
    setMessage(null);
    setBulkProgress({ current: 0, total: models.length });
    for (let index = 0; index < models.length; index += 1) {
      if (session.current !== currentSession) return;
      const model = models[index];
      const requestId = newRequestId("upstream-bulk-connectivity");
      requestIds.current.add(requestId);
      setTestingId(model.id);
      setBulkProgress({ current: index + 1, total: models.length });
      let available = false;
      let connectionChanged = false;
      let failureCode: string | null = null;
      try {
        const next = await managerApi.gatewayModelProbe({
          requestId,
          selectedModelIds: [],
          costConsent: false,
          connectivityModelId: model.id,
        });
        if (session.current !== currentSession) return;
        const result = next.results.find((item) => item.modelId === model.id);
        const connectionMatchesDiscovery = next.connectionFingerprint === report.connectionFingerprint
          && next.credentialFingerprint === report.credentialFingerprint
          && next.endpoint === report.endpoint;
        available = next.status === "passed" && result?.passed === true && connectionMatchesDiscovery;
        connectionChanged = !connectionMatchesDiscovery;
        if (!available && !connectionChanged) failureCode = safeProbeErrorCode(result?.errorCode ?? next.errorCode);
        if (connectionChanged) setError(t("offline.nativeModelManagerConnectionChanged"));
      } catch (cause) {
        if (session.current !== currentSession) return;
        failureCode = commandProbeErrorCode(cause);
      } finally {
        requestIds.current.delete(requestId);
        await managerApi.cancelGatewayModelProbe(requestId).catch(() => false);
      }
      if (session.current !== currentSession) return;
      nextAvailability = { ...nextAvailability, [model.id]: available ? "passed" : "failed" };
      nextFailedIds = available
        ? nextFailedIds.filter((id) => id !== model.id)
        : nextFailedIds.includes(model.id) ? nextFailedIds : [...nextFailedIds, model.id];
      if (available || connectionChanged || !failureCode) delete nextFailureCodes[model.id];
      else nextFailureCodes[model.id] = failureCode;
      setAvailabilityById(nextAvailability);
      setFailedTestIds(nextFailedIds);
      setFailureCodeById(nextFailureCodes);
      setCacheUpdatedAtMs(writeProbeCache(report, nextAvailability, nextFailedIds, nextFailureCodes));
      if (available) passed += 1;
      else failed += 1;
      if (connectionChanged) {
        stoppedForConnectionChange = true;
        break;
      }
    }
    if (session.current === currentSession) {
      setTestingId(null);
      setBulkProgress(null);
      if (!stoppedForConnectionChange) {
        setMessage(t("offline.nativeModelManagerTestAllDone", { passed, failed }));
      }
    }
  }, [addingId, availabilityById, catalogStatus, failedTestIds, failureCodeById, loading, reasoningTestingId, report, resetting, t, testingId]);

  const testAllModels = useCallback(() => {
    if (loading || testingId || reasoningTestingId || addingId || resetting || addRequestId.current || catalogStatus !== "ok" || !report) return;
    setConfirmBulkTest(true);
    setError(null);
  }, [addingId, catalogStatus, loading, reasoningTestingId, report, resetting, testingId]);

  const resetCatalog = useCallback(async () => {
    if (resetting || loading || testingId || reasoningTestingId || addingId || addRequestId.current) return;
    const currentSession = ++session.current;
    retryableAdd.current = null;
    setRetryableAddModelId(null);
    setResetting(true);
    setLoading(false);
    setTestingId(null);
    setAddingId(null);
    setError(null);
    setMessage(null);
    await cancelOutstanding();
    try {
      const result: NativeModelCatalogActionReport = await managerApi.manageNativeModelCatalog({ operation: "reset" });
      if (session.current !== currentSession) return;
      setActiveIds(result.modelIds ?? []);
      const resultMessage = result.status === "cleanup_pending"
        ? t("offline.nativeModelManagerResetCleanupPending")
        : result.status === "outcome_unconfirmed"
          ? t("offline.nativeModelManagerResetUnconfirmed")
          : result.status === "already_native"
            ? t("offline.nativeModelManagerResetAlready")
            : t("offline.nativeModelManagerResetDone");
      if (result.status === "cleanup_pending" || result.status === "outcome_unconfirmed") {
        setMessage(null);
        setError(resultMessage);
      } else {
        setMessage(resultMessage);
      }
      await refreshCatalogState(currentSession);
    } catch {
      if (session.current === currentSession) setError(t("offline.nativeModelManagerError"));
      await refreshCatalogState(currentSession);
    } finally {
      if (session.current === currentSession) setResetting(false);
    }
  }, [addingId, cancelOutstanding, loading, reasoningTestingId, refreshCatalogState, resetting, t, testingId]);

  const rows: ModelRow[] = report?.models.map((model) => ({ ...model })) ?? [];
  const activeOnlyRows: ModelRow[] = activeIds.length > 0
    ? activeIds
      .filter((id) => !rows.some((row) => row.id === id))
      .map((id) => ({ id, ownedBy: null, selectable: false, activeOnly: true }))
    : [];
  const catalogActionReason = catalogStatus === "orphaned"
    ? t("offline.nativeModelManagerOrphaned")
    : catalogStatus !== "ok"
      ? t("offline.nativeModelManagerCatalogUnavailable")
      : null;
  const catalogActionReasonId = `${titleId}-catalog-action-reason`;
  const managerTooltip = `${t("offline.nativeModelManagerSteps")}\n\n${t("offline.nativeModelManagerCostWarning")}`;
  const operationBusy = Boolean(loading || testingId || reasoningTestingId || addingId || resetting || addRequestId.current || bulkProgress);
  const claudeTab = dualEdition && tab === "claude";
  const bulkTestableModels = claudeTab ? claude?.directory ?? [] : report?.models.filter((model) => model.selectable) ?? [];
  const bulkRequestMinimum = bulkTestableModels.length;
  const bulkRequestEstimate = bulkTestableModels.length;

  async function claudeAction(action: "state" | "refresh" | "add" | "default" | "reset", id?: string) {
    const seq = ++claudeSequence.current;
    setClaudeOperation(action);
    setClaudeError(null);
    if (id) {
      setClaudeRow({ id, stage: action === "add" ? "preparing" : "saving" });
      setClaudeFailures(previous => { const next = {...previous}; delete next[id]; return next; });
    }
    try {
      const view = action === "add" && id
        ? await managerApi.manageClaudeModels(action, id, claude?.binding, stage => {
          if (seq === claudeSequence.current) setClaudeRow({ id, stage });
        })
        : await managerApi.manageClaudeModels(action, id, claude?.binding);
      if (seq !== claudeSequence.current) return;
      setClaude(view);
      if (action === "state" && view.ready) {
        const refreshed = await managerApi.manageClaudeModels("refresh", undefined, view.binding);
        if (seq === claudeSequence.current) setClaude(refreshed);
      }
    } catch (cause) {
      if (seq === claudeSequence.current) {
        const reason = errorMessage(cause).replace(/^update engine error:\s*/i, "");
        if (id) setClaudeFailures(previous => ({...previous, [id]: reason}));
        else setClaudeError(reason);
      }
    } finally {
      if (seq === claudeSequence.current) {
        ++claudeSequence.current;
        setClaudeOperation(null);
        setClaudeRow(null);
      }
    }
  }

  useEffect(() => () => { ++claudeSequence.current; }, []);

  async function testClaudeDirectory() {
    if (claudeBusy || !claude?.ready) return;
    const seq = ++claudeSequence.current;
    setConfirmBulkTest(false);
    setClaudeOperation("test");
    setClaudeError(null);
    setMessage(null);
    let passed = 0;
    try {
      for (const [index, id] of claude.directory.entries()) {
        setBulkProgress({current: index + 1, total: claude.directory.length});
        setClaudeRow({id, stage: "probing"});
        const result = await managerApi.testClaudeModel(id, claude.binding);
        if (seq !== claudeSequence.current) return;
        if (!result.ready) throw new Error(t("dual.syncWaiting"));
        const reason = result.probeError;
        setClaudeFailures(previous => {
          const next = {...previous};
          if (reason) next[id] = reason; else delete next[id];
          return next;
        });
        setClaudePassed(previous => reason ? previous.filter(item => item !== id) : [...previous.filter(item => item !== id), id]);
        if (!reason) passed++;
      }
      setMessage(t("offline.nativeModelManagerTestAllDone", {passed, failed: claude.directory.length - passed}));
    } catch (cause) {
      if (seq === claudeSequence.current) setClaudeError(errorMessage(cause));
    } finally {
      if (seq === claudeSequence.current) {
        ++claudeSequence.current;
        setClaudeOperation(null);
        setClaudeRow(null);
        setBulkProgress(null);
      }
    }
  }

  async function applyCodexDefault(id: string) {
    const current = session.current;
    setAddingId(id);
    setError(null);
    try {
      const state = await managerApi.manageNativeModelCatalog({ operation: "default", modelId: id });
      if (session.current === current) setCodexDefault(state.defaultModel ?? null);
    } catch (cause) {
      if (session.current === current) setError(errorMessage(cause));
    } finally {
      if (session.current === current) setAddingId(null);
    }
  }

  const configured = claude?.configured ?? [];
  const directory = claude?.directory ?? [];
  const claudeDefault = configured[0];
  const claudeMembers = new Set([...configured, ...(claude?.native ?? [])]);

  const refreshing = claudeTab ? (claudeOperation === "state" || claudeOperation === "refresh") : loading;
  const toolbar = <>
        <div className="upstream-model-manager-toolbar">
          <button
            type="button"
            className="btn primary upstream-model-manager-compact-action"
            onClick={() => claudeTab ? void claudeAction("refresh") : void discover()}
            disabled={operationBusy || claudeBusy}
            title={t(claudeTab ? "offline.nativeModelManagerRefresh" : "offline.nativeModelManagerSteps")}
          >
            {refreshing ? <Icon name="loader" className="spinicon" /> : <Icon name="refresh" />}
            {refreshing ? t("offline.nativeModelManagerDiscovering") : t("offline.nativeModelManagerRefresh")}
          </button>
          <button
            type="button"
            className="btn ghost upstream-model-manager-compact-action"
            onClick={() => claudeTab ? setConfirmBulkTest(true) : void testAllModels()}
            disabled={operationBusy || claudeBusy || !bulkTestableModels.length || (claudeTab ? !claude?.ready : catalogStatus !== "ok")}
            title={t("offline.nativeModelManagerCostWarning")}
          >
            {bulkProgress
              ? t("offline.nativeModelManagerTestAllProgress", bulkProgress)
              : t("offline.nativeModelManagerTestAll")}
          </button>
        </div>
            {confirmBulkTest ? (
              <div className="upstream-model-manager-bulk-confirm" role="alertdialog" aria-label={t("offline.nativeModelManagerTestAllConfirm", { count: bulkTestableModels.length, minimum: bulkRequestMinimum, requests: bulkRequestEstimate })}>
                <p>{t("offline.nativeModelManagerTestAllConfirm", { count: bulkTestableModels.length, minimum: bulkRequestMinimum, requests: bulkRequestEstimate })}</p>
                <div className="upstream-model-manager-add-footer">
                  <button type="button" className="btn ghost upstream-model-manager-compact-action" onClick={() => setConfirmBulkTest(false)}>
                    {t("confirm.cancel")}
                  </button>
                  <button type="button" className="btn primary upstream-model-manager-compact-action" onClick={() => claudeTab ? void testClaudeDirectory() : void runTestAllModels()}>
                    {t("offline.nativeModelManagerTestAllStart")}
                  </button>
                </div>
              </div>
            ) : null}

  </>;

  return (
    <Sheet
      open={open}
      onDismiss={onDismiss}
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocus="first"
      centeredInExpanded
    >
      <div className="upstream-model-manager" data-testid="upstream-model-manager">
        <div className="upstream-model-manager-topbar">
          <button type="button" className="btn ghost upstream-model-manager-back" onClick={onDismiss}>
            <Icon name="back" />
            {t("offline.nativeModelManagerBack")}
          </button>
          <button type="button" className="icon-btn" onClick={onDismiss} aria-label={t("nav.close")}>
            <Icon name="close" />
          </button>
        </div>
        <div className="upstream-model-manager-heading">
          <div>
            <h3 id={titleId}>{t("offline.nativeModelManagerTitle")}</h3>
            <p id={descriptionId} title={managerTooltip}>{t(dualEdition ? "dual.modelsDescription" : "offline.nativeModelManagerDescription")}</p>
          </div>
        </div>

        {dualEdition && <div className="upstream-model-manager-toolbar" role="group" aria-label={t("dual.modelApp")}>
          <button className={tab === "codex" ? "btn primary" : "btn ghost"} aria-pressed={tab === "codex"} disabled={operationBusy || claudeBusy} onClick={() => { setConfirmBulkTest(false); setMessage(null); setTab("codex"); }}>Codex</button>
          <button className={tab === "claude" ? "btn primary" : "btn ghost"} aria-pressed={tab === "claude"} disabled={operationBusy || claudeBusy} onClick={() => {
            setConfirmBulkTest(false);
            setMessage(null);
            setTab("claude");
            if (!claude && !claudeBusy) void claudeAction("state");
          }}>Claude Code</button>
        </div>}
        {dualEdition && tab === "claude" ? <>
          {claude?.ready === false ? <p>{t("dual.syncWaiting")}</p> : <>
            <p>{t(configured.length ? "dual.claudeCustom" : "dual.claudeAuto")}</p>
            <p className="upstream-model-manager-cost-note">{t("dual.claudeProbeCost")}</p>
            {toolbar}
            <ul className="upstream-model-manager-list">{[...new Set([...directory, ...configured])].map(id => {
              const added = claudeMembers.has(id);
              const stage = claudeRow?.id === id ? claudeRow.stage : null;
              const pending = stage === "preparing" ? t("dual.modelPreparing")
                : stage === "saving" ? t("dual.modelSaving")
                : stage === "probing" ? t("offline.nativeModelManagerTesting") : null;
              const reason = claudeFailures[id];
              const membership = added ? t("dual.claudeAdded") : t(claudePassed.includes(id)
                ? "offline.nativeModelManagerAvailabilityPassed" : "offline.nativeModelManagerNotTested");
              const status = pending ?? (reason ? (added ? membership + " · " + reason : reason) : membership);
              return <ModelListRow key={id} model={id} testId={"claude-model-" + id} status={status}
                actions={id === claudeDefault ? <span>{t("dual.modelDefault")}</span> :
                  <button type="button" className={`btn ${added ? "ghost" : "primary"} upstream-model-manager-compact-action`}
                    disabled={claudeBusy} onClick={() => void claudeAction(added ? "default" : "add", id)}>
                    {pending ?? t(added ? "dual.makeDefault" : reason ? "offline.nativeModelManagerRetryPrepare" : "offline.nativeModelManagerPrepareAdd")}
                  </button>} />;
            })}</ul>
            {message && <p role="status">{message}</p>}
            {configured.length > 0 && <button className="btn ghost" disabled={claudeBusy} onClick={() => void claudeAction("reset")}>{t("offline.nativeModelManagerReset")}</button>}
          </>}
          {claudeError && <p role="alert">{claudeError}</p>}
        </> : <>
        {dualEdition && <p>{codexDefault ? t("dual.currentDefault", { model: codexDefault }) : t("dual.appDefault")}</p>}
        <p className="upstream-model-manager-cost-note">{t("offline.nativeModelManagerProbeAddCost")}</p>
        {toolbar}

        {report && cacheUpdatedAtMs !== null ? (
          <small
            className="upstream-model-manager-cache"
            data-testid="upstream-model-cache-notice"
            title={t("offline.nativeModelManagerCacheNotice", {
              time: new Date(cacheUpdatedAtMs).toLocaleString(),
            })}
          >
            {t("offline.nativeModelManagerCacheNotice", {
              time: new Date(cacheUpdatedAtMs).toLocaleString(),
            })}
          </small>
        ) : null}

        {catalogActionReason ? (
          <p
            id={catalogActionReasonId}
            role={catalogStatus === "orphaned" ? "alert" : "status"}
            className="upstream-model-manager-error"
          >
            {catalogActionReason}
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="upstream-model-manager-list" data-testid="upstream-model-candidate-list">
            {rows.map((model, index) => {
              const isActive = activeIds.includes(model.id);
              const duplicate = !model.selectable && !model.activeOnly;
              const availability = availabilityById[model.id];
              const failed = availability === "failed" || failedTestIds.includes(model.id);
              const failureCode = safeProbeErrorCode(failureCodeById[model.id]);
              const failureReason = t(`offline.nativeModelProbeFailureReason.${probeFailureReasonKey(failureCode, failed && !failureCode)}` as const);
              const rowActionReason = duplicate
                ? t("offline.gatewayProbeDuplicateId")
                : operationBusy
                  ? t("offline.nativeModelManagerBusy")
                  : null;
              const actionStatus = model.activeOnly
                ? t("offline.nativeModelManagerMissingUpstream")
                : addingId === model.id
                  ? t("offline.nativeModelManagerAdding")
                  : reasoningTestingId === model.id
                      ? t("offline.nativeModelReasoningTesting")
                    : isActive
                      ? t("offline.nativeModelManagerActive")
                      : catalogStatus !== "ok" ? t(catalogStatus === null ? "dual.modelsLoading" : "dual.modelsUnknown")
                      : availability === "passed"
                        ? t("offline.nativeModelManagerAvailabilityPassed")
                        : failed
                          ? (failureCode
                            ? t(`offline.nativeModelProbeFailureShort.${probeFailureReasonKey(failureCode)}` as const)
                            : t("offline.nativeModelManagerTestFailedStatus"))
                          : duplicate
                            ? t("offline.gatewayProbeDuplicateId")
                            : t("offline.nativeModelManagerNotTested");
              const reasonId = `${titleId}-action-reason-${index}`;
              const actionDisabled = Boolean(catalogActionReason || rowActionReason);
              const canRetryAdd = retryableAddModelId === model.id;
              const actionReasonId = catalogActionReason
                ? catalogActionReasonId
                : rowActionReason
                  ? reasonId
                  : undefined;
              return (
                <ModelListRow key={`${model.id}:${model.ownedBy ?? ""}:${index}`} testId={`upstream-model-${model.id}`}
                  model={model.id} title={model.ownedBy ? `${model.id} · ${model.ownedBy}` : model.id}
                  status={actionStatus} statusTitle={failed ? `${actionStatus} · ${failureReason}${failureCode ? ` (${failureCode})` : ""}` : actionStatus}
                  actions={<>
                    {!isActive && !model.activeOnly ? (
                      <>
                        <button
                          type="button"
                          className="btn primary upstream-model-manager-compact-action"
                          onClick={() => void testReasoningEfforts(model)}
                          disabled={actionDisabled || operationBusy}
                          aria-describedby={actionReasonId}
                          title={t("offline.nativeModelManagerPrepareAdd")}
                          aria-label={reasoningTestingId === model.id || addingId === model.id
                            ? t("offline.nativeModelReasoningTesting")
                            : canRetryAdd
                              ? t("offline.nativeModelManagerRetryAdd")
                            : failed
                              ? t("offline.nativeModelManagerRetryPrepare")
                              : t("offline.nativeModelManagerPrepareAdd")}
                        >
                          {reasoningTestingId === model.id || addingId === model.id
                            ? t("offline.nativeModelReasoningTesting")
                            : canRetryAdd
                              ? t("offline.nativeModelManagerRetryAdd")
                            : failed
                              ? t("offline.nativeModelManagerRetryPrepare")
                              : t("offline.nativeModelManagerPrepareAdd")}
                        </button>
                        {rowActionReason ? (
                          <small id={reasonId} className="sr-only">
                            {rowActionReason}
                          </small>
                        ) : null}
                      </>
                    ) : (
                      dualEdition && isActive && model.id !== codexDefault
                        ? <button className="btn ghost" disabled={operationBusy} onClick={() => void applyCodexDefault(model.id)}>{t("dual.makeDefault")}</button>
                        : <span className="upstream-model-manager-row-status-spacer" aria-hidden="true" />
                    )}
                  </>}>
                  {!isActive && !model.activeOnly && report?.reasoningModelId === model.id && report.reasoningResults?.length ? (
                    <details className="upstream-model-manager-reasoning-details">
                      <summary>{t("offline.nativeModelReasoningResults")}</summary>
                      <ul className="upstream-model-manager-reasoning-results" aria-label={t("offline.nativeModelReasoningResults")}>
                        {report.reasoningResults.map((result: GatewayReasoningEffortResult) => (
                          <li key={result.effort}>
                            <span>{result.effort}</span>
                            <span className={`reasoning-result-${result.status}`}>
                              <span title={result.errorCode === "effort-probe-incomplete" ? t("offline.nativeModelReasoningIncomplete") : result.errorCode ?? undefined}>
                                {t(`offline.nativeModelReasoningStatus.${result.status}` as const)}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </ModelListRow>
              );
            })}
          </ul>
        ) : loading ? (
          <p>{t("offline.nativeModelManagerDiscovering")}</p>
        ) : report ? (
          <p>{t("offline.nativeModelManagerEmpty")}</p>
        ) : null}

        {activeOnlyRows.length > 0 ? (
          <details className="upstream-model-manager-local-only">
            <summary>{t("offline.nativeModelManagerLocalOnlyHeading")}</summary>
            <p>{t("offline.nativeModelManagerLocalOnlyNotice")}</p>
            <ul className="upstream-model-manager-list">
              {activeOnlyRows.map((model) => (
                <li key={model.id} data-testid={"upstream-model-configured-only-" + model.id}>
                  <strong className="upstream-model-manager-model-id" dir="ltr">{model.id}</strong>
                  <small>{t("offline.nativeModelManagerActive")}</small>
                  {dualEdition && model.id !== codexDefault && <button className="btn ghost" disabled={operationBusy} onClick={() => void applyCodexDefault(model.id)}>{t("dual.makeDefault")}</button>}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {error && !catalogActionReason ? <p role="alert" className="upstream-model-manager-error">{error}</p> : null}
        {message ? <p role="status">{message}</p> : null}

        <div className="upstream-model-manager-reset">
          <button
            type="button"
            className="btn ghost upstream-model-manager-compact-action"
            onClick={() => void resetCatalog()}
            disabled={operationBusy}
            title={t("offline.nativeModelManagerResetHelp")}
          >
            {resetting ? <Icon name="loader" className="spinicon" /> : <Icon name="refresh" />}
            {resetting ? t("offline.nativeModelManagerResetting") : t("offline.nativeModelManagerReset")}
          </button>
        </div>
        </>}
      </div>
    </Sheet>
  );
}

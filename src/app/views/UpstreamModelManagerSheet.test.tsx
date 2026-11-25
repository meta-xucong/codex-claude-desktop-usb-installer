import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { managerApi } from "../../services/managerApi";
import type { GatewayModelProbeReport, GatewayReasoningEffortResult } from "../../shared/types";
import { I18nProvider } from "../i18n";
import { ThemeProvider } from "../theme";
import { UpstreamModelManagerSheet } from "./UpstreamModelManagerSheet";

vi.mock("../../services/managerApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/managerApi")>();
  return {
    ...actual,
    managerApi: {
      ...actual.managerApi,
      gatewayModelProbe: vi.fn(),
      cancelGatewayModelProbe: vi.fn(),
      manageNativeModelCatalog: vi.fn(),
      manageClaudeModels: vi.fn(),
      testClaudeModel: vi.fn(),
    },
  };
});

const api = vi.mocked(managerApi);
const listing = {
  status: "connected" as const,
  endpoint: "https://404token.xyz/v1",
  credentialFingerprint: "sha256:fixture",
  connectionFingerprint: "binding-fixture",
  checkedAt: 1,
  models: [{ id: "vendor/model-latest", ownedBy: "fixture", selectable: true }],
  results: [],
  generatedRequests: 0,
  errorCode: null,
};
const ready = {
  status: "ready",
  modelIds: ["gpt-5"],
  restartRequired: false,
  message: "ready",
  connectionFingerprint: "binding-fixture",
  credentialFingerprint: "sha256:fixture",
};
const added = {
  ...ready,
  status: "applied_restart_pending",
  modelIds: ["gpt-5", "vendor/model-latest"],
  restartRequired: true,
  message: "added",
};

function passedProbe(
  results: GatewayReasoningEffortResult[] = [
    { effort: "low", status: "accepted_by_route", errorCode: null },
    { effort: "medium", status: "accepted_by_route", errorCode: null },
  ],
  modelId = "vendor/model-latest",
): GatewayModelProbeReport {
  return {
    ...listing,
    status: "passed" as const,
    generatedRequests: 4,
    reasoningModelId: modelId,
    reasoningProofId: "proof-single-click",
    connectivityProofId: "proof-single-click",
    reasoningResults: results,
    checkedAt: Math.floor(Date.now() / 1000),
    connectivityProofExpiresAt: Math.floor(Date.now() / 1000) + 300,
  };
}

function Harness({ dualEdition }: { dualEdition?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {!open ? <button type="button" onClick={() => setOpen(true)}>重新打开</button> : null}
      <UpstreamModelManagerSheet open={open} onDismiss={() => setOpen(false)} dualEdition={dualEdition} />
    </>
  );
}

function renderSheet(dualEdition = false) {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <Harness dualEdition={dualEdition} />
      </I18nProvider>
    </ThemeProvider>,
  );
}

async function clickProbeAndAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "探测并添加" }));
}

describe("UpstreamModelManagerSheet direct add flow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    localStorage.setItem("cam.lang", "zh-CN");
    localStorage.removeItem("codex-manager.upstream-model-probe.v1");
    api.manageNativeModelCatalog.mockImplementation(async (request) => {
      if (request.operation === "prepare") return ready;
      if (request.operation === "add") return added;
      return {
        status: "ok",
        modelIds: [],
        restartRequired: false,
        message: "state loaded",
        connectionFingerprint: "binding-fixture",
        credentialFingerprint: "sha256:fixture",
      };
    });
    api.gatewayModelProbe.mockResolvedValue(listing);
    api.cancelGatewayModelProbe.mockResolvedValue(true);
  });

  it("discovers models without probing or adding one", async () => {
    renderSheet();
    const row = await screen.findByTestId("upstream-model-vendor/model-latest");
    expect(within(row).getByRole("button", { name: "探测并添加" })).toBeInTheDocument();
    expect(api.gatewayModelProbe).toHaveBeenCalledTimes(1);
    expect(api.manageNativeModelCatalog).toHaveBeenCalledWith(expect.objectContaining({ operation: "state" }));
    expect(api.manageNativeModelCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "add" }));
  });

  it("keeps local model membership when the upstream directory rejects", async () => {
    api.manageNativeModelCatalog.mockResolvedValue({...added, status:"ok"});
    api.gatewayModelProbe.mockRejectedValue(new Error("offline"));
    renderSheet(true);
    const row = await screen.findByTestId("upstream-model-configured-only-vendor/model-latest");
    expect(within(row).getByText("已添加到 Codex")).toBeInTheDocument();
    expect(within(row).queryByRole("button",{name:"探测并添加"})).toBeNull();
  });

  it("loads Claude on demand and keeps model operations on the selected client", async () => {
    const user = userEvent.setup();
    const model = "claude-sonnet-5";
    const view = { ready: true, binding: "fixture", configured: [] as string[], native: ["claude-haiku-5-5", model], directory: ["claude-haiku-5-5", model, "gateway/other"] };
    api.manageClaudeModels.mockImplementation(async op => op === "default" ? { ...view, configured: [model, "claude-haiku-5-5"] } : view);
    renderSheet(true);
    await screen.findByTestId("upstream-model-vendor/model-latest");
    expect(api.manageClaudeModels).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Claude Code" }));
    const row = await screen.findByTestId("claude-model-" + model);
    expect(within(row).getByText("已添加到 Claude Code")).toBeVisible();
    expect(within(row).queryByRole("button", {name:"探测并添加"})).toBeNull();
    expect(within(screen.getByTestId("claude-model-gateway/other")).getByRole("button", {name:"探测并添加"})).toBeVisible();
    const pin = await screen.findAllByRole("button", { name: "设为默认" });
    await user.click(pin.find(button => button.closest("li")?.textContent?.includes(model))!);
    expect(api.manageClaudeModels).toHaveBeenCalledWith("default", model, "fixture");
    await user.click(screen.getByRole("button", { name: "Codex" }));
    await user.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(api.manageClaudeModels.mock.calls.map(c => c[0])).toEqual(["state", "refresh", "default"]);
    expect(api.manageNativeModelCatalog.mock.calls.every(([r]) => r.operation === "state")).toBe(true);
    expect(api.gatewayModelProbe).toHaveBeenCalledTimes(1);
  });

  it("shows a newly added Claude model on reopen without probing it twice", async () => {
    const user = userEvent.setup();
    const model = "gateway/additional";
    const native = ["claude-sonnet", "claude-sonnet[1m]"];
    let configured: string[] = [];
    api.manageClaudeModels.mockImplementation(async (operation) => {
      if (operation === "add") configured = [...native, model];
      return { ready: true, binding: "fixture", configured, native, directory: [...native, model] };
    });
    const first = renderSheet(true);
    await user.click(await screen.findByRole("button", { name: "Claude Code" }));
    const row = await screen.findByTestId("claude-model-" + model);
    await user.click(await within(row).findByRole("button", { name: "探测并添加" }));
    expect(await within(row).findByText("已添加到 Claude Code")).toBeVisible();
    first.unmount();
    renderSheet(true);
    await user.click(await screen.findByRole("button", { name: "Claude Code" }));
    const reopened = await screen.findByTestId("claude-model-" + model);
    expect(within(reopened).getByText("已添加到 Claude Code")).toBeVisible();
    expect(within(reopened).queryByRole("button", { name: "探测并添加" })).toBeNull();
    expect(api.manageClaudeModels.mock.calls.filter(([op]) => op === "add")).toEqual([["add", model, "fixture", expect.any(Function)]]);
    expect(api.manageNativeModelCatalog.mock.calls.every(([req]) => req.operation === "state")).toBe(true);
  });

  it("shows the actual Claude probe and save phases, and retries the failed row", async () => {
    const user = userEvent.setup();
    const model = "gemini-4-neon";
    const view = {ready:true, binding:"fixture", configured:["native"], directory:["native", model]};
    let fail!: (error: Error) => void;
    let done!: (result: typeof view) => void;
    let progress!: (stage: "probing" | "saving") => void;
    api.manageClaudeModels.mockImplementation(async (op, _id, _binding, stage) => {
      if (op !== "add") return view;
      progress = stage!;
      return new Promise((resolve, reject) => {done = resolve; fail = reject;});
    });
    renderSheet(true);
    await user.click(await screen.findByRole("button",{name:"Claude Code"}));
    const row = await screen.findByTestId("claude-model-"+model);
    await user.click(within(row).getByRole("button",{name:"探测并添加"}));
    expect(within(row).getByRole("button",{name:"正在准备探测…"})).toBeDisabled();
    act(() => progress("probing"));
    expect(within(row).getByRole("button",{name:"正在测试…"})).toBeDisabled();
    await act(async () => fail(new Error("网关限流（HTTP 429）。")));
    expect(within(row).getByText(/HTTP 429/)).toBeVisible();
    await user.click(within(row).getByRole("button",{name:"重新检测"}));
    act(() => progress("saving"));
    expect(within(row).getByRole("button",{name:"正在保存…"})).toBeDisabled();
    await act(async () => done({...view, configured:["native",model]}));
    expect(within(row).getByText("已添加到 Claude Code")).toBeVisible();
    act(() => progress("saving")); // Late IPC delivery after the command completed.
    expect(within(row).getByText("已添加到 Claude Code")).toBeVisible();
    expect(within(row).queryByText(/HTTP 429/)).toBeNull();
    expect(within(row).queryByRole("button",{name:"探测并添加"})).toBeNull();
    expect(api.manageNativeModelCatalog.mock.calls.every(([r]) => r.operation === "state")).toBe(true);
  });

  it("asks before testing the Claude directory and never writes during a bulk test", async () => {
    const user = userEvent.setup();
    api.manageClaudeModels.mockResolvedValue({ready:true,binding:"fixture",configured:[],directory:["one","two"]});
    api.testClaudeModel.mockResolvedValueOnce({ready:true,probeError:null}).mockResolvedValueOnce({ready:true,probeError:"HTTP 403"});
    renderSheet(true);
    await user.click(await screen.findByRole("button",{name:"Claude Code"}));
    await screen.findByTestId("claude-model-two");
    await user.click(screen.getByRole("button",{name:"测所有模型可用性"}));
    expect(api.testClaudeModel).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button",{name:"开始测试"}));
    expect(await within(screen.getByTestId("claude-model-two")).findByText("HTTP 403")).toBeVisible();
    expect(api.testClaudeModel.mock.calls).toEqual([["one","fixture"],["two","fixture"]]);
    expect(api.manageClaudeModels.mock.calls.every(([op]) => ["state","refresh"].includes(op))).toBe(true);
  });

  it("reports a non-Claude model as added only to Codex in the dual edition", async () => {
    api.manageNativeModelCatalog.mockImplementation(async ({ operation }) => ({
      ...ready, modelIds: [], status: operation === "state" ? "ok" : "already_added",
    }));
    renderSheet(true);
    await clickProbeAndAdd(userEvent.setup());
    await screen.findByText("这个模型已在 Codex 目录中。");
    expect(screen.queryByText("模型列表已更新，重新打开对应应用后可选择。")).toBeNull();
  });

  it("probes the full supported effort set and automatically adds after any accepted result", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    api.gatewayModelProbe
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(passedProbe());
    renderSheet();

    await clickProbeAndAdd(user);

    await waitFor(() => expect(api.manageNativeModelCatalog).toHaveBeenCalledWith(expect.objectContaining({
      operation: "add",
      modelId: "vendor/model-latest",
      connectivityProofId: "proof-single-click",
    })));
    expect(api.manageNativeModelCatalog.mock.invocationCallOrder[1])
      .toBeLessThan(api.gatewayModelProbe.mock.invocationCallOrder[1]!);
    expect(api.gatewayModelProbe.mock.calls[1]?.[0]).toMatchObject({
      reasoningModelId: "vendor/model-latest",
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      reasoningCostConsent: true,
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await within(screen.getByTestId("upstream-model-vendor/model-latest")).findByText("已添加到 Codex")).toBeInTheDocument();
    expect(screen.getByTestId("upstream-model-vendor/model-latest")).toBeInTheDocument();
  });

  it("keeps the accepted subset when later effort results are unknown and still adds", async () => {
    const user = userEvent.setup();
    api.gatewayModelProbe
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(passedProbe([
        { effort: "low", status: "accepted_by_route", errorCode: null },
        { effort: "medium", status: "unknown", errorCode: "upstream-timeout" },
      ]));
    renderSheet();

    await clickProbeAndAdd(user);

    await waitFor(() => expect(api.manageNativeModelCatalog).toHaveBeenCalledWith(expect.objectContaining({ operation: "add" })));
    expect(await within(screen.getByTestId("upstream-model-vendor/model-latest")).findByText("已添加到 Codex")).toBeInTheDocument();
  });

  it("omits none for Claude Opus 5.5 before sending the reasoning probe", async () => {
    const user = userEvent.setup();
    const opus = { id: "claude-opus-5-5", ownedBy: "fixture", selectable: true };
    api.gatewayModelProbe
      .mockResolvedValueOnce({ ...listing, models: [opus] })
      .mockResolvedValueOnce(passedProbe(undefined, opus.id));
    renderSheet();

    await user.click(await screen.findByRole("button", { name: "探测并添加" }));

    await waitFor(() => expect(api.gatewayModelProbe).toHaveBeenCalledTimes(2));
    expect(api.gatewayModelProbe.mock.calls[1]?.[0]).toMatchObject({
      reasoningModelId: opus.id,
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    });
    await waitFor(() => expect(api.manageNativeModelCatalog).toHaveBeenCalledWith(expect.objectContaining({ operation: "add" })));
  });

  it("preserves the tested proof after bounded Add retries and reuses it on the next click", async () => {
    const user = userEvent.setup();
    let addAttempts = 0;
    api.gatewayModelProbe
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(passedProbe());
    api.manageNativeModelCatalog.mockImplementation(async (request) => {
      if (request.operation === "prepare") return ready;
      if (request.operation === "add") {
        addAttempts += 1;
        return addAttempts <= 3 ? { ...ready, status: "precommit_retryable", retryable: true } : added;
      }
      return { ...ready, status: "ok", modelIds: [] };
    });
    renderSheet();

    await clickProbeAndAdd(user);

    const retryButton = await screen.findByRole("button", { name: "重试添加" });
    expect(addAttempts).toBe(3);
    expect(api.cancelGatewayModelProbe).not.toHaveBeenCalled();
    await user.click(retryButton);

    await waitFor(() => expect(addAttempts).toBe(4));
    expect(api.gatewayModelProbe).toHaveBeenCalledTimes(2);
    expect(api.manageNativeModelCatalog).toHaveBeenCalledTimes(6);
    expect(await within(screen.getByTestId("upstream-model-vendor/model-latest")).findByText("已添加到 Codex")).toBeInTheDocument();
  });

  it("does not add when no effort was explicitly accepted", async () => {
    const user = userEvent.setup();
    api.gatewayModelProbe
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce({ ...listing, status: "failed", errorCode: "no-effort-accepted", reasoningResults: [] });
    renderSheet();

    await clickProbeAndAdd(user);

    await waitFor(() => expect(api.gatewayModelProbe).toHaveBeenCalledTimes(2));
    expect(api.manageNativeModelCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "add" }));
  });

  it("stops before paid probes when local preparation reports a duplicate", async () => {
    const user = userEvent.setup();
    api.manageNativeModelCatalog.mockImplementation(async (request) => request.operation === "prepare"
      ? { ...ready, status: "already_added", modelIds: ["gpt-5", "vendor/model-latest"] }
      : request.operation === "add" ? added : { ...ready, status: "ok", modelIds: [] });
    renderSheet();

    await clickProbeAndAdd(user);

    expect(api.gatewayModelProbe).toHaveBeenCalledTimes(1);
    expect(api.manageNativeModelCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "add" }));
  });

  it("treats a detached existing catalog that was reattached during prepare as active", async () => {
    const user = userEvent.setup();
    api.manageNativeModelCatalog.mockImplementation(async (request) => request.operation === "prepare"
      ? { ...ready, status: "applied_restart_pending", modelIds: ["gpt-5", "vendor/model-latest"] }
      : { ...ready, status: "ok", modelIds: [] });
    renderSheet();

    await clickProbeAndAdd(user);

    expect(api.gatewayModelProbe).toHaveBeenCalledTimes(1);
    expect(api.manageNativeModelCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "add" }));
    expect(await within(screen.getByTestId("upstream-model-vendor/model-latest")).findByText("已添加到 Codex")).toBeInTheDocument();
  });

  it("does not begin paid probes if local prerequisites fail", async () => {
    const user = userEvent.setup();
    api.manageNativeModelCatalog.mockImplementation(async (request) => {
      if (request.operation === "prepare") throw new Error("local catalog conflict");
      return { ...ready, status: "ok", modelIds: [] };
    });
    api.gatewayModelProbe.mockResolvedValue(listing);
    renderSheet();

    await clickProbeAndAdd(user);

    expect(api.gatewayModelProbe).toHaveBeenCalledTimes(1);
    expect(api.manageNativeModelCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "add" }));
    expect(await screen.findByText("local catalog conflict")).toBeInTheDocument();
  });

  it("reports commit errors instead of claiming an uncommitted model was added", async () => {
    const user = userEvent.setup();
    api.manageNativeModelCatalog.mockImplementation(async (request) => {
      if (request.operation === "prepare") return ready;
      if (request.operation === "state") return { ...ready, status: "ok", modelIds: ["gpt-5"] };
      if (request.operation === "add") return { ...ready, status: "failed", modelIds: [], message: "write blocked" };
      return { ...ready, status: "ok", modelIds: [] };
    });
    api.gatewayModelProbe
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(passedProbe());
    renderSheet();

    await clickProbeAndAdd(user);

    expect(await screen.findByText("write blocked")).toBeInTheDocument();
    expect(within(screen.getByTestId("upstream-model-vendor/model-latest")).queryByText("已添加到 Codex")).not.toBeInTheDocument();
    expect(screen.getByTestId("upstream-model-configured-only-gpt-5")).toBeInTheDocument();
  });

  it("refreshes the catalog after Add throws so a committed model is not shown as missing", async () => {
    const user = userEvent.setup();
    let stateReads = 0;
    api.manageNativeModelCatalog.mockImplementation(async (request) => {
      if (request.operation === "prepare") return ready;
      if (request.operation === "state") {
        stateReads += 1;
        return {
          ...ready,
          status: "ok",
          modelIds: stateReads > 1 ? ["gpt-5", "vendor/model-latest"] : ["gpt-5"],
        };
      }
      if (request.operation === "add") throw new Error("connection lost after write");
      return { ...ready, status: "ok", modelIds: ["gpt-5"] };
    });
    api.gatewayModelProbe
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce(passedProbe());
    renderSheet();

    await clickProbeAndAdd(user);

    expect(await screen.findByText("connection lost after write")).toBeInTheDocument();
    await waitFor(() => expect(stateReads).toBe(2));
    const modelRow = screen.getByTestId("upstream-model-vendor/model-latest");
    expect(within(modelRow).getByText("已添加到 Codex")).toBeInTheDocument();
  });
});

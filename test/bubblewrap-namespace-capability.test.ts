import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bubblewrapNamespaceProbeArgsForTests, probeBubblewrapNamespaceCapability, reportUnavailableBubblewrapNamespaceCapability, type BubblewrapProbeResult } from "./bubblewrap-namespace-capability";

const success: BubblewrapProbeResult = { code: 0, signal: null, stdout: "BWRAP_NAMESPACE_OK", stderr: "", timedOut: false };
const dependencies = (result: BubblewrapProbeResult = success) => ({ platform: "linux" as const, access: vi.fn(async () => undefined), run: vi.fn(async () => result) });

describe("Bubblewrap namespace test-host capability probe", () => {
  it("reports available after a successful minimal namespace probe", async () => {
    const input = dependencies();
    await expect(probeBubblewrapNamespaceCapability(input)).resolves.toEqual({ available: true });
    expect(input.access).toHaveBeenCalledWith("/usr/bin/bwrap", constants.F_OK);
    expect(input.access).toHaveBeenCalledWith("/usr/bin/bwrap", constants.X_OK);
    expect(bubblewrapNamespaceProbeArgsForTests()).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid", "--unshare-net", "--proc", "/proc", "--tmpfs", "/tmp"]));
  });
  it("reports non-Linux without accessing the binary", async () => {
    const input = dependencies();
    await expect(probeBubblewrapNamespaceCapability({ ...input, platform: "darwin" })).resolves.toEqual({ available: false, reason: "platform_not_linux" });
    expect(input.access).not.toHaveBeenCalled();
  });
  it("classifies missing and non-executable binaries", async () => {
    const missing = dependencies(); missing.access.mockRejectedValueOnce(Object.assign(new Error(), { code: "ENOENT" }));
    await expect(probeBubblewrapNamespaceCapability(missing)).resolves.toEqual({ available: false, reason: "bwrap_missing" });
    const blocked = dependencies(); blocked.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error(), { code: "EACCES" }));
    await expect(probeBubblewrapNamespaceCapability(blocked)).resolves.toEqual({ available: false, reason: "bwrap_not_executable" });
  });
  for (const code of ["EPERM", "EACCES"] as const) it(`classifies spawn ${code} as unavailable`, async () => {
    const input = dependencies(); input.run.mockRejectedValueOnce(Object.assign(new Error(), { code }));
    await expect(probeBubblewrapNamespaceCapability(input)).resolves.toEqual({ available: false, reason: code.toLowerCase() });
  });
  it("classifies only a known denial token paired with a nonzero exit", async () => {
    await expect(probeBubblewrapNamespaceCapability(dependencies({ ...success, code: 1, stdout: "", stderr: "bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted" }))).resolves.toEqual({ available: false, reason: "namespace_unsupported" });
  });
  for (const result of [
    { ...success, code: 1, stdout: "", stderr: "bwrap: unknown option" },
    { ...success, code: null, signal: "SIGTERM" as NodeJS.Signals, stdout: "" },
    { ...success, code: null, stdout: "", timedOut: true },
  ]) it("rejects unknown, signal, and timeout outcomes", async () => {
    await expect(probeBubblewrapNamespaceCapability(dependencies(result))).rejects.toThrow();
  });
  it("uses a fixed content-free unavailable report", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try { reportUnavailableBubblewrapNamespaceCapability({ available: false, reason: "namespace_unsupported" }); expect(warn).toHaveBeenCalledWith("test_host_capability_unavailable", "{\"capability\":\"bubblewrap_namespace\",\"reason\":\"namespace_unsupported\"}"); }
    finally { warn.mockRestore(); }
  });
});

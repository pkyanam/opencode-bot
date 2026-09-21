import { describe, expect, it } from "vitest";
import { ComputerStartup } from "../apps/control-worker/src/computer-startup";

describe("computer startup", () => {
  it("returns immediately and deduplicates background warmup", async () => {
    const startup = new ComputerStartup();
    let finish!: () => void;
    let calls = 0;
    let work!: Promise<void>;
    const start = async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); };
    const retain = (value: Promise<void>) => { work = value; };
    expect(startup.read(start, retain).state).toBe("starting");
    expect(startup.read(start, retain).state).toBe("starting");
    await Promise.resolve();
    expect(calls).toBe(1);
    finish(); await work;
    expect(startup.read(start, retain).state).toBe("ready");
  });
  it("retries provisioning timeouts but stops after ten minutes", async () => {
    let now = 1000;
    const startup = new ComputerStartup(() => now);
    let work!: Promise<void>;
    const start = async () => { throw new Error("Container startup timed out"); };
    const retain = (value: Promise<void>) => { work = value; };
    startup.read(start, retain); await work;
    expect(startup.read(start, retain).state).toBe("starting");
    now += 601000;
    startup.read(start, retain); await work;
    expect(startup.read(start, retain).state).toBe("error");
  });
  it("does not hide permanent failures or expose upstream secrets", async () => {
    const startup = new ComputerStartup();
    let work!: Promise<void>;
    const retain = (value: Promise<void>) => { work = value; };
    startup.read(async () => { throw new Error("Forbidden secret=private-key"); }, retain); await work;
    expect(startup.read(async () => {}, retain)).toMatchObject({state:"error"});
    expect(JSON.stringify(startup.read(async () => {}, retain))).not.toContain("private-key");
    startup.read(async () => {}, retain, true); await work;
    expect(startup.read(async () => {}, retain).state).toBe("ready");
  });
});

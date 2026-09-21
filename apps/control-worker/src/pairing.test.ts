import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PairingError, PairingService } from "./pairing";

const dbs: DatabaseSync[] = [];
function fixture(start = 1_700_000_000_000) {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  let now = start;
  const sql = { exec(query: string, ...args: unknown[]) {
    const statement = db.prepare(query); const sqlArgs = args as any[]; const rows = statement.columns().length ? statement.all(...sqlArgs) : [];
    const changes = statement.columns().length ? 0 : Number(statement.run(...sqlArgs).changes);
    return { toArray: () => rows, rowsWritten: changes };
  }};
  const service = new PairingService(sql, { now: () => new Date(now) });
  return { service, advance: (ms: number) => { now += ms; } };
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe("first party pairing", () => {
  it("redeems a QR secret once and issues an independently revocable device token", async () => {
    const f = fixture();
    const invite = await f.service.createInvite({ label: "laptop" });
    const redeemed = await f.service.redeem({ secret: invite.qrSecret, deviceName: "Web", clientType: "web" }, "ip-a");
    expect(redeemed.deviceToken).toMatch(/^dt_/);
    expect(await f.service.authenticate(String(redeemed.deviceToken))).toMatchObject({ deviceId: redeemed.deviceId, clientType: "web" });
    await expect(f.service.redeem({ secret: invite.qrSecret, deviceName: "Other", clientType: "native" }, "ip-b")).rejects.toMatchObject({ status: 401 });
    f.service.revokeDevice(String(redeemed.deviceId));
    expect(await f.service.authenticate(String(redeemed.deviceToken))).toBeNull();
  });

  it("accepts the human code without exposing the invite id", async () => {
    const f = fixture();
    const invite = await f.service.createInvite();
    const redeemed = await f.service.redeem({ code: invite.code, deviceName: "Expo", clientType: "expo" }, "code-ip");
    expect(redeemed.deviceId).toMatch(/^pd_/);
  });

  it("validates device input before consuming an invite", async () => {
    const f = fixture();
    const invite = await f.service.createInvite();
    await expect(f.service.redeem({ secret: invite.qrSecret, deviceName: "", clientType: "web" }, "bad-input")).rejects.toMatchObject({ status: 400 });
    const redeemed = await f.service.redeem({ secret: invite.qrSecret, deviceName: "Valid", clientType: "web" }, "good-input");
    expect(redeemed.deviceId).toBeTruthy();
  });

  it("rejects expired invites and locks repeated human-code guesses", async () => {
    const f = fixture();
    const expired = await f.service.createInvite({ ttlMs: 10_000 });
    f.advance(10_001);
    await expect(f.service.redeem({ secret: expired.qrSecret, deviceName: "Web", clientType: "web" }, "ip-a")).rejects.toMatchObject({ status: 401 });
    const invite = await f.service.createInvite();
    for (let i = 0; i < 5; i++) await expect(f.service.redeem({ inviteId: invite.inviteId, code: "AAAAAAAAAAAA", deviceName: "Web", clientType: "web" }, `ip-${i}`)).rejects.toMatchObject({ status: 401 });
    await expect(f.service.redeem({ inviteId: invite.inviteId, code: invite.code, deviceName: "Web", clientType: "web" }, "last")).rejects.toMatchObject({ status: 401 });
  });

  it("limits redeem attempts per caller and owner can cancel an unused invite", async () => {
    const f = fixture();
    const invite = await f.service.createInvite();
    for (let i = 0; i < 30; i++) await expect(f.service.redeem({ secret: "bad" }, "same-ip")).rejects.toMatchObject({ status: 401 });
    await expect(f.service.redeem({ secret: "bad" }, "same-ip")).rejects.toMatchObject({ status: 429 });
    expect(f.service.deleteInvite(String(invite.inviteId))).toEqual({ deleted: true });
    await expect(f.service.redeem({ secret: invite.qrSecret, deviceName: "Web", clientType: "web" }, "new-ip")).rejects.toMatchObject({ status: 401 });
  });
});

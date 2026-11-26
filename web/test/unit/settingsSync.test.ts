/**
 * Settings sync's rules (src/state/settingsSync.ts): which copy wins on
 * start, and what stays pending after an upload. The server's checks on what
 * it stores: test/worker/me.test.ts.
 */
import { describe, expect, it } from "vitest";
import { afterUpload, planSync, type ServerCopy, type SyncMeta } from "../../src/state/settingsSync";

const meta = (over: Partial<SyncMeta> = {}): SyncMeta => ({ user: "u1", syncedAt: 1_000, changedAt: null, ...over });
const server = (over: Partial<ServerCopy> = {}): ServerCopy => ({ user: "u1", settings: { theme: "dark" }, updatedAt: 1_000, ...over });

describe("which copy wins on start", () => {
  it("a first sign-in uploads this device's settings", () => {
    expect(planSync(meta({ user: null, syncedAt: null }), server({ settings: null, updatedAt: null }))).toBe("upload");
    // Even when this device synced before (the account's copy was lost or never written).
    expect(planSync(meta(), server({ settings: null, updatedAt: null }))).toBe("upload");
  });

  it("a new device, or another account, takes the account's copy", () => {
    expect(planSync(meta({ user: null, syncedAt: null, changedAt: 5_000 }), server())).toBe("adopt");
    expect(planSync(meta({ user: "u2", syncedAt: 9_000 }), server())).toBe("adopt");
  });

  it("adopts a copy written since this device last synced", () => {
    expect(planSync(meta({ syncedAt: 1_000 }), server({ updatedAt: 2_000 }))).toBe("adopt");
  });

  it("last write wins between a newer copy and an unsent change here", () => {
    expect(planSync(meta({ syncedAt: 1_000, changedAt: 3_000 }), server({ updatedAt: 2_000 }))).toBe("upload");
    expect(planSync(meta({ syncedAt: 1_000, changedAt: 1_500 }), server({ updatedAt: 2_000 }))).toBe("adopt");
  });

  it("nothing new anywhere: nothing to do; an unsent change here goes up", () => {
    expect(planSync(meta(), server())).toBe("none");
    expect(planSync(meta({ changedAt: 4_000 }), server())).toBe("upload");
  });
});

describe("after an upload", () => {
  it("records the server's time and clears what was sent", () => {
    expect(afterUpload(meta({ changedAt: 4_000 }), "u1", 5_000, 4_000)).toEqual({ user: "u1", syncedAt: 5_000, changedAt: null });
  });

  it("keeps a change made while the upload was in flight", () => {
    expect(afterUpload(meta({ changedAt: 4_500 }), "u1", 5_000, 4_000)).toEqual({ user: "u1", syncedAt: 5_000, changedAt: 4_500 });
  });
});

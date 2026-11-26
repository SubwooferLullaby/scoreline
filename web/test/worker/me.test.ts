/**
 * `/api/me`'s checks on what the account keeps (worker/me.ts): a JSON
 * object of settings, at most 64 KB, and dates read either way D1 holds them.
 */
import { describe, expect, it } from "vitest";
import { epochMillis, parseSettingsBody, SETTINGS_LIMIT } from "../../worker/me";

describe("what the account keeps", () => {
  it("takes an object of settings", () => {
    const parsed = parseSettingsBody(JSON.stringify({ settings: { theme: "dark", followedTeams: [] } }));
    expect(parsed).toEqual({ ok: true, json: '{"theme":"dark","followedTeams":[]}' });
  });

  it("refuses anything else", () => {
    for (const body of ["", "nope", "[]", "{}", '{"settings":[]}', '{"settings":"dark"}', '{"settings":null}']) {
      expect(parseSettingsBody(body), body).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("limits a copy to 64 KB", () => {
    const big = JSON.stringify({ settings: { note: "x".repeat(SETTINGS_LIMIT) } });
    expect(parseSettingsBody(big)).toMatchObject({ ok: false, status: 413 });
    const fits = JSON.stringify({ settings: { note: "x".repeat(SETTINGS_LIMIT - 100) } });
    expect(parseSettingsBody(fits)).toMatchObject({ ok: true });
  });

  it("reads D1's dates either way", () => {
    expect(epochMillis(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(epochMillis("1700000000000")).toBe(1_700_000_000_000);
    expect(epochMillis("2026-11-26T00:00:00.000Z")).toBe(Date.parse("2026-11-26T00:00:00.000Z"));
    expect(epochMillis(null)).toBeNull();
  });
});

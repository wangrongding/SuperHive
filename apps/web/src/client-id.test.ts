import { describe, expect, it } from "vitest";
import { createClientMessageId } from "./client-id";

describe("createClientMessageId", () => {
  it("uses crypto.randomUUID when the browser exposes it", () => {
    expect(
      createClientMessageId({
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("creates an RFC 4122 UUID when randomUUID is unavailable", () => {
    expect(
      createClientMessageId({
        getRandomValues: (values) => values.fill(0),
      }),
    ).toBe("00000000-0000-4000-8000-000000000000");
  });
});

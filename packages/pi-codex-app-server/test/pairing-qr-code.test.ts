import { describe, expect, it } from "./support/vitest-compat.ts";

import { renderPairingQrCode } from "../src/extension/pairing-qr-code.ts";

describe("pairing QR code", () => {
  it("renders a pairing payload for the Pi TUI", async () => {
    await expect(renderPairingQrCode("pairing-payload")).resolves.toContain(
      "\n"
    );
  });
});

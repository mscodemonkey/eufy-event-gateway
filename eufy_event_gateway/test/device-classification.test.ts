import assert from "node:assert/strict";
import test from "node:test";

import { isSupportedMegaCamera } from "../src/provider/eufy-provider.js";

test("recognizes the security camera types present in Mega inventory", () => {
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 7 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 8 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 10031 }), true);
  assert.equal(isSupportedMegaCamera({ category: "eufy_security", deviceType: 18 }), false);
  assert.equal(isSupportedMegaCamera({ category: "eufy_clean", deviceType: 8 }), false);
});

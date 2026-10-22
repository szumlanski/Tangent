import { test } from "node:test";
import assert from "node:assert/strict";
import { localTopic, isLocal, opening } from "../fetcher/local.js";

test("local filter keeps regional stories and drops wire", () => {
  assert.equal(isLocal("swfl", "Cape Coral residents react to $30M incentives for new hospital"), true);
  assert.equal(isLocal("swfl", "Mostly dry & sunny Thursday", "", opening("<p>Southwest Florida stays dry today.</p>")), true);
  assert.equal(isLocal("swfl", "Russia hits Ukraine with missiles, drones hours after agreeing to peace talks"), false);
  assert.equal(isLocal("swfl", "Pope Leo XIV needs no further cancer treatment, Vatican says"), false);
  assert.equal(isLocal("vermont", "Burlington council votes on housing"), true);
  assert.equal(isLocal("vermont", "Scott Bessent testifies before Congress"), false);
  assert.equal(localTopic({ topic: "swfl", kind: "news", selectors: { local: true } }), "swfl");
  assert.equal(localTopic({ topic: "swfl", kind: "youtube" }), null);
  assert.equal(localTopic({ topic: "swfl", kind: "news", access: "subscriber" }), null);
  assert.equal(localTopic({ topic: "tech", kind: "news", selectors: { local: true } }), null);
  assert.equal(localTopic({ topic: "swfl", kind: "news" }), null);
});

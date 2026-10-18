import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, inQuiet, phraseRe } from "../fetcher/alerts.js";

const U = "u1";
const art = (id, title, extra = {}) => ({ id, title, excerpt: "", source_id: 1, source_name: "WINK", cluster_id: null, published_at: "2026-10-18T12:00:00Z", ...extra });
const base = (over = {}) => ({
  articles: [], bigStories: [], alerts: [], users: new Map([[U, { settings: {} }]]), shelves: new Map(),
  sent: new Map(), tzByUser: new Map([[U, "UTC"]]), now: new Date("2026-10-18T15:00:00Z"), ...over,
});

test("keyword alerts match whole words, once per story", () => {
  const r = plan(base({
    articles: [art(1, "FPL rate case hearing set"), art(2, "Another FPL rate case story", { cluster_id: 9 }), art(3, "Same story elsewhere: FPL rate case", { cluster_id: 9 }), art(4, "FPLX is not it")],
    alerts: [{ id: 5, user_id: U, kind: "keyword", phrase: "fpl rate case" }],
  }));
  assert.deepEqual(r.map(x => x.url), ["/#a=1", "/#a=2"]);
  assert.ok(!phraseRe("fpl").test("FPLX up 3%"));
});

test("already-sent keys are not repeated, and the daily cap holds", () => {
  const alerts = [{ id: 5, user_id: U, kind: "keyword", phrase: "storm" }];
  const articles = [art(1, "Storm nears"), art(2, "Storm turns"), art(3, "Storm surge")];
  const sent = new Map([[U, { keys: new Set(["kw:5:a1"]), today: 8, shelfLast: new Map() }]]);
  const r = plan(base({ articles, alerts, sent, users: new Map([[U, { settings: { alerts: { max: 10 } } }]]) }));
  assert.deepEqual(r.map(x => x.key), ["kw:5:a2", "kw:5:a3"]);
});

test("big stories only reach people whose shelves cover them", () => {
  const big = { cluster_id: 7, headline: "Hurricane makes landfall", outlets: 5, sources: new Set([1, 2]), lead: art(10, "x", { cluster_id: 7 }) };
  const alerts = [{ id: 1, user_id: U, kind: "big" }];
  const covered = plan(base({ bigStories: [big], alerts, shelves: new Map([[U, [{ id: 3, name: "SWFL", sources: new Set([2]) }]]]) }));
  assert.equal(covered[0].title, "Big story · 5 outlets");
  const other = plan(base({ bigStories: [big], alerts, shelves: new Map([[U, [{ id: 3, name: "Travel", sources: new Set([40]) }]]]) }));
  assert.equal(other.length, 0);
});

test("shelf alerts batch and wait an hour between pushes", () => {
  const shelves = new Map([[U, [{ id: 3, name: "Vermont", sources: new Set([1]) }]]]);
  const alerts = [{ id: 8, user_id: U, kind: "shelf", shelf_id: 3 }];
  const articles = [art(1, "Town meeting"), art(2, "Snow coming")];
  assert.equal(plan(base({ articles, alerts, shelves }))[0].title, "Vermont: 2 new stories");
  const recent = new Map([[U, { keys: new Set(), today: 1, shelfLast: new Map([[8, new Date("2026-10-18T14:30:00Z")]]) }]]);
  assert.equal(plan(base({ articles, alerts, shelves, sent: recent })).length, 0);
});

test("quiet hours, including overnight ranges", () => {
  assert.ok(inQuiet([22, 7], 23) && inQuiet([22, 7], 3) && !inQuiet([22, 7], 12));
  assert.ok(!inQuiet([0, 0], 3));
  const r = plan(base({ articles: [art(1, "Storm")], alerts: [{ id: 5, user_id: U, kind: "keyword", phrase: "storm" }], now: new Date("2026-10-18T03:00:00Z") }));
  assert.equal(r.length, 0);
});

test("big stories follow each persona's own shelves", () => {
  const big = { cluster_id: 7, headline: "Fed cuts rates", outlets: 6, sources: new Set([50]), lead: art(10, "x", { cluster_id: 7 }) };
  const shelves = new Map([[11, [{ id: 1, name: "Business", sources: new Set([50]) }]], [12, [{ id: 2, name: "Hobbies", sources: new Set([90]) }]]]);
  const work = plan(base({ bigStories: [big], shelves, alerts: [{ id: 1, user_id: U, persona_id: 11, kind: "big" }] }));
  const play = plan(base({ bigStories: [big], shelves, alerts: [{ id: 2, user_id: U, persona_id: 12, kind: "big" }] }));
  assert.equal(work.length, 1);
  assert.equal(play.length, 0);
});

test("guest devices get any big story", () => {
  const big = { cluster_id: 8, headline: "Quake", outlets: 5, sources: new Set([3]), lead: art(11, "x", { cluster_id: 8 }) };
  const r = plan(base({ bigStories: [big], alerts: [{ id: null, user_id: "g5", kind: "big" }], users: new Map([["g5", { settings: { alerts: { max: 5, quiet: [22, 7] } } }]]), tzByUser: new Map([["g5", "UTC"]]) }));
  assert.deepEqual(r.map(x => [x.user_id, x.key]), [["g5", "big:8"]]);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler, isValidKey, parseRange } from "../src/server.ts";
import { signKey, verifySignature } from "../src/sign.ts";

const TOKEN = "a".repeat(64);
let server: Server;
let base: string;
let dir: string;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "keyhole-"));
	const handle = createHandler({ dataDir: dir, tokens: [TOKEN], maxUploadBytes: 1024, port: 0, host: "127.0.0.1" });
	server = createServer((req, res) => void handle(req, res));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("no address");
	base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
	server.close();
	await rm(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}` };

test("rejects requests without credentials", async () => {
	assert.equal((await fetch(`${base}/f/2026/11/x.png`)).status, 401);
	assert.equal((await fetch(`${base}/f/2026/11/x.png`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
});

test("health needs no auth", async () => {
	assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("put, get, range, delete", async () => {
	const key = "2026/11/0123456789abcdef-hello.txt";
	const put = await fetch(`${base}/f/${key}`, { method: "PUT", headers: auth, body: "hello world" });
	assert.equal(put.status, 201);
	const get = await fetch(`${base}/f/${key}`, { headers: auth });
	assert.equal(get.status, 200);
	assert.equal(await get.text(), "hello world");
	assert.equal(get.headers.get("x-content-type-options"), "nosniff");
	const part = await fetch(`${base}/f/${key}`, { headers: { ...auth, Range: "bytes=6-" } });
	assert.equal(part.status, 206);
	assert.equal(await part.text(), "world");
	assert.equal((await fetch(`${base}/f/${key}`, { method: "DELETE", headers: auth })).status, 204);
	assert.equal((await fetch(`${base}/f/${key}`, { headers: auth })).status, 404);
});

test("signed URLs allow GET only, and expire", async () => {
	const key = "a/b.mp4";
	await fetch(`${base}/f/${key}`, { method: "PUT", headers: auth, body: "video" });
	const exp = Math.floor(Date.now() / 1000) + 60;
	const sig = signKey(TOKEN, "GET", key, exp);
	assert.equal((await fetch(`${base}/f/${key}?ke=${exp}&ks=${sig}`)).status, 200);
	assert.equal((await fetch(`${base}/f/${key}?ke=${exp}&ks=${sig}`, { method: "PUT", body: "x" })).status, 401);
	assert.equal((await fetch(`${base}/f/other.mp4?ke=${exp}&ks=${sig}`)).status, 401);
	const old = Math.floor(Date.now() / 1000) - 1;
	assert.equal((await fetch(`${base}/f/${key}?ke=${old}&ks=${signKey(TOKEN, "GET", key, old)}`)).status, 401);
});

test("rejects oversized uploads and path traversal", async () => {
	assert.equal((await fetch(`${base}/f/big.bin`, { method: "PUT", headers: auth, body: "x".repeat(2048) })).status, 413);
	assert.equal((await fetch(`${base}/f/..%2Fetc%2Fpasswd`, { headers: auth })).status, 400);
	assert.equal((await fetch(`${base}/f/.hidden`, { headers: auth })).status, 400);
});

test("key validation", () => {
	assert.ok(isValidKey("2026/11/abc-def.png"));
	for (const bad of ["", "../x", "a//b", ".x", "a/../b", "a/b/", "a b"]) assert.ok(!isValidKey(bad), bad);
});

test("range parsing", () => {
	assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
	assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
	assert.deepEqual(parseRange("bytes=95-200", 100), { start: 95, end: 99 });
	assert.equal(parseRange("bytes=100-", 100), "invalid");
	assert.equal(parseRange(undefined, 100), null);
});

test("signature verification refuses far-future expiry", () => {
	const now = 1_000_000;
	const exp = now + 30 * 24 * 3600;
	assert.equal(verifySignature([TOKEN], "GET", "k.png", exp, signKey(TOKEN, "GET", "k.png", exp), now), false);
});

test("lists files for the bearer token only", async () => {
	await fetch(`${base}/f/list/a/one.txt`, { method: "PUT", headers: auth, body: "1" });
	await fetch(`${base}/f/list/b/two.txt`, { method: "PUT", headers: auth, body: "22" });
	assert.equal((await fetch(`${base}/f/?list=1`)).status, 401);
	const res = await fetch(`${base}/f/?list=1&prefix=list/`, { headers: auth });
	assert.equal(res.status, 200);
	const files = (await res.json()) as { key: string; size: number }[];
	assert.deepEqual(files.map((f) => `${f.key}:${f.size}`).sort(), ["list/a/one.txt:1", "list/b/two.txt:2"]);
});

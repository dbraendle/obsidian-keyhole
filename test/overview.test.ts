import { describe, expect, it } from "vitest";
import { filterByName, sortLocal } from "../src/overview-rules";

const rows = [
	{ name: "b.png", size: 10, notes: 1 },
	{ name: "Holiday Lake.jpg", size: 500, notes: 0 },
	{ name: "a.png", size: 10, notes: 2 },
];

describe("sortLocal", () => {
	it("puts the largest first and breaks ties by name, without changing the input", () => {
		expect(sortLocal(rows).map((r) => r.name)).toEqual(["Holiday Lake.jpg", "a.png", "b.png"]);
		expect(rows[0]?.name).toBe("b.png");
	});
});

describe("filterByName", () => {
	it("returns everything for an empty filter", () => {
		expect(filterByName(rows, "  ")).toBe(rows);
	});

	it("needs every word, ignoring case", () => {
		expect(filterByName(rows, "lake HOLI").map((r) => r.name)).toEqual(["Holiday Lake.jpg"]);
		expect(filterByName(rows, "lake png")).toEqual([]);
		expect(filterByName(rows, ".png")).toHaveLength(2);
	});
});

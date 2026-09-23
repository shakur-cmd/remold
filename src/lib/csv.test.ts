import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "./csv";

describe("csv", () => {
  it("reads quoted commas, escaped quotes, line breaks and Windows endings", () => {
    const text = '﻿Name,Notes\r\n"Acme, Inc","Said ""hi""\nthen left"\r\nBolt,\r\n\r\n';
    expect(parseCsv(text)).toEqual([["Name", "Notes"], ["Acme, Inc", 'Said "hi"\nthen left'], ["Bolt", ""]]);
  });
  it("writes what it reads back unchanged", () => {
    const rows = [["Name", "Notes"], ["Acme, Inc", 'Said "hi"\nthen left'], ["Bolt", ""]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

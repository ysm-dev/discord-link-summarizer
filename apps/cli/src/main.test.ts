import { describe, expect, it } from "vitest";
import { main } from "./main.ts";

describe("main", () => {
  it("prints the duration in milliseconds", () => {
    expect(main(["90m"])).toEqual({ code: 0, output: "5400000" });
  });

  it("reports usage when no argument is given", () => {
    expect(main([])).toEqual({ code: 2, output: "usage: duration <value>" });
  });

  it("reports the parse error when the argument is invalid", () => {
    expect(main(["90y"])).toEqual({
      code: 1,
      output: 'error: duration has an unknown unit: "y"',
    });
  });

  it("ignores arguments after the first", () => {
    expect(main(["1s", "ignored"])).toEqual({ code: 0, output: "1000" });
  });
});

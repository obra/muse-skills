import { describe, expect, test } from "bun:test";

import {
  hash32,
  lookDirective,
  narrowToFind,
  parseProbeArgv,
  requestFromArgv,
} from "./probe-ui-cli";
import {
  MAX_OBSERVE_NODES,
  OBSERVE_ATTR,
  clippedNodes,
  freezeTimeScript,
  isUselessName,
  observeWalkScript,
  unnamedInteractiveNodes,
  type ObserveWalk,
} from "./probe-ui-observe";

describe("parseProbeArgv", () => {
  test("accepts --k=v, --k v, bare flags and a positional", () => {
    const { op, flags } = parseProbeArgv([
      "act",
      "--node=12",
      "--snapshot",
      "s3-99",
      "--click",
    ]);
    expect(op).toBe("act");
    expect(flags.get("node")).toBe("12");
    expect(flags.get("snapshot")).toBe("s3-99");
    expect(flags.get("click")).toBe("true");
  });

  test("keeps a value that itself looks like a sentence", () => {
    const { flags } = parseProbeArgv(["flag", "--what", "the CTA is clipped at 390px"]);
    expect(flags.get("what")).toBe("the CTA is clipped at 390px");
  });

  test("viewport takes its preset positionally", () => {
    const { op, flags } = parseProbeArgv(["viewport", "mobile"]);
    expect(op).toBe("viewport");
    expect(flags.get("_positional")).toBe("mobile");
  });
});

describe("requestFromArgv", () => {
  const parse = (argv: string[]) => {
    const { op, flags } = parseProbeArgv(argv);
    return requestFromArgv(op, flags);
  };

  test("act needs a node number and an action", () => {
    expect(parse(["act", "--click"])).toContain("--node");
    expect(parse(["act", "--node=3"])).toContain("--click");
    expect(parse(["act", "--node=0", "--click"])).toContain("--node");
  });

  test("act carries the action payloads", () => {
    expect(parse(["act", "--node=3", "--fill", "QA_MARK"])).toEqual({
      op: "act",
      node: 3,
      action: "fill",
      text: "QA_MARK",
    });
    expect(parse(["act", "--node=3", "--press", "Enter"])).toEqual({
      op: "act",
      node: 3,
      action: "press",
      key: "Enter",
    });
    expect(parse(["act", "--node=3", "--scroll", "250"])).toEqual({
      op: "act",
      node: 3,
      action: "scroll",
      dy: 250,
    });
  });

  test("viewport only accepts the two presets", () => {
    expect(parse(["viewport", "mobile"])).toEqual({ op: "viewport", preset: "mobile" });
    expect(parse(["viewport", "tablet"])).toContain("desktop or mobile");
  });

  test("flag requires something to report", () => {
    expect(parse(["flag"])).toContain("--what");
    expect(parse(["flag", "--what", "x"])).toEqual({
      op: "flag",
      severity: "major",
      what: "x",
    });
  });

  test("the op set is closed", () => {
    // A socket the builder can reach is only as safe as the ops it accepts;
    // anything eval-shaped must be rejected before it reaches the server.
    expect(parse(["eval", "--js=fetch('/steal')"])).toContain("unknown op");
    expect(parse(["goto", "--url=http://elsewhere"])).toContain("unknown op");
  });
});

describe("observe walk script", () => {
  test("embeds the attribute and cap it will stamp with", () => {
    const script = observeWalkScript("button", OBSERVE_ATTR, MAX_OBSERVE_NODES);
    expect(script).toContain(JSON.stringify(OBSERVE_ATTR));
    expect(script).toContain(String(MAX_OBSERVE_NODES));
    // elementFromPoint containment is what rules out a node covered by an
    // overlay — a state a screenshot shows as present and a click fails on.
    expect(script).toContain("elementFromPoint");
  });

  test("clears the previous walk's numbering before assigning new numbers", () => {
    const script = observeWalkScript("button", OBSERVE_ATTR, MAX_OBSERVE_NODES);
    // Without this, an element that drops out of the walk keeps its old number
    // while a new element gets the same one, and `act` fails `stale_node` on an
    // ambiguous locator -- the exact failure class the probe removes.
    expect(script).toContain("removeAttribute");
    const clearAt = script.indexOf("removeAttribute");
    const assignAt = script.indexOf("setAttribute");
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(assignAt);
  });
});

describe("freezeTimeScript", () => {
  test("pins Date.now and seeds Math.random", () => {
    const script = freezeTimeScript(1_767_225_600_000);
    expect(script).toContain("1767225600000");
    expect(script).toContain("Math.random");
    expect(script).toContain("performance.now");
  });
});

describe("isUselessName", () => {
  test("punctuation-only and empty names are unusable", () => {
    // Real case: a weight field and a reps field both accessibly named "-".
    for (const name of ["", "   ", "-", "—", "…", "*"]) {
      expect(isUselessName(name)).toBe(true);
    }
  });

  test("anything with a letter or digit is usable", () => {
    for (const name of ["Add set", "5", "✓ done", "KG"]) {
      expect(isUselessName(name)).toBe(false);
    }
  });
});

describe("unnamedInteractiveNodes", () => {
  test("reports only interactive nodes whose name cannot be acted on", () => {
    const walk: ObserveWalk = {
      nodes: [
        { i: 1, role: null, name: "-", tag: "input", bbox: [0, 0, 10, 10], enabled: true, interactive: true },
        { i: 2, role: null, name: "Add", tag: "button", bbox: [0, 0, 10, 10], enabled: true, interactive: true },
        { i: 3, role: null, name: "", tag: "li", bbox: [0, 0, 10, 10], enabled: true, interactive: false },
      ],
      interactive_nodes: 2,
      total_candidates: 3,
      truncated: false,
      clipped: [],
      unreachable: [],
      needs_inner_scroll: 0,
    };
    expect(unnamedInteractiveNodes(walk).map((n) => n.i)).toEqual([1]);
  });
});

describe("hash32", () => {
  test("is deterministic (the page clock is frozen, so ids must not use time)", () => {
    expect(hash32("1:0")).toBe(hash32("1:0"));
    expect(hash32("1:0")).not.toBe(hash32("2:0"));
  });
});

describe("clippedNodes", () => {
  test("reports cut-off text and ignores rounding noise and empty nodes", () => {
    // The four visual defects the corpus's audits missed were all this shape:
    // a column truncated to "DA AP", a badge cut at its parent's edge. Note the
    // scan is deliberately NOT limited to act targets — those defects sat on a
    // <span> and a <p>, which are not clickable.
    const walk: ObserveWalk = {
      nodes: [],
      interactive_nodes: 0,
      total_candidates: 0,
      truncated: false,
      clipped: [
        { tag: "th", text: "Date Applied", kind: "text_truncated", overflow_px: 62, bbox: [0, 0, 40, 20] },
        { tag: "span", text: "SELECTED", kind: "past_viewport", overflow_px: 9, bbox: [1430, 0, 60, 20] },
        { tag: "td", text: "", kind: "text_truncated", overflow_px: 40, bbox: [0, 0, 40, 20] },
      ],
      unreachable: [],
      needs_inner_scroll: 0,
    };
    expect(clippedNodes(walk).map((c) => c.text)).toEqual(["Date Applied", "SELECTED"]);
  });
});

describe("unknown flags fail loudly", () => {
  const parse = (argv: string[]) => {
    const { op, flags } = parseProbeArgv(argv);
    return requestFromArgv(op, flags);
  };

  test("an op passed as a flag is named as such", () => {
    // 10 of 18 runs in sampled production runs passed `--viewport`, which is an op, and
    // were silently answered in desktop — believing they had checked a narrow
    // layout they never loaded.
    const err = parse(["observe", "--viewport", "mobile"]);
    expect(typeof err).toBe("string");
    expect(err).toContain("is an op, not a flag");
  });

  test("a plain typo is rejected rather than dropped", () => {
    expect(parse(["act", "--node=3", "--click", "--timeuot", "5000"]))
      .toContain("does not accept --timeuot");
  });

  test("legitimate flags still pass", () => {
    expect(parse(["act", "--node=3", "--fill", "x"])).toEqual({
      op: "act", node: 3, action: "fill", text: "x",
    });
    expect(parse(["viewport", "mobile"])).toEqual({ op: "viewport", preset: "mobile" });
  });
});

describe("lookDirective", () => {
  const png = "/w/audits/x/act-003.png";
  const prev = "/w/audits/x/observe-002.png";

  test("a fresh frame after an act names the file and demands a read", () => {
    const d = lookDirective(png, true) ?? "";
    // The first cut wrote 73 frames and the model read none of them: the text
    // has to be an instruction about the next step, not a note about the file.
    expect(d).toContain(png);
    expect(d).toContain("READ");
    expect(d).toContain("just changed the page");
  });

  test("an act that changed no pixels says so as evidence, naming the twin frame", () => {
    const d = lookDirective(png, true, prev) ?? "";
    expect(d).toContain("DID NOT CHANGE");
    expect(d).toContain("no visible effect");
    expect(d).toContain(prev);
  });

  test("an unchanged observe frame conditions the skip on already having read", () => {
    const d = lookDirective(png, false, prev) ?? "";
    // Honest: never assert "no need to re-read" against pixels the model may not
    // have opened — condition it on the prior frame it was already pointed at.
    expect(d).toContain(prev);
    expect(d).toContain("no need to re-read");
    expect(d).toContain("if you have not");
    expect(d).toContain(png);
  });

  test("no screenshot means no directive at all", () => {
    expect(lookDirective(null, true)).toBeUndefined();
  });
});

describe("observe --find", () => {
  const frame = {
    ok: true,
    snapshot_id: "s3-abc",
    aria: '- button "Save changes"\n- textbox "Monthly total"',
    nodes: [
      { i: 1, name: "Save changes", tag: "button", interactive: true },
      { i: 7, name: "Monthly total", tag: "input", interactive: true },
      { i: 9, name: "TOTAL SPENT", tag: "span", interactive: false },
    ],
    console_errors: [],
  };

  test("returns only matching nodes and keeps their numbers actionable", () => {
    const out = narrowToFind(frame, "total") as Record<string, any>;
    // Numbers come from the full walk, so a narrowed result can be acted on
    // directly -- that is the whole point versus filtering in shell.
    expect(out.nodes.map((n: any) => n.i)).toEqual([7, 9]);
    expect(out.nodes_matched).toBe(2);
    expect(out.nodes_total).toBe(3);
  });

  test("is case-insensitive and matches substrings", () => {
    const out = narrowToFind(frame, "SAVE") as Record<string, any>;
    expect(out.nodes.map((n: any) => n.i)).toEqual([1]);
  });

  test("drops the aria tree but says so, so a narrow view cannot read as the page", () => {
    const out = narrowToFind(frame, "total") as Record<string, any>;
    expect(out.aria).toBeUndefined();
    expect(out.aria_omitted).toContain("without --find");
    expect(out.find).toBe("total");
  });

  test("no match says what to do next instead of returning a bare empty list", () => {
    const out = narrowToFind(frame, "checkout") as Record<string, any>;
    expect(out.nodes_matched).toBe(0);
    expect(out.hint).toContain("observe without --find");
  });

  test("--find reaches the request, and an unknown flag still fails", () => {
    const { op, flags } = parseProbeArgv(["observe", "--find", "Save changes"]);
    const req = requestFromArgv(op, flags);
    expect(req).toEqual({ op: "observe", find: "Save changes" });
    const bad = requestFromArgv(...Object.values(parseProbeArgv(["observe", "--fnid", "x"])) as [any, any]);
    expect(typeof bad).toBe("string");
  });
});

describe("reachability classification (walk script shape)", () => {
  const script = observeWalkScript("button", OBSERVE_ATTR, MAX_OBSERVE_NODES);

  test("visibility is effective, not own-element", () => {
    // getComputedStyle(el).opacity is the element's OWN opacity, so a child of an
    // opacity-0 ancestor computes 1 and elementFromPoint still hits it. Checking
    // only the element made the walk report an opacity-0 group-hover delete
    // button as visible AND interactive at 390px.
    expect(script).toContain("effectivelyInvisible");
    expect(script).toContain("parentElement");
  });

  test("an unusable control is classified, not silently dropped", () => {
    for (const reason of ["occluded", "invisible", "clipped_off"]) {
      expect(script).toContain(reason);
    }
    // The occluder is named so the model knows what to move.
    expect(script).toContain("occluder");
  });

  test("a scrollable carousel is reachable, not a defect", () => {
    expect(script).toContain("needsInnerScroll");
    expect(script).toContain("scrollWidth");
  });

  test("the in-page whitespace regex survives template-literal escaping", () => {
    // A single backslash collapses inside a template literal, turning /\s+/ into
    // /s+/ and stripping every "s" from every name ("spend" -> "pend"). Assert on
    // the emitted script, which is what the page actually runs.
    expect(script).toContain("\\s+");
    expect(script).not.toMatch(/replace\(\/s\+/);
  });
});

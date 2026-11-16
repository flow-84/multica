// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decideRunEnd, handsOff, mentionsMe, type RunEnd } from "./auto-read-decision";

const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";

const meMention = `[@fl0w](mention://member/${ME})`;
const otherMention = `[@Ana](mention://member/${OTHER})`;
const agentMention = `[@Reviewer](mention://agent/${AGENT})`;
const issueLink = `[@MS-7](mention://issue/${AGENT})`;
const withDecision = `Fertig.

## Entscheidung

**Worum es geht:** Die Prüfung ist abgeschlossen.

**Zu entscheiden:** Soll der Stand live gehen?

**Empfehlung:** Ja, weil alle Tests grün sind.

**Option A (empfohlen):** Der Stand geht heute live.

**Option B:** Der Stand wartet bis morgen.`;

function run(overrides: Partial<RunEnd> = {}): RunEnd {
  return {
    issue: { status: "in_progress" },
    hasActiveTask: false,
    lastComment: "Finished the change.",
    myUserId: ME,
    failed: false,
    ...overrides,
  };
}

describe("mentionsMe", () => {
  it("matches a mention of the current user and @all", () => {
    expect(mentionsMe(`Please decide, ${meMention}.`, ME)).toBe(true);
    expect(mentionsMe("[@all](mention://all/all)", ME)).toBe(true);
  });

  it("ignores other members, agents, and issue links", () => {
    expect(mentionsMe(`${otherMention} ${agentMention} ${issueLink}`, ME)).toBe(false);
    expect(mentionsMe(meMention, null)).toBe(false);
  });
});

describe("handsOff", () => {
  it("is true for agents and other members", () => {
    expect(handsOff(agentMention, ME)).toBe(true);
    expect(handsOff(otherMention, ME)).toBe(true);
  });

  it("is false for the current user and issue links", () => {
    expect(handsOff(`${meMention} see ${issueLink}`, ME)).toBe(false);
  });
});

describe("decideRunEnd", () => {
  it("reads a done issue", () => {
    expect(decideRunEnd(run({ issue: { status: "done" } }))).toBe("done");
  });

  it("reads a custom status in the done category", () => {
    expect(decideRunEnd(run({ issue: { status: "shipped", status_category: "done" } }))).toBe("done");
  });

  it("reads a blocked issue", () => {
    expect(decideRunEnd(run({ issue: { status: "blocked" } }))).toBe("blocked");
  });

  it("stays silent when a run stops with the issue still open", () => {
    expect(decideRunEnd(run())).toBeNull();
    expect(decideRunEnd(run({ issue: { status: "in_review" } }))).toBeNull();
    expect(decideRunEnd(run({ failed: true, lastComment: null }))).toBeNull();
  });

  it("stays silent while another run continues", () => {
    expect(decideRunEnd(run({ hasActiveTask: true, issue: { status: "done" } }))).toBeNull();
  });

  it("stays silent on a handoff to another agent or member", () => {
    expect(decideRunEnd(run({ lastComment: `Over to ${agentMention}.` }))).toBeNull();
    expect(decideRunEnd(run({ lastComment: `${otherMention} please check.` }))).toBeNull();
  });

  it("still reads when the last comment only mentions the current user", () => {
    expect(decideRunEnd(run({ lastComment: `${meMention} done.`, issue: { status: "done" } }))).toBe("done");
  });

  it("stays silent on a cancelled issue", () => {
    expect(decideRunEnd(run({ issue: { status: "cancelled" } }))).toBeNull();
  });

  it("reads a closing decision on an issue still open", () => {
    expect(decideRunEnd(run({ issue: { status: "in_review" }, lastComment: withDecision }))).toBe("decision");
    expect(decideRunEnd(run({ lastComment: withDecision }))).toBe("decision");
  });

  it("stays silent on in_review without a decision", () => {
    expect(decideRunEnd(run({ issue: { status: "in_review" } }))).toBeNull();
  });

  it("keeps the status reason when the issue is done or blocked", () => {
    expect(decideRunEnd(run({ issue: { status: "done" }, lastComment: withDecision }))).toBe("done");
    expect(decideRunEnd(run({ issue: { status: "blocked" }, lastComment: withDecision }))).toBe("blocked");
  });

  it("stays silent on a decision when the issue is cancelled", () => {
    expect(decideRunEnd(run({ issue: { status: "cancelled" }, lastComment: withDecision }))).toBeNull();
  });

  it("stays silent on a decision that hands off to an agent", () => {
    expect(
      decideRunEnd(run({ issue: { status: "in_review" }, lastComment: `${agentMention} bitte prüfen.\n\n${withDecision}` })),
    ).toBeNull();
  });

  it("stays silent on a decision while another run continues", () => {
    expect(
      decideRunEnd(run({ issue: { status: "in_review" }, lastComment: withDecision, hasActiveTask: true })),
    ).toBeNull();
  });
});

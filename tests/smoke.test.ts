import { describe, expect, it } from "vitest";
import { FeedbackVerdict, HighlightSource, Role } from "@prisma/client";

describe("vitest", () => {
  it("runs a node test", () => {
    expect(1 + 1).toBe(2);
  });
});

describe("prisma schema enums", () => {
  it("exposes required user roles", () => {
    expect(Role.PATIENT).toBe("PATIENT");
    expect(Role.STAFF).toBe("STAFF");
    expect(Role.CLINICIAN).toBe("CLINICIAN");
    expect(Role.ADMIN).toBe("ADMIN");
  });

  it("exposes highlight and feedback enums", () => {
    expect(HighlightSource.MODEL).toBe("MODEL");
    expect(FeedbackVerdict.AGREE).toBe("AGREE");
  });
});

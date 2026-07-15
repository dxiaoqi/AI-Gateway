import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("control-plane deployment assets", () => {
  it("pins PostgreSQL and mounts the PostgreSQL 18 parent data directory", async () => {
    const compose = await read("compose.yaml");
    expect(compose).toContain("postgres:18.4-alpine");
    expect(compose).toContain("postgres-data:/var/lib/postgresql");
    expect(compose).not.toContain("postgres-data:/var/lib/postgresql/data");
  });

  it("documents the one-time secret and destructive integration-test boundary", async () => {
    const iteration = await read("docs/iterations/iteration-08-postgresql-control-plane.md");
    const verification = await read("docs/VERIFICATION.md");
    expect(iteration).toContain("只返回一次");
    expect(iteration).toContain("If-Match");
    expect(verification).toContain("禁止把 `POSTGRES_TEST_URL` 指向共享或生产数据库");
  });
});

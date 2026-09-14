import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const workflowPath = resolve(root, ".github/workflows/verify.yml");

describe("GitHub Actions verification workflow", () => {
  test("runs deterministic Bun tests and production build on PRs and main", async () => {
    const workflow = await Bun.file(workflowPath).text();

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain(
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    );
    expect(workflow).toContain(
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    );
    expect(workflow).toContain("bun-version: 1.3.4");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun test --isolate");
    expect(workflow).toContain("bun run build");
  });
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only run tests from source. `npm run build` emits compiled copies into
    // build/, and without this Vitest collects those too — running every test
    // twice, with the build/ copy reflecting whatever the source looked like
    // at the last build rather than now.
    include: ["src/**/*.test.ts"],
  },
});

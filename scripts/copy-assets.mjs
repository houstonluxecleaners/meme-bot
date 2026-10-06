import { cpSync } from "node:fs";
cpSync("src/dashboard/public", "dist/dashboard/public", { recursive: true });

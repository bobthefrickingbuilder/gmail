// Prints the one-line summary for a version from CHANGELOG.md (used by build-apk.sh).
import fs from "node:fs";
const v = process.argv[2];
const text = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const m = text.match(new RegExp(`## \\[?${v.replace(/\./g, "\\.")}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`));
console.log(m ? m[1].split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.replace(/^\s*-\s*/, "")).join("; ").slice(0, 400) : "See CHANGELOG.md");

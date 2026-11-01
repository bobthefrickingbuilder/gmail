/** `npm run migrate` — apply database migrations and exit. */
import { getDb, migrate } from "./index.js";
const db = await getDb();
const res = await migrate(db);
console.log(res.length ? res.map((r) => `${r.migrationName}: ${r.status}`).join("\n") : "Database up to date.");
await db.destroy();

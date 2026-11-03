/**
 * TO-DO LIST
 * Projects hold tasks; any task can be broken into steps (subtasks), and steps
 * can have steps of their own. Ticking a task ticks its unfinished steps too.
 * Quick add understands a few shortcuts in the title:
 *   today, tomorrow, monday…sunday, next week, 2026-11-20 → due date
 *   !high / !med / !low (or !3 / !2 / !1)                → priority
 *   #name                                                → project (by name)
 * Claude can suggest steps for a big task (you pick which to add); it never
 * sees your other tasks or mail.
 */
import { getDb, now, uid } from "../db/index.js";
import { getLlm } from "../providers/index.js";
import { BreakdownOutput } from "../providers/llm/schemas.js";
import { buildBreakdownPrompt } from "../drafting/prompt.js";
import { getModels, getSettings } from "../settings.js";
import { budgetExceeded, recordUsage } from "../usage/cost.js";
import { addDays, localDate, localWeekday, todayString } from "../time.js";
import { HttpError, notFound } from "../http.js";
import { emit } from "../notify/sse.js";
import type { ProjectsTable, TasksTable } from "../db/schema.js";

export const PROJECT_COLORS = ["teal", "blue", "violet", "pink", "orange", "amber", "green", "slate"] as const;

export interface TaskInput { title?: string; notes?: string; project_id?: string | null; parent_id?: string | null; due_date?: string | null;
  priority?: number; status?: "open" | "done"; position?: number; thread_id?: string | null }

const view = (t: TasksTable) => t;
const projectView = (p: ProjectsTable) => ({ ...p, archived: p.archived === 1 });

// ---------- quick add ----------
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function parseQuickAdd(text: string, today: string, todayWeekday: number, projects: { id: string; name: string }[]) {
  let title = ` ${text} `; let due: string | null = null; let priority = 0; let projectId: string | null = null;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => { const m = title.match(re); if (m) { fn(m); title = title.replace(m[0], " "); } };
  take(/\s!(high|h|3|medium|med|m|2|low|l|1)(?=\s)/i, (m) => { const v = m[1].toLowerCase(); priority = /^(high|h|3)$/.test(v) ? 3 : /^(medium|med|m|2)$/.test(v) ? 2 : 1; });
  const tag = title.match(/\s#([\p{L}\p{N}_-]+)(?=\s)/u); // an unknown project name stays in the title as typed
  const n = tag?.[1].toLowerCase() ?? "";
  const tagged = tag && (projects.find((x) => x.name.toLowerCase().replace(/\s+/g, "") === n) ?? projects.find((x) => x.name.toLowerCase().startsWith(n)));
  if (tag && tagged) { projectId = tagged.id; title = title.replace(tag[0], " "); }
  take(/\s(\d{4}-\d{2}-\d{2})(?=\s)/, (m) => { due = m[1]; });
  if (!due) take(/\s(today|tonight)(?=\s)/i, () => { due = today; });
  if (!due) take(/\s(tomorrow|tmrw)(?=\s)/i, () => { due = addDays(today, 1); });
  if (!due) take(/\snext week(?=\s)/i, () => { due = addDays(today, ((8 - todayWeekday) % 7) || 7); });
  if (!due) take(/\s(?:on\s+)?(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?(?=\s)/i, (m) => {
    const idx = DAYS.findIndex((d) => d.startsWith(m[1].toLowerCase().slice(0, 3)));
    due = addDays(today, ((idx - todayWeekday + 7) % 7) || 7);
  });
  return { title: title.replace(/\s+/g, " ").trim(), due_date: due as string | null, priority, project_id: projectId as string | null };
}

// ---------- projects ----------
export async function listAll(opts: { includeOldDone?: boolean } = {}) {
  const db = await getDb();
  const projects = await db.selectFrom("projects").selectAll().where("archived", "=", 0).orderBy("position").orderBy("created_at").execute();
  let q = db.selectFrom("tasks").selectAll();
  if (!opts.includeOldDone) {
    const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
    q = q.where((eb) => eb.or([eb("status", "=", "open"), eb("completed_at", ">=", cutoff)]));
  }
  const tasks = await q.orderBy("position").orderBy("created_at").execute();
  return { projects: projects.map(projectView), tasks: tasks.map(view), colors: PROJECT_COLORS };
}

export async function createProject(p: { name: string; color?: string; notes?: string }) {
  const db = await getDb();
  const max = await db.selectFrom("projects").select((eb) => eb.fn.max("position").as("m")).executeTakeFirst();
  const row: ProjectsTable = { id: uid(), name: p.name.trim(), color: p.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
    notes: p.notes ?? "", position: Number(max?.m ?? 0) + 1, archived: 0, created_at: now(), updated_at: now() };
  await db.insertInto("projects").values(row).execute();
  emit("tasks", {});
  return projectView(row);
}

export async function updateProject(id: string, p: { name?: string; color?: string; notes?: string; archived?: boolean; position?: number }) {
  const db = await getDb();
  const set: Partial<ProjectsTable> = { updated_at: now() };
  if (p.name !== undefined) set.name = p.name.trim();
  if (p.color !== undefined) set.color = p.color;
  if (p.notes !== undefined) set.notes = p.notes;
  if (p.position !== undefined) set.position = p.position;
  if (p.archived !== undefined) set.archived = p.archived ? 1 : 0;
  const r = await db.updateTable("projects").set(set).where("id", "=", id).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound();
  emit("tasks", {});
  return projectView(await db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
}

/** Deletes the project and every task in it. */
export async function deleteProject(id: string) {
  const db = await getDb();
  await db.deleteFrom("tasks").where("project_id", "=", id).execute();
  await db.deleteFrom("projects").where("id", "=", id).execute();
  emit("tasks", {});
}

// ---------- tasks ----------
async function descendants(id: string): Promise<string[]> {
  const db = await getDb();
  const out: string[] = []; let frontier = [id];
  while (frontier.length) {
    const kids = await db.selectFrom("tasks").select("id").where("parent_id", "in", frontier).execute();
    frontier = kids.map((k) => k.id).filter((k) => !out.includes(k));
    out.push(...frontier);
  }
  return out;
}

async function nextPosition(projectId: string | null, parentId: string | null) {
  const db = await getDb();
  let q = db.selectFrom("tasks").select((eb) => eb.fn.max("position").as("m"));
  q = parentId ? q.where("parent_id", "=", parentId) : q.where("parent_id", "is", null).where("project_id", projectId ? "=" : "is", projectId);
  return Number((await q.executeTakeFirst())?.m ?? 0) + 1;
}

export async function getTask(id: string) {
  const t = await (await getDb()).selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirst();
  if (!t) throw notFound();
  return t;
}

export async function createTask(input: TaskInput & { title: string; quick?: boolean }) {
  const db = await getDb();
  let { title } = input; let due = input.due_date ?? null; let priority = input.priority ?? 0; let projectId = input.project_id ?? null;
  if (input.quick) {
    const s = await getSettings();
    const projects = await db.selectFrom("projects").select(["id", "name"]).where("archived", "=", 0).execute();
    const q = parseQuickAdd(title, localDate(new Date(), s.timezone), localWeekday(new Date(), s.timezone), projects);
    title = q.title || title; due = due ?? q.due_date; priority = priority || q.priority; projectId = q.project_id ?? projectId;
  }
  if (!title.trim()) throw new HttpError(400, "A task needs a title");
  let parentId = input.parent_id ?? null;
  if (parentId) projectId = (await getTask(parentId)).project_id; // steps live in their parent's project
  const row: TasksTable = { id: uid(), project_id: projectId, parent_id: parentId, title: title.trim().slice(0, 500), notes: input.notes ?? "",
    status: "open", priority, due_date: due, position: await nextPosition(projectId, parentId), thread_id: input.thread_id ?? null,
    created_at: now(), updated_at: now(), completed_at: null };
  await db.insertInto("tasks").values(row).execute();
  emit("tasks", {});
  return view(row);
}

export async function updateTask(id: string, p: TaskInput) {
  const db = await getDb();
  const t = await getTask(id);
  const set: Partial<TasksTable> = { updated_at: now() };
  if (p.title !== undefined) { if (!p.title.trim()) throw new HttpError(400, "A task needs a title"); set.title = p.title.trim().slice(0, 500); }
  if (p.notes !== undefined) set.notes = p.notes;
  if (p.due_date !== undefined) set.due_date = p.due_date;
  if (p.priority !== undefined) set.priority = p.priority;
  if (p.position !== undefined) set.position = p.position;
  const subtree = await descendants(id);
  if (p.parent_id !== undefined && p.parent_id !== t.parent_id) {
    if (p.parent_id === id || (p.parent_id && subtree.includes(p.parent_id))) throw new HttpError(400, "A task can't be a step of itself");
    set.parent_id = p.parent_id;
    if (p.parent_id) set.project_id = (await getTask(p.parent_id)).project_id;
    set.position = await nextPosition(set.project_id !== undefined ? set.project_id : t.project_id, p.parent_id);
  }
  if (p.project_id !== undefined && p.parent_id === undefined && p.project_id !== t.project_id) {
    set.project_id = p.project_id; set.parent_id = null; set.position = await nextPosition(p.project_id, null);
  }
  if (p.status && p.status !== t.status) {
    set.status = p.status; set.completed_at = p.status === "done" ? now() : null;
    if (p.status === "done" && subtree.length) // finishing a task finishes its unfinished steps
      await db.updateTable("tasks").set({ status: "done", completed_at: now(), updated_at: now() }).where("id", "in", subtree).where("status", "=", "open").execute();
  }
  await db.updateTable("tasks").set(set).where("id", "=", id).execute();
  if (set.project_id !== undefined && subtree.length) // steps follow their task to its new project
    await db.updateTable("tasks").set({ project_id: set.project_id }).where("id", "in", subtree).execute();
  emit("tasks", {});
  return view(await getTask(id));
}

export async function deleteTask(id: string) {
  const db = await getDb();
  const ids = [id, ...(await descendants(id))];
  await db.deleteFrom("tasks").where("id", "in", ids).execute();
  emit("tasks", {});
  return { deleted: ids.length };
}

/** Claude suggests steps; nothing is saved until you add the ones you want. */
export async function suggestSteps(id: string) {
  if (await budgetExceeded()) throw new HttpError(402, "Monthly AI budget reached (Settings → Usage)");
  const db = await getDb();
  const t = await getTask(id);
  const project = t.project_id ? await db.selectFrom("projects").select("name").where("id", "=", t.project_id).executeTakeFirst() : undefined;
  const existing = await db.selectFrom("tasks").select("title").where("parent_id", "=", id).execute();
  const s = await getSettings(); const models = await getModels();
  const { system, user } = buildBreakdownPrompt({ title: t.title, notes: t.notes, project: project?.name ?? null, existing: existing.map((e) => e.title), today: todayString(s.timezone) });
  const key = models.default_draft_model;
  const res = await getLlm().complete({ modelKey: key, purpose: "task", system, user, schema: BreakdownOutput, schemaName: "task_breakdown", maxTokens: 1500 });
  await recordUsage({ purpose: "task", modelKey: key, modelId: res.modelId, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: res.costUsd });
  return { steps: res.data.steps.slice(0, 10).map((x) => ({ title: x.title.slice(0, 200), notes: x.notes })), model: key };
}

export async function addSteps(parentId: string, steps: { title: string; notes?: string | null }[]) {
  const out: TasksTable[] = [];
  for (const s of steps) out.push(await createTask({ title: s.title, notes: s.notes ?? "", parent_id: parentId }));
  return out;
}

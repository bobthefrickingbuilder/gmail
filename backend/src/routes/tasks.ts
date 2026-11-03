/**
 * TO-DO ROUTES
 *   GET    /api/tasks?all=1          projects + tasks (done tasks older than 30 days only with all=1)
 *   POST   /api/tasks                {title, quick?, project_id?, parent_id?, due_date?, priority?, notes?, thread_id?}
 *   PATCH  /api/tasks/:id            any field, incl. status open|done, parent_id (make it a step), project_id
 *   DELETE /api/tasks/:id            deletes the task and all its steps
 *   POST   /api/tasks/:id/suggest    Claude suggests steps (nothing saved)
 *   POST   /api/tasks/:id/steps      add steps {steps:[{title, notes}]}
 *   POST   /api/projects, PATCH /api/projects/:id, DELETE /api/projects/:id
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "../http.js";
import { addSteps, createProject, createTask, deleteProject, deleteTask, listAll, PROJECT_COLORS, suggestSteps, updateProject, updateTask } from "../tasks/service.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TaskFields = z.object({ title: z.string().max(500).optional(), notes: z.string().max(20_000).optional(), project_id: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(), due_date: Day.nullable().optional(), priority: z.number().int().min(0).max(3).optional(),
  status: z.enum(["open", "done"]).optional(), position: z.number().optional(), thread_id: z.string().nullable().optional() });

export async function taskRoutes(app: FastifyInstance) {
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.get("/api/tasks", async (req) => listAll({ includeOldDone: parse(z.object({ all: z.string().optional() }), req.query).all === "1" }));
  app.post("/api/tasks", async (req) => createTask(parse(TaskFields.extend({ title: z.string().min(1).max(500), quick: z.boolean().optional() }), req.body)));
  app.patch("/api/tasks/:id", async (req) => updateTask(id(req), parse(TaskFields, req.body)));
  app.delete("/api/tasks/:id", async (req) => deleteTask(id(req)));
  app.post("/api/tasks/:id/suggest", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => suggestSteps(id(req)));
  app.post("/api/tasks/:id/steps", async (req) => addSteps(id(req),
    parse(z.object({ steps: z.array(z.object({ title: z.string().min(1).max(500), notes: z.string().max(2000).nullable().optional() })).min(1).max(20) }), req.body).steps));

  const ProjectFields = z.object({ name: z.string().min(1).max(120).optional(), color: z.enum(PROJECT_COLORS).optional(), notes: z.string().max(20_000).optional(),
    archived: z.boolean().optional(), position: z.number().optional() });
  app.post("/api/projects", async (req) => createProject(parse(ProjectFields.extend({ name: z.string().min(1).max(120) }), req.body)));
  app.patch("/api/projects/:id", async (req) => updateProject(id(req), parse(ProjectFields, req.body)));
  app.delete("/api/projects/:id", async (req) => { await deleteProject(id(req)); return { ok: true }; });
}

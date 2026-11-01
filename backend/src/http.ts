/** Small helpers shared by the route files. */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
export const notFound = (what = "Not found") => new HttpError(404, what);
export const badRequest = (msg: string) => new HttpError(400, msg);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new HttpError(400, "Invalid request", { issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return r.data;
}

export type Req = FastifyRequest & { sessionId?: string };
export type Rep = FastifyReply;

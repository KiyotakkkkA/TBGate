import type { ZodType } from 'zod';
import { ValidationError } from '../lib/errors.js';

export interface FieldIssue {
  path: string;
  message: string;
}

export function validate<T>(schema: ZodType<T>, input: unknown, what = 'request'): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const issues: FieldIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new ValidationError(`Invalid ${what}: ${summary}`, { issues });
}

import { ApiError } from '../api/client';

/** Classify failures from the task-list request without losing body-read errors. */
export function isRetryableTaskFetchError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status < 400 || error.status >= 500;
  }
  if (error instanceof TypeError) return true;
  return error instanceof Error && error.name === 'TimeoutError';
}

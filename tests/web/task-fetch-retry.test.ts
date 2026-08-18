import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock('../../web/src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/src/api/client')>();
  return {
    ...actual,
    apiGet: mocks.apiGet,
  };
});

import { ApiError } from '../../web/src/api/client';
import { fetchTasks } from '../../web/src/api/tasks';
import { isRetryableTaskFetchError } from '../../web/src/utils/task-fetch-errors';

beforeEach(() => {
  mocks.apiGet.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isRetryableTaskFetchError', () => {
  it.each([
    ['request timeout', new DOMException('timed out', 'TimeoutError')],
    ['network failure', new TypeError('Failed to fetch')],
    ['malformed successful response', new ApiError(200, 'Invalid JSON')],
    ['server error', new ApiError(500, 'Internal Server Error')],
    ['upstream server error', new ApiError(503, 'Service Unavailable')],
  ])('retries %s', (_label, error) => {
    expect(isRetryableTaskFetchError(error)).toBe(true);
  });

  it.each([
    ['bad request', new ApiError(400, 'Bad Request')],
    ['missing task endpoint', new ApiError(404, 'Not Found')],
  ])('does not retry %s', (_label, error) => {
    expect(isRetryableTaskFetchError(error)).toBe(false);
  });
});

describe('fetchTasks response validation', () => {
  it.each([
    ['missing tasks', {}],
    ['non-array tasks', { tasks: 'bad' }],
  ])('rejects a successful response with %s as a retryable ApiError', async (_label, response) => {
    mocks.apiGet.mockResolvedValueOnce(response);

    let error: unknown;
    try {
      await fetchTasks({ minimal: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200 });
    expect(isRetryableTaskFetchError(error)).toBe(true);
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/tasks', { fields: 'list' });
  });
});

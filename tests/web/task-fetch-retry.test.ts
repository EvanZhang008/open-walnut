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
import { isRetryableFetchError } from '../../web/src/utils/fetch-retry';
import { fetchTasks } from '../../web/src/api/tasks';

beforeEach(() => {
  mocks.apiGet.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The retryable/non-retryable classification lives in fetch-retry.test.ts now
// (the classifier is shared by every registry, not task-specific).

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
    expect(isRetryableFetchError(error)).toBe(true);
    expect(mocks.apiGet).toHaveBeenCalledWith('/api/tasks', { fields: 'list' });
  });
});

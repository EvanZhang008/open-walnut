/**
 * A tiny S3-compatible server over node:http for tests: path-style
 * PutObject, GetObject, HeadObject, DeleteObject, ListObjectsV2 (with
 * pagination) and HeadBucket. It does not check signatures; it does refuse an
 * unknown bucket, and it can fail the next N requests to exercise retries.
 *
 * Runnable alone for manual checks: `bun tests/helpers/fake-s3-server.ts --serve --port 9000`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeS3 {
  url: string;
  objects: Map<string, { body: Buffer; modifiedAt: Date }>;
  requests: string[];
  failNext(n: number, status?: number): void;
  close(): Promise<void>;
}

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function startFakeS3(opts: { buckets?: string[]; port?: number; pageSize?: number } = {}): Promise<FakeS3> {
  const buckets = new Set(opts.buckets ?? ['test-bucket']);
  const objects = new Map<string, { body: Buffer; modifiedAt: Date }>();
  const requests: string[] = [];
  let failures = 0;
  let failStatus = 500;
  const pageSize = opts.pageSize ?? 1000;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
      const key = rest.join('/');
      requests.push(`${req.method} /${bucket}/${key}${url.search}`);
      if (failures > 0) {
        failures--;
        res.writeHead(failStatus, { 'content-type': 'application/xml' });
        return void res.end('<Error><Code>InternalError</Code><Message>injected</Message></Error>');
      }
      if (!buckets.has(bucket)) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        return void res.end('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>');
      }
      const id = `${bucket}/${key}`;
      if (req.method === 'PUT' && key) {
        objects.set(id, { body: Buffer.concat(chunks), modifiedAt: new Date() });
        res.writeHead(200, { etag: '"fake"' });
        return void res.end();
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && key) {
        const obj = objects.get(id);
        if (!obj) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          return void res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
        }
        res.writeHead(200, { 'content-length': obj.body.length, 'content-type': 'application/octet-stream', 'last-modified': obj.modifiedAt.toUTCString() });
        return void res.end(req.method === 'HEAD' ? undefined : obj.body);
      }
      if (req.method === 'DELETE' && key) {
        objects.delete(id);
        res.writeHead(204);
        return void res.end();
      }
      if (req.method === 'HEAD') {
        res.writeHead(200);
        return void res.end();
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const after = url.searchParams.get('continuation-token') ?? '';
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/`))
          .map((k) => k.slice(bucket.length + 1))
          .filter((k) => k.startsWith(prefix) && k > after)
          .sort();
        const page = keys.slice(0, pageSize);
        const truncated = keys.length > page.length;
        const contents = page.map((k) => {
          const o = objects.get(`${bucket}/${k}`)!;
          return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.modifiedAt.toISOString()}</LastModified><Size>${o.body.length}</Size></Contents>`;
        }).join('');
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
          `<KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : '') +
          `${contents}</ListBucketResult>`,
        );
      }
      res.writeHead(400);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    failNext(n: number, status = 500) {
      failures = n;
      failStatus = status;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv.includes('--serve')) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 0;
  void startFakeS3({ port, buckets: ['walnut-backup-test'] }).then((s) => console.log(JSON.stringify({ url: s.url })));
}

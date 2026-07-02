import { Hono } from 'hono';
import { cors } from "hono/cors"
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '../..');
// public/js lives at packages/web/public/js relative to this file's package root
const PUBLIC_JS = join(__dirname, '../../public/js');

const app = new Hono()
  .basePath('api')
  .use(cors({ origin: (origin) => origin ?? "*", credentials: true, exposeHeaders: ["set-auth-token"] }))
  .get('/ping', (c) => c.json({ message: `Pong! ${Date.now()}` }, 200))
  .get('/health', (c) => c.json({ status: 'ok' }, 200))
  .get('/readjs/:file', async (c) => {
    const file = c.req.param('file');
    if (!file || file.includes('..')) return c.json({ error: 'bad file' }, 400);
    try {
      const content = await readFile(join(PUBLIC_JS, file), 'utf-8');
      return c.text(content);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  })
  .post('/writejs', async (c) => {
    const { file, content } = await c.req.json<{ file: string; content: string }>();
    if (!file || file.includes('..')) return c.json({ error: 'bad file' }, 400);
    await writeFile(join(PUBLIC_JS, file), content, 'utf-8');
    return c.json({ ok: true });
  });

export type AppType = typeof app;
export default app;

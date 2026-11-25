// Evaluate the production handlers with an isolated localhost MongoDB. The
// server entry point, production connection, providers and mail are never run.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import * as pricing from '../bookingPricing.js';
import * as giftCardCheckout from '../giftCardCheckout.js';
import { createGiftCardProviders } from '../giftCardProviders.js';

export async function createHarness(seed = {}) {
  const uri = process.env.MONGODB_TEST_URI;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri || '')) {
    throw new Error('Route tests require an isolated localhost MONGODB_TEST_URI');
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(`mint_pricing_test_${randomUUID().replaceAll('-', '')}`);
  for (const [collection, docs] of Object.entries(seed)) {
    if (docs.length) await db.collection(collection).insertMany(structuredClone(docs));
  }
  const mail = [];
  const provider = [];
  const intervals = [];
  const errors = [];
  const context = {
    ...pricing, ...giftCardCheckout, createGiftCardProviders, express, ObjectId, db, client,
    rateLimit: () => (_req, _res, next) => next(), bcrypt: {}, jwt: {},
    wss: { clients: new Set() }, WebSocket: { OPEN: 1 },
    fs: { readFileSync: () => '' }, https: { Agent: class {} },
    fileURLToPath: () => path.resolve('routes/routes.js'), dirname: path.dirname, join: path.join,
    axios: { create: () => ({ patch: async (...args) => { provider.push(args); return { status: 200 }; } }) },
    nodemailer: { createTransport: () => ({ sendMail: async message => { mail.push(message); } }) },
    randomUUID,
    getCachedBookings: () => null, setCachedBookings: () => {}, clearBookingsCache: () => {},
    console: { log: () => {}, warn: () => {}, error: (...args) => errors.push(args) },
    process: { env: {} },
    fetch: async (...args) => { provider.push(args); return { ok: true, status: 200, json: async () => ({ chargeId: 'test-charge' }) }; },
    setInterval: fn => { intervals.push(fn); }, setImmediate: () => {},
    URL, Date, Intl, Buffer
  };
  let source = await readFile(new URL('../routes/routes.js', import.meta.url), 'utf8');
  source = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replace('import.meta.url', "'file:///test/routes.js'")
    .replace('export default router;', 'globalThis.testRouter = router;');
  vm.runInNewContext(source, context, { filename: 'routes/routes.js' });
  return {
    db, mail, provider, intervals, errors, context,
    async request(method, url, { body = {}, params = {}, query = {}, headers = {} } = {}) {
      const layer = context.testRouter.stack.find(layer => layer.route?.path === url && layer.route.methods[method]);
      if (!layer) throw new Error(`No handler for ${method} ${url}`);
      const res = {
        statusCode: 200, body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        send(body) { this.body = body; return this; },
        sendStatus(code) { this.statusCode = code; return this; }
      };
      await layer.route.stack.at(-1).handle({ body, params, query, headers }, res);
      return res;
    },
    async close() { await db.dropDatabase(); await client.close(); }
  };
}

import { createApp, jobs, lakebase, server } from '@databricks/appkit';
import { setupLakeLoadRoutes } from './routes/lakeload/routes';

const disabledCacheStorage = {
  get() {
    return Promise.resolve(null);
  },
  set() {
    return Promise.resolve();
  },
  delete() {
    return Promise.resolve();
  },
  clear() {
    return Promise.resolve();
  },
  has() {
    return Promise.resolve(false);
  },
  size() {
    return Promise.resolve(0);
  },
  isPersistent() {
    return false;
  },
  healthCheck() {
    return Promise.resolve(true);
  },
  close() {
    return Promise.resolve();
  },
};

createApp({
  cache: { enabled: false, storage: disabledCacheStorage },
  plugins: [lakebase({ pool: { max: 10, connectionTimeoutMillis: 10_000 } }), jobs(), server()],
  async onPluginsReady(appkit) {
    await setupLakeLoadRoutes(appkit);
  },
}).catch(console.error);

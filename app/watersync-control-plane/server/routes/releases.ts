import type { Application } from 'express';
import { latestRelease } from '../releases.js';
import { apiRoute } from '../logging.js';

/** Registers the route the header uses to tell whether a newer WaterSync release exists. */
export function registerReleaseRoutes(app: Application) {
  app.get(
    '/api/latest-release',
    apiRoute('latest_release', async (_req, res) => {
      res.json({ release: await latestRelease() });
    })
  );
}
